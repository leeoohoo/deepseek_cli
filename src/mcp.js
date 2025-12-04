const fs = require('fs');
const path = require('path');

const CLI_ROOT = path.resolve(__dirname, '..');

function resolveMcpPath(configPath) {
  const baseDir = configPath ? path.dirname(configPath) : process.cwd();
  return path.join(baseDir, 'mcp.config.json');
}

function loadMcpConfig(configPath) {
  const target = resolveMcpPath(configPath);
  const defaultsFactory = () => getDefaultServers(path.dirname(target));
  if (!fs.existsSync(target)) {
    const defaults = defaultsFactory().map(normalizeServer);
    writeMcpFile(target, defaults);
    return { path: target, servers: defaults };
  }
  try {
    const raw = fs.readFileSync(target, 'utf8');
    const parsed = raw ? JSON.parse(raw) : {};
    let servers = Array.isArray(parsed.servers) ? parsed.servers.map(normalizeServer) : [];
    if (shouldRefreshLegacyServers(servers, path.dirname(target))) {
      servers = defaultsFactory().map(normalizeServer);
      writeMcpFile(target, servers);
    }
    return { path: target, servers };
  } catch (err) {
    throw new Error(`Failed to read MCP config ${target}: ${err.message}`);
  }
}

function saveMcpConfig(filePath, servers) {
  const normalized = servers.map(normalizeServer);
  writeMcpFile(filePath, normalized);
}

function writeMcpFile(filePath, servers) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = { servers };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function normalizeServer(entry) {
  if (!entry || typeof entry !== 'object') {
    return { name: '', url: '', api_key_env: '', description: '' };
  }
  return {
    name: String(entry.name || ''),
    url: String(entry.url || ''),
    api_key_env: entry.api_key_env ? String(entry.api_key_env) : '',
    description: entry.description ? String(entry.description) : '',
  };
}

function getDefaultServers(baseDir) {
  const entries = [
    {
      name: 'project_files',
      script: path.join(CLI_ROOT, 'mcp_servers', 'filesystem-server.js'),
      args: '--root . --mode read --name project_files',
      description: '浏览/搜索项目文件（只读，默认 root=.）。',
    },
    {
      name: 'code_writer',
      script: path.join(CLI_ROOT, 'mcp_servers', 'filesystem-server.js'),
      args: '--root . --write --name code_writer',
      description: '写入或删除项目内文件，支持 append/overwrite 模式。',
    },
    {
      name: 'shell_tasks',
      script: path.join(CLI_ROOT, 'mcp_servers', 'shell-server.js'),
      args: '--root . --name shell_tasks',
      description: '在受限 root 内执行常见 shell 命令、列出目录等操作。',
    },
  ];
  return entries.map((entry) => ({
    name: entry.name,
    url: buildCmdUrl(baseDir, entry.script, entry.args),
    api_key_env: '',
    description: entry.description,
  }));
}

function buildCmdUrl(baseDir, scriptPath, extraArgs) {
  let scriptArg = scriptPath;
  if (baseDir) {
    const relative = path.relative(baseDir, scriptPath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      scriptArg = relative.startsWith('.') ? relative : `./${relative}`;
    }
  }
  scriptArg = scriptArg.replace(/\\/g, '/');
  const parts = ['cmd://node', scriptArg];
  if (extraArgs) {
    parts.push(extraArgs);
  }
  return parts.filter(Boolean).join(' ');
}

function shouldRefreshLegacyServers(servers, baseDir) {
  if (!Array.isArray(servers) || servers.length === 0) {
    return true;
  }
  const legacyMarker = '@modelcontextprotocol/server-';
  const allLegacyPlaceholders = servers.every(
    (entry) => typeof entry.url === 'string' && entry.url.includes(legacyMarker)
  );
  if (allLegacyPlaceholders) {
    return true;
  }
  return servers.some((entry) => {
    const scriptPath = resolveScriptPath(entry.url, baseDir);
    return scriptPath && !fs.existsSync(scriptPath);
  });
}

function resolveScriptPath(url, baseDir) {
  const parsed = parseCmdUrl(url);
  if (!parsed || parsed.command !== 'node' || parsed.args.length === 0) {
    return null;
  }
  const scriptArg = parsed.args[0];
  if (!scriptArg) {
    return null;
  }
  if (path.isAbsolute(scriptArg)) {
    return scriptArg;
  }
  const base = baseDir || process.cwd();
  return path.resolve(base, scriptArg);
}

function parseCmdUrl(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith('cmd://')) {
    return null;
  }
  const commandLine = trimmed.slice('cmd://'.length).trim();
  if (!commandLine) {
    return null;
  }
  const tokens = shellSplit(commandLine);
  if (tokens.length === 0) {
    return null;
  }
  return {
    command: tokens[0],
    args: tokens.slice(1),
  };
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

module.exports = {
  loadMcpConfig,
  saveMcpConfig,
  resolveMcpPath,
};
