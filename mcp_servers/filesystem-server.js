#!/usr/bin/env node
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

const root = path.resolve(args.root || process.cwd());
const allowWrites = booleanFromArg(args.write) || /write/i.test(String(args.mode || ''));
const serverName = args.name || (allowWrites ? 'code_writer' : 'project_files');
const maxFileBytes = clampNumber(args['max-bytes'], 1024, 1024 * 1024, 256 * 1024);
const searchLimit = clampNumber(args['max-search-results'], 1, 200, 40);

ensureDir(root, allowWrites);

const server = new McpServer({
  name: `${serverName}`,
  version: '0.1.0',
});

registerFilesystemTools();

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${serverName}] MCP filesystem server ready (root=${root}).`);
}

main().catch((err) => {
  console.error('Filesystem server crashed:', err);
  process.exit(1);
});

function registerFilesystemTools() {
  server.registerTool(
    'list_directory',
    {
      title: '列出目录内容',
      description: '列出 root 内指定路径下的文件（最多 200 条），支持控制遍历深度。',
      inputSchema: z.object({
        path: z.string().optional().describe('相对 root 的目录路径，默认 "."'),
        depth: z.number().int().min(1).max(5).optional().describe('递归深度 (1-5)。'),
        includeHidden: z.boolean().optional().describe('是否包含点开头的隐藏文件。'),
      }),
    },
    async ({ path: dirPath = '.', depth = 1, includeHidden = false }) => {
      const target = await ensurePath(dirPath);
      const stats = await safeStat(target);
      if (!stats || !stats.isDirectory()) {
        throw new Error('目标不是目录或不存在。');
      }
      const entries = await collectDirectoryEntries(target, {
        depth,
        includeHidden,
        maxEntries: 200,
      });
      const lines = entries.map((entry) => {
        const rel = relativePath(entry.fullPath);
        const indicator = entry.isDir ? '📁' : '📄';
        const size = entry.isDir ? '-' : formatBytes(entry.size);
        return `${indicator} ${rel} (${size})`;
      });
      const body = lines.length > 0 ? lines.join('\n') : '<空目录>';
      return textResponse(body);
    }
  );

  server.registerTool(
    'read_file',
    {
      title: '读取文件',
      description: '返回文件内容（UTF-8，大小限制可通过 --max-bytes 控制）。',
      inputSchema: z.object({
        path: z.string().describe('相对 root 的文件路径'),
      }),
    },
    async ({ path: filePath }) => {
      const target = await ensurePath(filePath);
      const stats = await safeStat(target);
      if (!stats || !stats.isFile()) {
        throw new Error('目标文件不存在或不是常规文件。');
      }
      if (stats.size > maxFileBytes) {
        throw new Error(`文件过大（${formatBytes(stats.size)}），超过 ${formatBytes(maxFileBytes)} 限制。`);
      }
      const content = await fsp.readFile(target, { encoding: 'utf8' });
      const header = `# ${relativePath(target)} (size: ${formatBytes(stats.size)})`;
      return textResponse(`${header}\n\n${content}`);
    }
  );

  server.registerTool(
    'search_text',
    {
      title: '全文搜索',
      description: '在指定目录下的文本文件中搜索关键字，返回命中位置。',
      inputSchema: z.object({
        query: z.string().min(1).describe('搜索关键字（区分大小写）。'),
        path: z.string().optional().describe('起始目录（相对 root），默认当前目录'),
        max_results: z.number().int().min(1).max(searchLimit).optional().describe('最多返回的命中条数'),
      }),
    },
    async ({ query, path: startPath = '.', max_results: maxResults }) => {
      const limit = Math.min(maxResults || searchLimit, searchLimit);
      const start = await ensurePath(startPath);
      const stats = await safeStat(start);
      if (!stats) {
        throw new Error('搜索起点不存在。');
      }
      const matches = await searchInTree(start, query, {
        maxResults: limit,
        maxFiles: 120,
      });
      if (matches.length === 0) {
        return textResponse('未找到匹配内容。');
      }
      const body = matches
        .map((match) => `${match.file}:${match.line} ${match.preview}`)
        .join('\n');
      return textResponse(body);
    }
  );

  if (allowWrites) {
    server.registerTool(
      'delete_path',
      {
        title: '删除文件或目录',
        description: '删除目标文件或目录（递归）。',
        inputSchema: z.object({
          path: z.string().describe('相对 root 的路径'),
        }),
      },
      async ({ path: targetPath }) => {
        const target = await ensurePath(targetPath);
        await fsp.rm(target, { recursive: true, force: true });
        return textResponse(`已删除 ${relativePath(target)}。`);
      }
    );

    server.registerTool(
      'apply_patch',
      {
        title: '应用补丁',
        description:
          '在指定目录执行 patch -p0，支持 plain/base64 内容。适合 CLAUDE/Codex 风格的 diff 修改。',
        inputSchema: z.object({
          path: z.string().optional().describe('相对 root 的工作目录，默认 root'),
          patch: z.string().optional().describe('普通文本格式补丁'),
          patch_base64: z.string().optional().describe('Base64 编码补丁'),
          chunks: z
            .array(
              z.object({
                content: z.string(),
                encoding: z.enum(['plain', 'base64']).optional(),
              })
            )
            .optional(),
          encoding: z.enum(['plain', 'base64']).optional().describe('默认 plain'),
        }),
      },
      async (args) => {
        const workDir = await ensurePath(args.path || '.');
        const relWorkDir = relativePath(workDir);
        const patchText = await resolvePatchPayload(args);
        if (!patchText || !patchText.trim()) {
          throw new Error('补丁内容为空，无法执行。');
        }
        const normalizedPatch = rewritePatchWorkingDir(patchText, relWorkDir);
        await applyPatch(workDir, normalizedPatch);
        return textResponse(`已在 ${relativePath(workDir)} 应用补丁。`);
      }
    );
  }
}

