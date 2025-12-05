import path from 'path';
import * as colors from '../colors.js';
import { loadMcpConfig } from '../mcp.js';
import { registerTool } from '../tools/index.js';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function initializeMcpRuntime(configPath, sessionRoot = process.cwd()) {
  let servers;
  try {
    ({ servers } = loadMcpConfig(configPath));
  } catch (err) {
    console.error(colors.yellow(`[MCP] 读取 mcp.config.json 失败：${err.message}`));
    return null;
  }
  if (!servers || servers.length === 0) {
    return null;
  }
  const baseDir = configPath ? path.dirname(configPath) : process.cwd();
  const handles = [];
  for (const entry of servers) {
    if (!entry || !entry.url) {
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const handle = await connectMcpServer(entry, baseDir, sessionRoot);
      if (handle) {
        handles.push(handle);
      }
    } catch (err) {
      console.error(
        colors.yellow(
          `[MCP] 无法连接到 ${entry.name || '<unnamed>'}: ${err.message || err}`
        )
      );
    }
  }
  if (handles.length === 0) {
    return null;
  }
  const toolNames = handles.flatMap((handle) =>
    handle.registeredTools.map((tool) => tool.identifier)
  );
  return {
    toolNames,
    applyToConfig: (appConfig) => {
      if (!appConfig || !appConfig.models || toolNames.length === 0) {
        return;
      }
      Object.values(appConfig.models).forEach((settings) => {
        if (!settings) return;
        const current = Array.isArray(settings.tools) ? settings.tools.slice() : [];
        let changed = false;
        for (const toolName of toolNames) {
          if (!current.includes(toolName)) {
            current.push(toolName);
            changed = true;
          }
        }
        if (changed) {
          settings.tools = current;
        }
      });
    },
    async shutdown() {
      await Promise.all(
        handles.map(async (handle) => {
          try {
            await handle.transport.close();
          } catch {
            // ignore
          }
        })
      );
    },
  };
}

async function connectMcpServer(entry, baseDir, sessionRoot) {
  const command = parseCommandUrl(entry.url);
  if (!command) {
    throw new Error('仅支持 cmd:// 类型的 MCP 端点');
  }
  const client = new Client({
    name: 'model-cli',
    version: '0.1.0',
  });
  const env = {};
  if (entry.api_key_env) {
    const key = entry.api_key_env.trim();
    if (key && process.env[key]) {
      env[key] = process.env[key];
    }
  }
  const adjustedArgs = adjustCommandArgs(command.args, sessionRoot);
  const transport = new StdioClientTransport({
    command: command.command,
    args: adjustedArgs,
    cwd: baseDir,
    env,
    stderr: 'pipe',
  });
  const stderrStream = transport.stderr;
  if (stderrStream && stderrStream.on) {
    stderrStream.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.trim().length > 0) {
        process.stdout.write(colors.dim(`[MCP:${entry.name || 'server'}] ${text}`));
      }
    });
  }
  transport.onclose = () => {
    console.error(colors.yellow(`[MCP] 连接 ${entry.name || '<unnamed>'} 已关闭`));
  };
  await client.connect(transport);
  const toolsFromServer = await fetchAllTools(client);
  if (toolsFromServer.length === 0) {
    console.error(colors.yellow(`[MCP] ${entry.name || '<unnamed>'} 未公开任何工具。`));
  }
  const registeredTools = toolsFromServer.map((tool) =>
    registerRemoteTool(client, entry.name || 'server', tool)
  );
  return { entry, client, transport, registeredTools };
}

async function fetchAllTools(client) {
  const collected = [];
  let cursor = null;
  do {
    // eslint-disable-next-line no-await-in-loop
    const result = await client.listTools(cursor ? { cursor } : undefined);
    if (Array.isArray(result?.tools)) {
      collected.push(...result.tools);
    }
    cursor = result?.nextCursor || null;
  } while (cursor);
  client.cacheToolMetadata(collected);
  return collected;
}

function registerRemoteTool(client, serverName, tool) {
  const identifier = buildToolIdentifier(serverName, tool.name);
  const description = buildToolDescription(serverName, tool);
  const parameters =
    tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} };
  registerTool({
    name: identifier,
    description,
    parameters,
    handler: async (args = {}) => {
      const response = await client.callTool({
        name: tool.name,
        arguments: args,
      });
      return formatCallResult(serverName, tool.name, response);
    },
  });
  return { identifier, remoteName: tool.name };
}

