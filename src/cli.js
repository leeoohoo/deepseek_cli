#!/usr/bin/env node

import path from 'path';
import { ConfigError, loadConfig, resolveDefaultConfigPath } from './config.js';
import { ChatSession } from './session.js';
import { ModelClient } from './client.js';
import * as colors from './colors.js';
import { runStartupWizard } from './ui/index.js';
import { initializeMcpRuntime } from './mcp/runtime.js';
import { loadPromptProfiles } from './prompts.js';
import { chatLoop, DEFAULT_SYSTEM_PROMPT } from './chat-loop.js';

const DEFAULT_MODEL_NAME = 'deepseek_chat';

const COMMANDS = {
  MODELS: 'models',
  CHAT: 'chat',
};

main().catch((err) => {
  console.error(colors.yellow(`Unexpected failure: ${err.message}`));
  process.exitCode = 1;
});

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return;
  }
  const args = argv.slice(1);
  if (command === COMMANDS.MODELS) {
    let parsed;
    try {
      parsed = parseOptions(args, {
        '--config': { key: 'config', type: 'string' },
        '-c': { key: 'config', type: 'string' },
      });
    } catch (err) {
      console.error(colors.yellow(err.message));
      process.exit(1);
    }
    runListModels(parsed.options.config);
    return;
  }
  if (command === COMMANDS.CHAT) {
    let parsed;
    try {
      parsed = parseOptions(args, {
        '--config': { key: 'config', type: 'string' },
        '-c': { key: 'config', type: 'string' },
        '--model': { key: 'model', type: 'string' },
        '-m': { key: 'model', type: 'string' },
        '--system': { key: 'system', type: 'string' },
        '--stream': { key: 'stream', type: 'boolean', value: true },
        '--no-stream': { key: 'stream', type: 'boolean', value: false },
        '--ui': { key: 'ui', type: 'boolean', value: true },
        '--no-ui': { key: 'ui', type: 'boolean', value: false },
      });
    } catch (err) {
      console.error(colors.yellow(err.message));
      process.exit(1);
    }
    await runChat(parsed.options);
    return;
  }
  console.error(colors.yellow(`Unknown command ${command}`));
  printUsage();
}

function printUsage() {
  console.log(`model-cli-js (Node.js)

Usage:
  model-cli-js models [--config <path>]
  model-cli-js chat [--model <name>] [--config <path>] [--system <prompt>] [--no-stream] [--no-ui]

Inline commands while chatting:
  :help    Show inline command list
  :models  List configured models
  :use     Switch active model
  :reset   Clear the current conversation
  :save    Write transcript to Markdown
  :exit    Leave the chat

Slash commands:
  /model      Reopen the guided setup UI
  /prompt     Override the active system prompt
  /mcp        Show MCP server configuration
  /mcp_set    Interactive MCP configuration wizard
  /mcp_tools  Enable or disable registered MCP tools
  /tool       Show the latest tool outputs (e.g. /tool T1)`);
}