async function ensurePath(relPath = '.') {
  const target = path.resolve(root, relPath);
  if (!target.startsWith(root + path.sep) && target !== root) {
    throw new Error(`路径 ${relPath} 超出允许范围。`);
  }
  return target;
}

function relativePath(target) {
  const rel = path.relative(root, target) || '.';
  return rel.replace(/\\/g, '/');
}

async function safeStat(target) {
  try {
    return await fsp.stat(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

async function collectDirectoryEntries(startDir, options = {}) {
  const depth = clampNumber(options.depth, 1, 5, 1);
  const includeHidden = Boolean(options.includeHidden);
  const maxEntries = options.maxEntries || 200;
  const queue = [{ dir: startDir, level: 0 }];
  const results = [];
  while (queue.length > 0 && results.length < maxEntries) {
    const current = queue.shift();
    let children;
    try {
      children = await fsp.readdir(current.dir, { withFileTypes: true });
    } catch (err) {
      results.push({
        fullPath: current.dir,
        isDir: true,
        size: 0,
      });
      continue;
    }
    for (const entry of children) {
      if (!includeHidden && entry.name.startsWith('.')) {
        continue;
      }
      const fullPath = path.join(current.dir, entry.name);
      const stats = await safeStat(fullPath);
      results.push({
        fullPath,
        isDir: Boolean(stats?.isDirectory()),
        size: stats?.size || 0,
      });
      if (results.length >= maxEntries) {
        break;
      }
      if (entry.isDirectory() && current.level + 1 < depth) {
        queue.push({ dir: fullPath, level: current.level + 1 });
      }
    }
  }
  return results;
}

async function searchInTree(startDir, needle, options = {}) {
  const maxResults = clampNumber(options.maxResults, 1, 200, 20);
  const maxFiles = clampNumber(options.maxFiles, 1, 500, 120);
  const matches = [];
  const queue = [startDir];
  let filesScanned = 0;
  while (queue.length > 0 && matches.length < maxResults && filesScanned < maxFiles) {
    const current = queue.shift();
    const stats = await safeStat(current);
    if (!stats) {
      continue;
    }
    if (stats.isDirectory()) {
      let children = [];
      try {
        children = await fsp.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of children) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        queue.push(path.join(current, entry.name));
      }
    } else if (stats.isFile()) {
      filesScanned += 1;
      if (stats.size > maxFileBytes) {
        continue;
      }
      const content = await fsp.readFile(current, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(needle)) {
          matches.push({
            file: relativePath(current),
            line: i + 1,
            preview: lines[i].trim().slice(0, 200),
          });
          if (matches.length >= maxResults) {
            break;
          }
        }
      }
    }
  }
  return matches;
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
    if (!key) {
      continue;
    }
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

function booleanFromArg(value) {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return Math.min(Math.max(parsed, min), max);
  }
  return fallback;
}

function ensureDir(targetDir, writable) {
  try {
    const stats = fs.statSync(targetDir);
    if (!stats.isDirectory()) {
      throw new Error(`${targetDir} 不是目录`);
    }
    if (writable) {
      fs.accessSync(targetDir, fs.constants.W_OK);
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      fs.mkdirSync(targetDir, { recursive: true });
      return;
    }
    throw err;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return 'n/a';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]} (${bytes} B)`;
}

function printHelp() {
  console.log(
    `Usage: node filesystem-server.js [--root <path>] [--write] [--name <id>] [--max-bytes <n>]\n\nOptions:\n  --root <path>            MCP root 路径，默认当前目录\n  --write                  启用写权限，注册写/删工具\n  --mode <read|write>      兼容 flag，设置为 write 与 --write 等价\n  --name <id>              MCP server 名称，用于日志\n  --max-bytes <n>          单个文件最大读取字节数 (默认 256KB)\n  --max-search-results <n> 搜索命中数上限 (默认 40)\n  --help                   显示帮助`
  );
}

async function resolveWritePayload(args) {
  let encoding = args.encoding || 'plain';
  if (typeof args.contents_base64 === 'string' && args.contents_base64.length > 0) {
    encoding = 'base64';
    return decodePayload(args.contents_base64, 'base64');
  }
  if (Array.isArray(args.chunks) && args.chunks.length > 0) {
    const pieces = args.chunks.map((chunk) => {
      const chunkEncoding = chunk.encoding || encoding;
      return decodePayload(chunk.content, chunkEncoding);
    });
    return pieces.join('');
  }
  if (typeof args.contents === 'string') {
    return decodePayload(args.contents, encoding);
  }
  return '';
}

function decodePayload(value, encoding) {
  if (!value) return '';
  if (encoding === 'base64') {
    return Buffer.from(value, 'base64').toString('utf8');
  }
  return value;
}

async function resolvePatchPayload(args) {
  let encoding = args.encoding || 'plain';
  if (typeof args.patch_base64 === 'string' && args.patch_base64.length > 0) {
    encoding = 'base64';
    return decodePayload(args.patch_base64, 'base64');
  }
  if (Array.isArray(args.chunks) && args.chunks.length > 0) {
    const segments = args.chunks.map((chunk) => {
      const chunkEncoding = chunk.encoding || encoding;
      return decodePayload(chunk.content, chunkEncoding);
    });
    return segments.join('');
  }
  if (typeof args.patch === 'string') {
    return decodePayload(args.patch, encoding);
  }
  return '';
}

async function applyPatch(workDir, patchText) {
  try {
    await runPatchCommand(workDir, patchText);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error('系统未找到 patch 命令。请先安装 patch (例如 brew install patch)。');
    }
    throw new Error(`patch 命令执行失败: ${err.stderr || err.message}`);
  }
}

async function runPatchCommand(workDir, patchText) {
  return new Promise((resolve, reject) => {
    const child = spawn('patch', ['-p0'], {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      reject({ ...err, stderr });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject({ code, stderr: stderr || `patch exited with code ${code}` });
      }
    });
    child.stdin.write(patchText);
    child.stdin.end();
  });
}

function rewritePatchWorkingDir(patchText, relWorkDir) {
  if (!patchText) {
    return patchText;
  }
  const normalizedDir = String(relWorkDir || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/?/, '')
    .replace(/\/+$/, '');
  if (!normalizedDir) {
    return patchText;
  }
  const prefixWithSlash = `${normalizedDir}/`;
  const headerRegex = /^(---|\+\+\+)\s+([^\n]+)/gm;
  return patchText.replace(headerRegex, (full, marker, pathPartRaw) => {
    const [pathPart, ...meta] = pathPartRaw.split(/\t+/);
    const suffix = meta.length > 0 ? `\t${meta.join('\t')}` : '';
    if (!pathPart) return full;
    let candidate = pathPart.trim();
    let prefix = '';
    if (candidate.startsWith('a/')) {
      prefix = 'a/';
      candidate = candidate.slice(2);
    } else if (candidate.startsWith('b/')) {
      prefix = 'b/';
      candidate = candidate.slice(2);
    }
    const normalizedCandidate = candidate.replace(/\\/g, '/');
    if (normalizedCandidate.startsWith(prefixWithSlash)) {
      const trimmed = normalizedCandidate.slice(prefixWithSlash.length);
      if (trimmed.length > 0) {
        return `${marker} ${prefix}${trimmed}${suffix}`;
      }
    }
    return full;
  });
}