function buildToolIdentifier(serverName, toolName) {
  const normalize = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_');
  const server = normalize(serverName) || 'mcp_server';
  const tool = normalize(toolName) || 'tool';
  return `mcp_${server}_${tool}`;
}

function buildToolDescription(serverName, tool) {
  const parts = [];
  if (serverName) {
    parts.push(`[${serverName}]`);
  }
  if (tool.annotations?.title) {
    parts.push(tool.annotations.title);
  } else if (tool.description) {
    parts.push(tool.description);
  } else {
    parts.push('MCP 工具');
  }
  return parts.join(' ');
}

function formatCallResult(serverName, toolName, result) {
  if (!result) {
    return `[${serverName}/${toolName}] 工具未返回结果。`;
  }
  const header = `[${serverName}/${toolName}]`;
  if (result.isError) {
    const errorText = extractContentText(result.content) || 'MCP 工具执行失败。';
    return `${header} ❌ ${errorText}`;
  }
  const segments = [];
  const textBlock = extractContentText(result.content);
  if (textBlock) {
    segments.push(textBlock);
  }
  if (result.structuredContent && Object.keys(result.structuredContent).length > 0) {
    segments.push(JSON.stringify(result.structuredContent, null, 2));
  }
  if (segments.length === 0) {
    segments.push('工具执行成功，但没有可展示的文本输出。');
  }
  return `${header}\n${segments.join('\n\n')}`;
}

function extractContentText(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return '';
  }
  const lines = [];
  blocks.forEach((block) => {
    if (!block || typeof block !== 'object') {
      return;
    }
    switch (block.type) {
      case 'text':
        if (block.text) {
          lines.push(block.text);
        }
        break;
      case 'resource_link':
        lines.push(`资源链接: ${block.uri || block.resourceId || '(未知 URI)'}`);
        break;
      case 'image':
        lines.push(`图像（${block.mimeType || 'image'}，${approxSize(block.data)}）`);
        break;
      case 'audio':
        lines.push(`音频（${block.mimeType || 'audio'}，${approxSize(block.data)}）`);
        break;
      case 'resource':
        lines.push('内嵌资源返回，内容较大，建议用 /mcp 获取详细信息。');
        break;
      default:
        lines.push(`[${block.type}]`);
        break;
    }
  });
  return lines.join('\n');
}

function approxSize(base64Text) {
  if (!base64Text) return '未知大小';
  const bytes = Math.round((base64Text.length * 3) / 4);
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function parseCommandUrl(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith('cmd://')) {
    return null;
  }
  const commandLine = trimmed.slice('cmd://'.length).trim();
  if (!commandLine) {
    throw new Error('cmd:// URL 中缺少可执行命令');
  }
  const tokens = shellSplit(commandLine);
  if (tokens.length === 0) {
    throw new Error('cmd:// URL 无法解析命令');
  }
  return { command: tokens[0], args: tokens.slice(1) };
}

function adjustCommandArgs(args = [], sessionRoot) {
  if (!Array.isArray(args) || args.length === 0) {
    return args || [];
  }
  const resolved = [...args];
  for (let i = 0; i < resolved.length; i += 1) {
    const token = resolved[i];
    if (token === '--root' && i + 1 < resolved.length) {
      resolved[i + 1] = resolveRootPath(resolved[i + 1], sessionRoot);
      i += 1;
      continue;
    }
    const match = typeof token === 'string' ? token.match(/^--root=(.+)$/) : null;
    if (match) {
      resolved[i] = `--root=${resolveRootPath(match[1], sessionRoot)}`;
    }
  }
  return resolved;
}

function resolveRootPath(value, sessionRoot) {
  const base = sessionRoot || process.cwd();
  if (!value || value === '.') {
    return base;
  }
  if (value === '~') {
    const home = process.env.HOME || process.env.USERPROFILE || base;
    return home;
  }
  const trimmed = value.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.resolve(base, trimmed);
}

function shellSplit(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && i + 1 < input.length) {
        i += 1;
        current += input[i];
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if (char === '\\' && i + 1 < input.length) {
      i += 1;
      current += input[i];
      continue;
    }
    current += char;
  }
  if (quote) {
    throw new Error('命令行参数缺少闭合的引号');
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

export { initializeMcpRuntime };