function parseOptions(argv, allowed) {
  const options = {};
  const positional = [];
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      positional.push(token);
      i += 1;
      continue;
    }
    const [flag, inlineValue] = token.split('=');
    const spec = allowed[flag];
    if (!spec) {
      throw new Error(`Unknown option ${flag}`);
    }
    if (spec.type === 'boolean') {
      if (inlineValue !== undefined) {
        options[spec.key] = parseBoolean(inlineValue, flag);
      } else if (spec.value !== undefined) {
        options[spec.key] = spec.value;
      } else {
        options[spec.key] = true;
      }
      i += 1;
      continue;
    }
    let value = inlineValue;
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Option ${flag} requires a value`);
      }
      i += 1;
    }
    options[spec.key] = value;
    i += 1;
  }
  return { options, positional };
}

function parseBoolean(value, flag) {
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n'].includes(normalized)) {
    return false;
  }
  throw new Error(`Option ${flag} expected a boolean value but received "${value}"`);
}

function runListModels(configPath) {
  const { config, resolved } = loadAppConfig(configPath);
  console.log(`Using config: ${resolved}`);
  console.log(renderModelsTable(config));
}

async function runChat(options) {
  let resolvedOptions = { ...options };
  const interactiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const uiRequested = resolvedOptions.ui === true;
  if (uiRequested && !interactiveTerminal) {
    console.log(colors.yellow('UI 启动向导需要交互式终端，已自动跳过。'));
  }
  if (uiRequested && interactiveTerminal) {
    const guided = await runStartupWizard(resolvedOptions);
    if (!guided) {
      console.log(colors.yellow('Setup cancelled. Exiting.'));
      return;
    }
    resolvedOptions = {
      ...resolvedOptions,
      config: guided.configPath,
      model: guided.model,
      system: guided.system,
      stream: guided.stream !== undefined ? guided.stream : resolvedOptions.stream,
    };
  }
  if (!resolvedOptions.model) {
    resolvedOptions.model = DEFAULT_MODEL_NAME;
  }
  const { config, resolved } = loadAppConfig(resolvedOptions.config);
  const promptStore = loadPromptProfiles(resolved);
  let mcpRuntime = null;
  try {
    mcpRuntime = await initializeMcpRuntime(resolved, process.cwd());
    if (mcpRuntime) {
      mcpRuntime.applyToConfig(config);
    }
  } catch (err) {
    console.error(colors.yellow(`[MCP] 初始化失败：${err.message}`));
  }
  const client = new ModelClient(config);
  const targetSettings = config.getModel(resolvedOptions.model || null);

  // Ensure 'invoke_sub_agent' tool is available, as the default system prompt relies on it
  if (!Array.isArray(targetSettings.tools)) {
    targetSettings.tools = [];
  }
  if (!targetSettings.tools.includes('invoke_sub_agent')) {
    targetSettings.tools.push('invoke_sub_agent');
  }

  const sessionSystem =
    resolvedOptions.system !== undefined
      ? resolvedOptions.system
      : targetSettings.system_prompt || DEFAULT_SYSTEM_PROMPT;
  const session = new ChatSession(sessionSystem);
  console.log(`Using config: ${resolved}`);
  const streamEnabled =
    resolvedOptions.stream !== undefined ? resolvedOptions.stream : true;
  try {
    await chatLoop(client, targetSettings.name, session, {
      systemOverride: resolvedOptions.system,
      stream: streamEnabled,
      configPath: resolved,
      allowUi: interactiveTerminal,
      promptStore,
    });
  } finally {
    if (mcpRuntime) {
      await mcpRuntime.shutdown().catch(() => {});
    }
  }
}

function loadAppConfig(configPath) {
  const resolved = configPath ? path.resolve(configPath) : resolveDefaultConfigPath();
  try {
    const config = loadConfig(resolved);
    return { config, resolved };
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(colors.yellow(err.message));
      process.exit(1);
    }
    throw err;
  }
}

function renderModelsTable(config) {
  const headers = ['Name', 'Provider', 'Model ID', 'System Prompt'];
  const rows = Object.entries(config.models).map(([name, settings]) => {
    const prompt = (settings.system_prompt || '').trim();
    const preview = prompt.length > 40 ? `${prompt.slice(0, 37)}...` : prompt || '-';
    return [name, settings.provider, settings.model, preview];
  });
  const widths = headers.map((header, index) => {
    const candidate = rows.reduce((max, row) => Math.max(max, row[index].length), header.length);
    return candidate;
  });
  const line = (row) =>
    row
      .map((cell, idx) => cell.padEnd(widths[idx]))
      .join(' | ');
  const divider = widths
    .map((w) => '-'.repeat(w))
    .join('-|-');
  const lines = [line(headers), divider, ...rows.map((row) => line(row))];
  return lines.join('\n');
}
