#!/usr/bin/env node
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const execAsync = promisify(exec);
const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

const root = path.resolve(args.root || process.cwd());
const serverName = args.name || 'shell_tasks';
const defaultTimeout = clampNumber(args.timeout || args['timeout-ms'], 1000, 5 * 60 * 1000, 60 * 1000);
const maxBuffer = clampNumber(args['max-buffer'], 1024 * 16, 8 * 1024 * 1024, 2 * 1024 * 1024);
const defaultShell = args.shell || process.env.SHELL || '/bin/bash';

ensureDir(root);

const server = new McpServer({
  name: serverName,
  version: '0.1.0',
});

server.registerTool(
  'run_shell_command',
  {
    title: '执行 Shell 命令',
    description: '在受限工作目录中执行命令，返回 stdout/stderr。',
    inputSchema: z.object({
      command: z.string().min(1).describe('要执行的完整命令字符串'),
      cwd: z.string().optional().describe('相对 root 的工作目录，默认 root'),
      timeout_ms: z.number().int().min(1000).max(10 * 60 * 1000).optional().describe('自定义超时 (ms)'),
      shell: z.string().optional().describe('备用 shell，可覆盖默认值'),
      env: z.record(z.string()).optional().describe('额外的环境变量键值对'),
    }),
  },
  async ({ command, cwd = '.', timeout_ms: timeout, shell, env }) => {
    const workingDir = await ensurePath(cwd);
    const effectiveTimeout = clampNumber(timeout, 1000, 10 * 60 * 1000, defaultTimeout);
    const usedShell = shell || defaultShell;
    const options = {
      cwd: workingDir,
      timeout: effectiveTimeout,
      maxBuffer,
      shell: usedShell,
      env: {
        ...process.env,
        ...normalizeEnv(env),
      },
    };
    try {
      const { stdout, stderr } = await execAsync(command, options);
      return textResponse(formatCommandResult({ command, cwd: workingDir, stdout, stderr, exitCode: 0 }));
    } catch (err) {
      if (err && typeof err === 'object' && 'stdout' in err) {
        return textResponse(
          formatCommandResult({
            command,
            cwd: workingDir,
            stdout: err.stdout || '',
            stderr: err.stderr || String(err.message || ''),
            exitCode: typeof err.code === 'number' ? err.code : null,
            signal: err.signal,
            timedOut: Boolean(err.killed && err.signal === 'SIGTERM'),
          })
        );
      }
      throw err;
    }
  }
);

server.registerTool(
  'list_workspace_files',
  {
    title: '列出工作区文件',
    description: '快速查看 root 下的第一层文件/目录。',
    inputSchema: z.object({
      path: z.string().optional().describe('起始目录，相对 root'),
    }),
  },
  async ({ path: listPath = '.' }) => {
    const target = await ensurePath(listPath);
    const stats = await safeStat(target);
    if (!stats || !stats.isDirectory()) {
      throw new Error('目标不是目录。');
    }
    const entries = await fs.promises.readdir(target);
    const lines = entries.slice(0, 100).map((name) => `- ${name}`);
    return textResponse(lines.join('\n') || '<空目录>');
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${serverName}] MCP shell server ready (root=${root}).`);
}

main().catch((err) => {
  console.error('Shell server crashed:', err);
  process.exit(1);
});

async function ensurePath(relPath = '.') {
  const target = path.resolve(root, relPath);
  if (!target.startsWith(root + path.sep) && target !== root) {
    throw new Error(`路径 ${relPath} 超出允许范围。`);
  }
  return target;
}

function ensureDir(dirPath) {
  const stats = fs.existsSync(dirPath) ? fs.statSync(dirPath) : null;
  if (!stats) {
    fs.mkdirSync(dirPath, { recursive: true });
    return;
  }
  if (!stats.isDirectory()) {
    throw new Error(`${dirPath} 不是有效目录`);
  }
}

async function safeStat(target) {
  try {
    return await fs.promises.stat(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function normalizeEnv(input) {
  if (!input || typeof input !== 'object') {
    return {};
  }
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      output[key] = value;
    }
  }
  return output;
}

function formatCommandResult({ command, cwd, stdout, stderr, exitCode, signal, timedOut }) {
  const header = [`$ ${command}`, `cwd: ${cwd}`];
  if (exitCode !== null && exitCode !== undefined) {
    header.push(`exit code: ${exitCode}`);
  }
  if (signal) {
    header.push(`signal: ${signal}`);
  }
  if (timedOut) {
    header.push('timed out');
  }
  const divider = '-'.repeat(40);
  const stdoutBlock = stdout ? `STDOUT:\n${stdout}` : 'STDOUT: <empty>';
  const stderrBlock = stderr ? `STDERR:\n${stderr}` : 'STDERR: <empty>';
  return `${header.join(' | ')}\n${divider}\n${stdoutBlock}\n\n${stderrBlock}`;
}

function textResponse(text) {
  return {
    content: [
      {
        type: 'text',
        text: text || '',
      },
    ],
  };
}

function parseArgs(input) {
  const result = { _: [] };
  for (let i = 0; i < input.length; i += 1) {
    const token = input[i];
    if (!token.startsWith('-')) {
      result._.push(token);
      continue;
    }
    const isLong = token.startsWith('--');
    const key = isLong ? token.slice(2) : token.slice(1);
    if (!key) continue;
    const [name, inline] = key.split('=');
    if (inline !== undefined) {
      result[name] = inline;
      continue;
    }
    const next = input[i + 1];
    if (next && !next.startsWith('-')) {
      result[name] = next;
      i += 1;
    } else {
      result[name] = true;
    }
  }
  return result;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return Math.min(Math.max(parsed, min), max);
  }
  return fallback;
}

function printHelp() {
  console.log(`Usage: node shell-server.js [--root <path>] [--timeout <ms>] [--max-buffer <bytes>]\n\nOptions:\n  --root <path>       工作目录 root，所有命令均限制在此目录\n  --timeout <ms>      默认命令超时 (1000-300000 ms，默认 60000)\n  --max-buffer <b>    STDOUT/STDERR 最大缓冲区 (最小 16KB，默认 2MB)\n  --shell <path>      可选 shell，可覆盖系统默认\n  --name <id>         MCP server 名称\n  --help              显示帮助`);
}
