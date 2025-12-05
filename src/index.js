#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { ConfigError, loadConfig, resolveDefaultConfigPath } = require('./config');
const { ChatSession } = require('./session');
const { ModelClient } = require('./client');
const colors = require('./colors');
const { expandHomePath } = require('./utils');
const { createSubAgentManager } = require('./subagents');
const { selectAgent } = require('./subagents/selector');
const { setSubAgentContext } = require('./subagents/runtime');
const {
  runStartupWizard,
  runMcpToolsConfigurator,
  runModelPicker,
  runMcpSetup,
} = require('./ui');
const { loadMcpConfig, saveMcpConfig } = require('./mcp');
const { initializeMcpRuntime } = require('./mcp/runtime');
const { loadPromptProfiles } = require('./prompts');

const DEFAULT_MODEL_NAME = 'deepseek_chat';
const DEFAULT_SYSTEM_PROMPT = `你是一名资深全栈工程师，帮助我在终端里完成日常开发工作。优先：
- 用中文解释整体思路，再给出可运行的代码片段。
- 每当引用项目文件时，标注相对路径并指出需要修改的文件。
- 主动提醒缺失的测试、潜在风险以及后续步骤。
- 输出内容保持简洁，必要时使用列表或代码块。
- 每个用户任务都先判断是否需要更细分的专家。如果适合，让 invoke_sub_agent 工具自动选择对应的子代理（例如 Python 架构/交付、安全、K8s 等），并把任务描述与技能偏好传给该工具；只有在工具不可用或不合适时再直接回答。`;

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

async function chatLoop(initialClient, initialModel, session, options = {}) {
  let client = initialClient;
  let systemOverride = options.systemOverride;
  let streamResponses = options.stream !== undefined ? options.stream : true;
  let configPath = options.configPath || null;
  const promptStore = options.promptStore || null;
  const toolHistory = createToolHistory();
  const summaryManager = createSummaryManager(options);
  const subAgentManager = createSubAgentManager();
  const allowInlineUi =
    options.allowUi !== undefined
      ? options.allowUi
      : Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const updateSubContext = () =>
    setSubAgentContext({
      manager: subAgentManager,
      getClient: () => client,
      getCurrentModel: () => currentModel,
    });
  updateSubContext();
  console.log(
    colors.cyan(
      `Connected to ${initialModel}. Type messages and press Enter to send. Use :help for inline commands.`
    )
  );
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 0,
  });

  rl.on('SIGINT', () => {
    console.log('\nExiting chat.');
    rl.close();
  });

  const askLine = (promptText) =>
    new Promise((resolve, reject) => {
      const handleClose = () => {
        rl.removeListener('close', handleClose);
        reject(new Error('Input closed'));
      };
      rl.once('close', handleClose);
      rl.question(promptText, (answer) => {
        rl.removeListener('close', handleClose);
        resolve(answer.trim());
      });
    });

  let currentModel = initialModel;
  while (true) {
    let input;
    try {
      input = await askLine(colors.green('you> '));
    } catch {
      break;
    }
    if (!input) {
      continue;
    }
    const autoHandled = await maybeHandleAutoSubagentRequest(input, {
      rawInput: input,
      subAgents: subAgentManager,
      client,
      currentModel,
    });
    if (autoHandled) {
      continue;
    }
    if (input.startsWith('/')) {
      const slashResult = await handleSlashCommand(input, {
        askLine,
        client,
        session,
        currentModel,
        streamResponses,
        systemOverride,
        configPath,
        allowUi: allowInlineUi,
        rl,
        toolHistory,
        promptStore,
        subAgents: subAgentManager,
      });
      if (slashResult?.type === 'reconfigure') {
        client = slashResult.client;
        configPath = slashResult.configPath;
        currentModel = slashResult.model;
        if (slashResult.stream !== undefined) {
          streamResponses = slashResult.stream;
        }
        systemOverride = slashResult.systemOverride;
        const nextPrompt =
          slashResult.sessionPrompt !== undefined
            ? slashResult.sessionPrompt
            : resolveSystemPrompt(client, currentModel, systemOverride);
        session.reset(nextPrompt);
        updateSubContext();
        console.log(colors.yellow('Session updated. Conversation restarted.'));
        console.log(
          colors.cyan(
            `Connected to ${currentModel}. Type messages and press Enter to send. Use :help for inline commands.`
          )
        );
      } else if (slashResult?.type === 'switch-model') {
        currentModel = slashResult.model;
        const nextPrompt = slashResult.sessionPrompt;
        session.reset(nextPrompt);
        updateSubContext();
        console.log(colors.yellow(`Switched to model '${currentModel}'.`));
      } else if (slashResult?.type === 'prompt-update') {
        systemOverride = slashResult.useConfigDefault ? undefined : slashResult.systemOverride;
        const nextPrompt = resolveSystemPrompt(client, currentModel, systemOverride);
        session.reset(nextPrompt);
        console.log(colors.yellow('System prompt updated for this conversation.'));
      }
      continue;
    }
    if (input.startsWith(':')) {
      const result = handleCommand(input, client, session, currentModel, systemOverride);
      if (result === null) {
        break;
      }
      currentModel = result;
      continue;
    }
    session.addUser(input);
    try {
      const printer = createResponsePrinter(currentModel, streamResponses, {
        registerToolResult: (toolName, content) => toolHistory.add(toolName, content),
      });
      const finalText = await client.chat(currentModel, session, {
        stream: streamResponses,
        onToken: printer.onToken,
        onReasoning: printer.onReasoning,
        onToolCall: printer.onToolCall,
        onToolResult: printer.onToolResult,
      });
      summaryManager.maybeSummarize(session, client, currentModel);
      printer.onComplete(finalText);
    } catch (err) {
      session.popLast();
      console.error(colors.yellow(`Request failed: ${err.message}`));
    }
  }
  rl.close();
  setSubAgentContext(null);
}

function handleCommand(command, client, session, currentModel, systemOverride) {
  const [name, ...rest] = command.slice(1).trim().split(/\s+/);
  const argument = rest.join(' ').trim();
  switch (name) {
    case 'exit':
    case 'quit':
    case 'q':
      return null;
    case 'help':
      console.log(`Commands:
:help   Show this message
:models List available models
:use    Switch to another model
:reset  Start a new conversation
:save   Save transcript to a Markdown file
:exit   Leave the chat`);
      return currentModel;
    case 'models':
      console.log(renderAvailableModels(client));
      return currentModel;
    case 'reset': {
      const systemPrompt = resolveSystemPrompt(client, currentModel, systemOverride);
      session.reset(systemPrompt);
      console.log(colors.yellow('Conversation cleared.'));
      return currentModel;
    }
    case 'use':
      if (!argument) {
        console.log(colors.yellow('Usage: :use <model_name>'));
        return currentModel;
      }
      try {
        client.config.getModel(argument);
      } catch (err) {
        console.error(colors.yellow(err.message));
        return currentModel;
      }
      session.reset(resolveSystemPrompt(client, argument, systemOverride));
      console.log(colors.yellow(`Switched to model '${argument}'.`));
      return argument;
    case 'save':
      if (!argument) {
        console.log(colors.yellow('Usage: :save <path>'));
        return currentModel;
      }
      const targetPath = path.resolve(expandHomePath(argument));
      writeTranscript(targetPath, session);
      console.log(colors.green(`Transcript saved to ${targetPath}.`));
      return currentModel;
    default:
      console.log(colors.yellow('Unknown command. Use :help for options.'));
      return currentModel;
  }
}

async function handleSlashCommand(input, context) {
  const command = input.slice(1).trim();
  if (!command) {
    console.log(colors.yellow('Slash commands: /model, /prompt, /mcp, /mcp_set, /mcp_tools, /tool.'));
    return null;
  }
  const [nameRaw] = command.split(/\s+/);
  const name = nameRaw.toLowerCase();
  const argsText = command.slice(nameRaw.length).trim();
  const uiControl = createUiControl(context.rl);
  switch (name) {
    case 'prompt':
    case 'propmt': {
      const promptStore = context.promptStore;
      if (argsText && promptStore) {
        const tokens = argsText.split(/\s+/).filter(Boolean);
        const [subRaw, ...restTokens] = tokens;
        const sub = (subRaw || '').toLowerCase();
        if (['list', 'ls'].includes(sub)) {
          const names = Object.keys(promptStore.prompts || {});
          if (names.length === 0) {
            console.log(colors.yellow('提示词列表为空。请手动编辑 prompts.yaml。'));
            return null;
          }
          console.log(colors.cyan('\n可用提示词:'));
          names.forEach((entry) => console.log(`  - ${entry}`));
          console.log(colors.dim(`配置文件: ${promptStore.path}`));
          return null;
        }
        if (['show', 'view'].includes(sub) && restTokens.length > 0) {
          const key = restTokens.join(' ');
          const profile = promptStore.prompts?.[key];
          if (!profile) {
            console.log(colors.yellow(`未找到提示词 "${key}"。`));
            return null;
          }
          console.log(colors.cyan(`\n=== ${key} ===`));
          console.log(profile);
          return null;
        }
        if (['use', 'apply'].includes(sub) && restTokens.length > 0) {
          const key = restTokens.join(' ');
          const profile = promptStore.prompts?.[key];
          if (!profile) {
            console.log(colors.yellow(`未找到提示词 "${key}"。`));
            return null;
          }
          console.log(colors.green(`已切换到提示词 "${key}"。`));
          return { type: 'prompt-update', systemOverride: profile };
        }
        if (promptStore.prompts?.[argsText]) {
          console.log(colors.green(`已切换到提示词 "${argsText}"。`));
          return { type: 'prompt-update', systemOverride: promptStore.prompts[argsText] };
        }
        console.log(colors.yellow('未知的提示词指令。使用 /prompt list 查看可用名称。'));
        return null;
      }
      const current = resolveSystemPrompt(
        context.client,
        context.currentModel,
        context.systemOverride
      );
      console.log(colors.cyan('\n=== 当前 System Prompt ==='));
      console.log(current ? current : colors.dim('<未设置，将发送无 system prompt>'));
      console.log(
        colors.dim(
          '输入新的 prompt 并回车即可生效。留空表示保持原样，"." 清空，输入 "!default" 使用内置开发提示，输入 "!config" 回到模型配置，输入 "!list" 查看 prompts.yaml 中的候选项。'
        )
      );
      const next = await context.askLine(colors.magenta('新 prompt: '));
      const trimmed = next.trim();
      if (!trimmed) {
        console.log(colors.yellow('System prompt 未修改。'));
        return null;
      }
      if (trimmed === '.') {
        return { type: 'prompt-update', systemOverride: '' };
      }
      if (trimmed.toLowerCase() === '!default') {
        return { type: 'prompt-update', systemOverride: DEFAULT_SYSTEM_PROMPT };
      }
      if (trimmed.toLowerCase() === '!config') {
        return { type: 'prompt-update', useConfigDefault: true };
      }
      if (trimmed.toLowerCase() === '!list' && promptStore) {
        const names = Object.keys(promptStore.prompts || {});
        if (names.length === 0) {
          console.log(colors.yellow('提示词列表为空。请手动编辑 prompts.yaml。'));
        } else {
          console.log(colors.cyan('\n可用提示词:'));
          names.forEach((entry) => console.log(`  - ${entry}`));
          console.log(colors.dim(`配置文件: ${promptStore.path}`));
        }
        return null;
      }
      return { type: 'prompt-update', systemOverride: trimmed };
    }
    case 'tool':
    case 'tool_result': {
      if (!context.toolHistory) {
        console.log(colors.yellow('暂无工具输出记录。'));
        return null;
      }
      if (!argsText) {
        const entries = context.toolHistory.list();
        if (entries.length === 0) {
          console.log(colors.yellow('暂无工具输出记录。'));
          return null;
        }
        console.log(colors.cyan('\n最近的工具输出：'));
        entries.forEach((entry) => {
          const timeLabel = entry.timestamp
            ? entry.timestamp.toLocaleTimeString()
            : '';
          console.log(`  [${entry.id}] ${entry.tool} ${timeLabel ? `@ ${timeLabel}` : ''}`);
        });
        console.log(colors.dim('使用 /tool <ID> 查看完整内容。'));
        return null;
      }
      const target = context.toolHistory.get(argsText);
      if (!target) {
        console.log(colors.yellow(`未找到编号为 ${argsText} 的工具输出。`));
        return null;
      }
      console.log(colors.cyan(`\n=== Tool ${target.tool} (${target.id}) ===`));
      console.log(target.content || colors.dim('<empty>'));
      return null;
    }
    case 'sub': {
      return handleSubagentsCommand(argsText, context);
    }
    case 'model': {
      if (!context.allowUi) {
        console.log(colors.yellow('Interactive setup is only available in interactive terminals.'));
        return null;
      }
      const selection = await runModelPicker(
        context.askLine,
        context.client.config,
        context.currentModel,
        uiControl
      );
      if (!selection) {
        console.log(colors.yellow('Model selection cancelled.'));
        return null;
      }
      if (selection === context.currentModel) {
        console.log(colors.green(`Continuing with model '${selection}'.`));
        return null;
      }
      const sessionPrompt = resolveSystemPrompt(context.client, selection, context.systemOverride);
      return {
        type: 'switch-model',
        model: selection,
        sessionPrompt,
      };
    }
    case 'mcp': {
      try {
        const { path: mcpPath, servers } = loadMcpConfig(context.configPath);
        printMcpServers(servers, mcpPath);
      } catch (err) {
        console.error(colors.yellow(`Failed to load MCP config: ${err.message}`));
      }
      return null;
    }
    case 'mcp_set': {
      if (!context.allowUi) {
        console.log(colors.yellow('MCP configuration UI is only available in interactive terminals.'));
        return null;
      }
      try {
        const { path: mcpPath, servers } = loadMcpConfig(context.configPath);
        const result = await runMcpSetup(context.askLine, servers, uiControl);
        if (!result) {
          console.log(colors.yellow('No changes applied to MCP configuration.'));
          return null;
        }
        const updated = upsertMcpServer(servers, result.server, result.originalName);
        saveMcpConfig(mcpPath, updated);
        console.log(colors.green(`Saved MCP config (${updated.length} entries) to ${mcpPath}.`));
      } catch (err) {
        console.error(colors.yellow(`Failed to configure MCP: ${err.message}`));
      }
      return null;
    }
    case 'mcp_tools': {
      if (!context.allowUi) {
        console.log(colors.yellow('Tool configuration UI requires an interactive terminal.'));
        return null;
      }
      try {
        const selection = await runMcpToolsConfigurator(
          context.askLine,
          context.client.config,
          context.currentModel,
          uiControl
        );
        if (selection === null) {
          console.log(colors.yellow('Tool selection cancelled.'));
          return null;
        }
        context.client.config.models[context.currentModel].tools = selection;
        const summary = selection.length > 0 ? selection.join(', ') : '<none>';
        console.log(colors.green(`Active tools for ${context.currentModel}: ${summary}`));
        return { type: 'tools-updated', tools: selection };
      } catch (err) {
        console.error(colors.yellow(`Tool configuration failed: ${err.message}`));
        return null;
      }
    }
    default:
      console.log(colors.yellow('Unknown slash command. Try /model or /mcp_tools.'));
      return null;
  }
}

async function handleSubagentsCommand(argsText, context) {
  const manager = context.subAgents;
  if (!manager) {
    console.log(colors.yellow('Sub-agent manager is unavailable in this session.'));
    return null;
  }
  const trimmed = (argsText || '').trim();
  if (!trimmed || trimmed === 'help') {
    printSubagentHelp();
    return null;
  }
  const [subCommandRaw, ...restTokens] = trimmed.split(/\s+/);
  const subCommand = subCommandRaw.toLowerCase();
  const restText = restTokens.join(' ').trim();
  switch (subCommand) {
    case 'plugins':
    case 'market':
    case 'marketplace': {
      const entries = manager.listMarketplace();
      if (entries.length === 0) {
        console.log(colors.yellow('Marketplace is empty. Add plugins to the subagents directory.'));
        return null;
      }
      console.log(colors.cyan('\nSub-agent marketplace:'));
      entries.forEach((entry) => {
        console.log(`  - ${entry.id} [${entry.category || 'general'}] ${entry.name}`);
        if (entry.description) {
          console.log(colors.dim(`      ${entry.description}`));
        }
      });
      console.log(colors.dim('\n使用 /sub install <plugin_id> 安装插件。'));
      return null;
    }
    case 'install': {
      if (!restTokens[0]) {
        console.log(colors.yellow('Usage: /sub install <plugin_id>'));
        return null;
      }
      const pluginId = restTokens[0];
      try {
        const changed = manager.install(pluginId);
        if (changed) {
          console.log(colors.green(`Installed plugin "${pluginId}". 使用 /sub agents 查看代理。`));
        } else {
          console.log(colors.green(`Plugin "${pluginId}" 已安装。`));
        }
      } catch (err) {
        console.error(colors.yellow(err.message));
      }
      return null;
    }
    case 'remove':
    case 'uninstall': {
      if (!restTokens[0]) {
        console.log(colors.yellow('Usage: /sub uninstall <plugin_id>'));
        return null;
      }
      const pluginId = restTokens[0];
      const removed = manager.uninstall(pluginId);
      if (removed) {
        console.log(colors.green(`Removed plugin "${pluginId}".`));
      } else {
        console.log(colors.yellow(`Plugin "${pluginId}" 未安装。`));
      }
      return null;
    }
    case 'agents':
    case 'list': {
      const agents = manager.listAgents();
      if (agents.length === 0) {
        console.log(colors.yellow('没有可用的 sub-agent。使用 /sub install <plugin> 安装插件。'));
        return null;
      }
      console.log(colors.cyan('\n已安装的 sub-agent：'));
      agents.forEach((agent) => {
        console.log(
          `  - ${agent.id} (${agent.name}) [${agent.pluginId}] model=${agent.model || 'current'}`
        );
        if (agent.description) {
          console.log(colors.dim(`      ${agent.description}`));
        }
        if (agent.skills.length > 0) {
          const skillNames = agent.skills.map((skill) => skill.id).join(', ');
          console.log(colors.dim(`      skills: ${skillNames}`));
        }
      });
      console.log(
        colors.dim('\n使用 /sub run <agent_id> <任务描述> [--skills skill1,skill2] 执行 sub-agent。')
      );
      return null;
    }
    case 'run':
    case 'use': {
      const parsed = parseSubAgentRunArgs(restText);
      if (!parsed || !parsed.agentId || !parsed.taskText) {
        console.log(
          colors.yellow(
            'Usage: /sub run <agent_id> <任务描述> [--skills skill1,skill2]\n例如：/sub run python-architect 设计新的API --skills async-patterns'
          )
        );
        return null;
      }
      const agentRef = manager.getAgent(parsed.agentId);
      if (!agentRef) {
        console.log(colors.yellow(`未找到 sub-agent "${parsed.agentId}"。`));
        return null;
      }
      try {
        await executeSubAgentTask(agentRef, parsed.taskText, parsed.skills, {
          manager,
          client: context.client,
          currentModel: context.currentModel,
        }, { toolHistory: context.toolHistory });
      } catch (err) {
        console.error(colors.yellow(`Sub-agent 调用失败: ${err.message}`));
      }
      return null;
    }
    default:
      printSubagentHelp();
      return null;
  }
}

function parseSubAgentRunArgs(text) {
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const skillsIndex = trimmed.indexOf('--skills');
  let skillList = [];
  let statement = trimmed;
  if (skillsIndex >= 0) {
    statement = trimmed.slice(0, skillsIndex).trim();
    const rawSkill = trimmed.slice(skillsIndex + '--skills'.length).trim();
    skillList = rawSkill
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (!statement) {
    return null;
  }
  const firstSpace = statement.indexOf(' ');
  if (firstSpace < 0) {
    return { agentId: statement, taskText: '', skills: skillList };
  }
  const agentId = statement.slice(0, firstSpace).trim();
  const taskText = statement.slice(firstSpace + 1).trim();
  return { agentId, taskText, skills: skillList };
}

function printSubagentHelp() {
  console.log(
    colors.cyan(
      '\n/sub 命令：\n  /sub marketplace          列出可用插件\n  /sub install <id>        安装插件\n  /sub uninstall <id>      卸载插件\n  /sub agents              查看已安装的 sub-agent\n  /sub run <agent> <任务> [--skills skill1,skill2] 运行子代理'
    )
  );
}

async function executeSubAgentTask(agentRef, taskText, requestedSkills, context, options = {}) {
  if (!agentRef || !agentRef.agent || !agentRef.plugin) {
    throw new Error('Invalid sub-agent reference.');
  }
  if (!taskText || !taskText.trim()) {
    throw new Error('Task description is required for sub-agent execution.');
  }
  const manager = context.manager || context.subAgents;
  if (!manager) {
    throw new Error('Sub-agent manager unavailable.');
  }
  const client = context.client;
  if (!client) {
    throw new Error('Model client unavailable.');
  }
  const normalizedSkills = Array.isArray(requestedSkills)
    ? requestedSkills.map((entry) => entry.trim()).filter(Boolean)
    : [];
  const promptResult = manager.buildSystemPrompt(agentRef, normalizedSkills);
  const systemPrompt = promptResult.systemPrompt;
  const usedSkills = promptResult.usedSkills || [];
  const extraConfig = promptResult.extra || {};
  const targetModel =
    agentRef.agent.model ||
    context.currentModel ||
    (typeof client.getDefaultModel === 'function' ? client.getDefaultModel() : null);
  if (!targetModel) {
    throw new Error('No model available for sub-agent invocation.');
  }
  const subSession = new ChatSession(systemPrompt);
  subSession.addUser(taskText);
  const reasonLabel = options.reason ? colors.dim(` [${options.reason}]`) : '';
  console.log(
    colors.cyan(
      `\n[sub:${agentRef.agent.id}] ${agentRef.agent.name} (${agentRef.plugin.name}) -> 模型 ${targetModel}${reasonLabel}`
    )
  );
  if (usedSkills.length > 0) {
    const skillLabel = usedSkills.map((skill) => skill.id).join(', ');
    console.log(colors.dim(`激活技能: ${skillLabel}`));
  }
  const toolHistory = options.toolHistory || null;
  const reasoningEnabled =
    extraConfig.reasoning !== undefined ? extraConfig.reasoning : agentRef.agent.reasoning;
  const printer = createResponsePrinter(`[sub:${agentRef.agent.id}]`, true, {
    registerToolResult: toolHistory ? (toolName, content) => toolHistory.add(toolName, content) : null,
  });
  let response = '';
  try {
    response = await client.chat(targetModel, subSession, {
      stream: true,
      onToken: printer.onToken,
      onReasoning: printer.onReasoning,
      onToolCall: printer.onToolCall,
      onToolResult: printer.onToolResult,
      reasoning: reasoningEnabled,
    });
  } finally {
    printer.onComplete(response);
  }
  return { response, usedSkills, model: targetModel };
}

async function maybeHandleAutoSubagentRequest(rawInput, context) {
  const manager = context.subAgents || context.manager;
  if (!manager) {
    return false;
  }
  if (!rawInput || !rawInput.trim()) {
    return false;
  }
  const normalized = rawInput.toLowerCase();
  if (!/invoke_sub_agent|sub\s*agent/.test(normalized)) {
    return false;
  }
  const taskText = rawInput.replace(/invoke_sub_agent/gi, '').trim() || rawInput.trim();
  const category = inferCategoryFromText(normalized);
  const skillHints = inferSkillHints(normalized);
  const agentRef = selectAgent(manager, { category, skills: skillHints });
  if (!agentRef) {
    console.log(colors.yellow('没有可用的 sub-agent，请先使用 /sub install 安装插件。'));
    return true;
  }
  try {
    await executeSubAgentTask(
      agentRef,
      taskText,
      skillHints,
      {
        manager,
        client: context.client,
        currentModel: context.currentModel,
      },
      {
        reason: 'auto',
        toolHistory: context.toolHistory,
      }
    );
  } catch (err) {
    console.error(colors.yellow(`自动调用 sub-agent 失败：${err.message}`));
  }
  return true;
}

function inferCategoryFromText(text) {
  if (!text) {
    return null;
  }
  if (text.includes('python')) return 'python';
  if (text.includes('javascript') || text.includes('typescript') || /\bjs\b/.test(text)) {
    return 'javascript';
  }
  if (text.includes('kubernetes') || text.includes('k8')) {
    return 'kubernetes';
  }
  if (text.includes('security') || text.includes('安全')) {
    return 'security';
  }
  if (text.includes('cloud') || text.includes('aws') || text.includes('azure') || text.includes('gcp')) {
    return 'cloud';
  }
  return null;
}

function inferSkillHints(text) {
  const hints = new Set();
  if (!text) {
    return [];
  }
  if (text.includes('async') || text.includes('异步')) {
    hints.add('async-patterns');
  }
  if (text.includes('test') || text.includes('测试')) {
    hints.add('python-testing');
  }
  return Array.from(hints);
}

function renderAvailableModels(client) {
  const names = client.getModelNames();
  const defaultModel = client.getDefaultModel();
  const lines = ['Available models:'];
  for (const name of names) {
    const settings = client.config.models[name];
    const marker = name === defaultModel ? ' (default)' : '';
    lines.push(`- ${name}${marker} [${settings.provider}]`);
  }
  return lines.join('\n');
}

function resolveSystemPrompt(client, modelName, systemOverride) {
  if (systemOverride !== undefined) {
    return systemOverride;
  }
  const settings = client.config.getModel(modelName);
  return settings.system_prompt || DEFAULT_SYSTEM_PROMPT;
}

function printMcpServers(servers, configPath) {
  console.log(colors.cyan(`\nMCP config: ${configPath}`));
  if (!servers || servers.length === 0) {
    console.log(colors.yellow('No MCP servers configured. Use /mcp_set to add one.'));
    return;
  }
  servers.forEach((entry, idx) => {
    const endpoint = entry.url || '<none>';
    console.log(
      `  [${idx + 1}] ${entry.name || '<unnamed>'}\n      Endpoint: ${endpoint}\n      API key env: ${
        entry.api_key_env || '<none>'
      }\n      Description: ${entry.description || '<none>'}`
    );
  });
}

function upsertMcpServer(servers, server, originalName = null) {
  const copy = Array.isArray(servers) ? servers.map((entry) => ({ ...entry })) : [];
  const targetName = originalName || server.name;
  const existingIndex = copy.findIndex((entry) => entry.name === targetName);
  if (existingIndex >= 0) {
    copy[existingIndex] = { ...server };
  } else {
    const duplicateIndex = copy.findIndex((entry) => entry.name === server.name);
    if (duplicateIndex >= 0) {
      copy[duplicateIndex] = { ...server };
    } else {
      copy.push({ ...server });
    }
  }
  return copy;
}

function createUiControl(rl) {
  if (!rl || typeof rl.pause !== 'function' || typeof rl.resume !== 'function') {
    return {};
  }
  return {
    pause: () => {
      try {
        rl.pause();
      } catch {
        // ignore
      }
    },
    resume: () => {
      try {
        rl.resume();
      } catch {
        // ignore
      }
    },
  };
}

function writeTranscript(targetPath, session) {
  const lines = ['# model-cli transcript', ''];
  for (const message of session.messages) {
    let heading = 'Assistant';
    if (message.role === 'system') heading = 'System';
    else if (message.role === 'user') heading = 'You';
    else if (message.role === 'tool') heading = `Tool (${message.tool_call_id || 'call'})`;
    lines.push(`## ${heading}`);
    if (message.content && message.content.trim()) {
      lines.push(message.content);
    } else {
      lines.push('<no content>');
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      lines.push('');
      lines.push('Tool calls:');
      for (const call of message.tool_calls) {
        const args = call.function?.arguments || '{}';
        lines.push(`- ${call.function?.name || 'unknown'} (${call.id || 'no-id'}): ${args}`);
      }
    }
    lines.push('');
  }
  fs.writeFileSync(targetPath, lines.join('\n'), 'utf8');
}

function createResponsePrinter(model, streamEnabled, options = {}) {
  let buffer = '';
  let reasoningBuffer = '';
  let reasoningStreamActive = false;
  let reasoningShownInStream = false;
  if (streamEnabled) {
    console.log(colors.magenta(`\n[${model}]`));
  }
  const registerToolResult =
    typeof options.registerToolResult === 'function' ? options.registerToolResult : null;
  const ensureReasoningClosed = () => {
    if (streamEnabled && reasoningStreamActive) {
      process.stdout.write('\n');
      reasoningStreamActive = false;
    }
  };
  const printReasoningBlock = () => {
    if (!reasoningBuffer) {
      return;
    }
    console.log(colors.dim('\n[thinking]'));
    console.log(colors.dim(reasoningBuffer));
    console.log('');
  };
  const printToolInfo = (text) => {
    if (streamEnabled) {
      ensureReasoningClosed();
      process.stdout.write('\n');
    }
    console.log(text);
  };
  return {
    onToken: (chunk) => {
      if (!chunk) return;
      buffer += chunk;
      if (streamEnabled) {
        ensureReasoningClosed();
        process.stdout.write(chunk);
      }
    },
    onReasoning: (chunk) => {
      if (!chunk) return;
      reasoningBuffer += chunk;
      if (streamEnabled) {
        reasoningShownInStream = true;
        if (!reasoningStreamActive) {
          reasoningStreamActive = true;
          process.stdout.write(colors.dim('\n[thinking]\n'));
        }
        process.stdout.write(colors.dim(chunk));
      }
    },
    onToolCall: ({ tool, args }) => {
      const header = colors.blue(`[tool:${tool}]`);
      const formatted = formatToolCallArgs(args);
      printToolInfo(header);
      formatted.lines.forEach((line) => {
        printToolInfo(colors.dim(`  ${line}`));
      });
      formatted.previews.forEach((preview) => {
        const { preview: text, truncated } = summarizeToolPreview(preview.text);
        printToolInfo(colors.dim(`  ↳ ${preview.label || preview.key} 预览:`));
        printToolInfo(text);
        if (truncated) {
          printToolInfo(colors.dim('  ...内容较长，已折叠预览。'));
        }
      });
    },
    onToolResult: ({ tool, result }) => {
      const normalized = formatToolResult(result);
      if (shouldHideToolResult(tool)) {
        const summary = formatHiddenToolSummary(normalized);
        if (registerToolResult) {
          registerToolResult(tool, summary.historyText);
        }
        const label = colors.green(`↳ ${tool}:`);
        printToolInfo(`${label}\n${summary.preview}`);
        return;
      }
      const { preview, truncated } = summarizeToolPreview(normalized);
      const entryId = registerToolResult ? registerToolResult(tool, normalized) : null;
      const label = colors.green(`↳ ${tool}:`);
      printToolInfo(`${label}\n${preview}`);
      if (truncated) {
        const hint = entryId
          ? colors.dim(`内容较长，使用 /tool ${entryId} 查看完整输出。`)
          : colors.dim('内容较长，已折叠。');
        printToolInfo(hint);
      }
    },
    onComplete: (finalText) => {
      if (streamEnabled) {
        ensureReasoningClosed();
      }
      if (reasoningBuffer && (!streamEnabled || !reasoningShownInStream)) {
        printReasoningBlock();
      }
      if (streamEnabled) {
        if (!buffer && !finalText) {
          process.stdout.write(colors.dim('[no text]'));
        }
        process.stdout.write('\n');
      } else {
        const output = finalText || buffer || colors.dim('[no text]');
        printResponse(model, output);
      }
    },
  };
}

function formatToolCallArgs(args) {
  if (!args || typeof args !== 'object') {
    return { lines: ['{}'], previews: [] };
  }
  const simplified = {};
  const previews = [];
  Object.entries(args).forEach(([key, value]) => {
    if (typeof value === 'string' && shouldPreviewArg(value)) {
      simplified[key] = `<${value.length} chars, preview below>`;
      previews.push({ key, label: key, text: value });
    } else {
      simplified[key] = value;
    }
  });
  const json = JSON.stringify(simplified, null, 2);
  return {
    lines: json.split(/\r?\n/),
    previews,
  };
}

function shouldPreviewArg(value) {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length < 120) {
    return false;
  }
  if (!value.includes('\n')) {
    return false;
  }
  return looksLikeDiff(value);
}

function looksLikeDiff(text) {
  if (!text || typeof text !== 'string') {
    return false;
  }
  return /(^|\n)(?:\*\*\*|\+\+\+|---|@@)/.test(text);
}

function printResponse(model, text) {
  const border = '-'.repeat(Math.min(60, Math.max(10, model.length + 4)));
  console.log(`\n${colors.magenta(`[${model}]`)}\n${border}\n${text}\n`);
}

function formatToolResult(result) {
  if (typeof result === 'string') {
    return result;
  }
  if (result === null || result === undefined) {
    return '';
  }
  if (typeof result === 'object') {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

function summarizeToolPreview(text) {
  const lines = text.split(/\r?\n/);
  const limitLines = 12;
  const limitChars = 2000;
  const truncated = lines.length > limitLines || text.length > limitChars;
  if (!truncated) {
    return { preview: text, truncated: false };
  }
  const sliced = lines.slice(0, limitLines);
  const remainder = lines.length - sliced.length;
  let preview = sliced.join('\n');
  if (remainder > 0) {
    preview += `\n...（${remainder} 行已折叠）`;
  }
  return { preview, truncated: true };
}

function shouldHideToolResult(toolName) {
  if (!toolName) {
    return false;
  }
  const normalized = String(toolName).toLowerCase();
  return /(^|_)search(_|$)/.test(normalized);
}

function formatHiddenToolSummary(originalText) {
  const files = extractSearchFiles(originalText);
  if (files.length === 0) {
    const message = '搜索命中内容已隐藏（未识别到具体文件）。';
    return {
      preview: message,
      historyText: `${message}\n原始搜索结果未在终端显示。`,
    };
  }
  const formatted = files.map((file) => `  - ${file}`).join('\n');
  const preview = `搜索命中内容已隐藏，仅记录涉及文件：\n${formatted}`;
  return {
    preview,
    historyText: `${preview}\n原始搜索结果未在终端显示。`,
  };
}

function extractSearchFiles(text) {
  if (!text) {
    return [];
  }
  const seen = new Set();
  const lines = text.split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[')) {
      return;
    }
    const match = trimmed.match(/^([^:\s][^:]*)\s*:(\d+)/);
    if (match && match[1]) {
      const file = match[1].trim();
      if (file && !seen.has(file)) {
        seen.add(file);
      }
    }
  });
  return Array.from(seen);
}

function createToolHistory(limit = 20) {
  const entries = [];
  let counter = 1;
  return {
    add(tool, content) {
      const id = `T${counter++}`;
      entries.push({ id, tool, content, timestamp: new Date() });
      if (entries.length > limit) {
        entries.shift();
      }
      return id;
    },
    list() {
      return entries.slice().reverse();
    },
    get(id) {
      if (!id) return null;
      const target = id.trim().toLowerCase();
      return entries.find((entry) => entry.id.toLowerCase() === target) || null;
    },
  };
}

function createSummaryManager(options = {}) {
  const defaultThreshold = 60000;
  const envThreshold = Number(process.env.MODEL_CLI_SUMMARY_TOKENS || '') || null;
  const configuredThreshold =
    options.summaryThreshold === undefined ? null : Number(options.summaryThreshold);
  const threshold = configuredThreshold || envThreshold || defaultThreshold;
  const enabled = threshold > 0;
  let lastSummaryIndex = 0;
  let pending = false;
  return {
    maybeSummarize: async (session, client, modelName) => {
      if (!enabled || pending) {
        return;
      }
      const recentMessages = session.messages.slice(lastSummaryIndex);
      const tokenCount = estimateTokenCount(recentMessages);
      if (tokenCount <= threshold) {
        return;
      }
      pending = true;
      try {
        await summarizeSession(session, client, modelName, recentMessages);
        lastSummaryIndex = session.messages.length;
      } catch (err) {
        console.error(colors.yellow(`[summary] Failed to summarize conversation: ${err.message}`));
      } finally {
        pending = false;
      }
    },
    get threshold() {
      return threshold;
    },
    get lastSummaryIndex() {
      return lastSummaryIndex;
    },
  };
}

function estimateTokenCount(messages) {
  if (!Array.isArray(messages)) {
    return 0;
  }
  let total = 0;
  for (const message of messages) {
    if (!message || !message.content) continue;
    const text = Array.isArray(message.content)
      ? message.content.map((entry) => entry.text || '').join(' ')
      : String(message.content);
    total += Math.ceil(text.length / 3);
  }
  return total;
}

async function summarizeSession(session, client, modelName, recentMessages) {
  const targetModel = modelName || client.getDefaultModel();
  const summaryPrompt = buildSummaryPrompt(recentMessages);
  const summarySession = new ChatSession(summaryPrompt.system);
  summaryPrompt.messages.forEach((msg) => summarySession.messages.push({ ...msg }));
  const summarizer = new ModelClient(client.config);
  const summaryText = await summarizer.chat(targetModel, summarySession, {
    stream: false,
  });
  const trimmed = (summaryText || '').trim();
  if (!trimmed) {
    return;
  }
  const stamp = new Date().toLocaleString();
  const summaryMessage = `【会话总结 ${stamp}】\n${trimmed}`;
  session.messages.push({
    role: 'system',
    content: summaryMessage,
    name: 'conversation_summary',
  });
}

function buildSummaryPrompt(messages) {
  const history = renderHistoryForSummary(messages);
  const system =
    '你是一名 AI 助理，负责在对话过长前压缩上下文。请在保持关键信息和待办事项的情况下，用简洁中文总结。输出格式：\n1. 对话要点\n2. 待处理事项';
  const userContent = `${history}\n\n请按照上述格式，生成不超过 200 字的总结。`;
  return {
    system,
    messages: [{ role: 'user', content: userContent }],
  };
}

function renderHistoryForSummary(messages, maxChars = 20000) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '（无内容）';
  }
  const collected = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (!entry) continue;
    const role = entry.role || 'unknown';
    const label = role === 'user'
      ? '用户'
      : role === 'assistant'
        ? '助手'
        : role === 'tool'
          ? `工具(${entry.tool_call_id || entry.name || 'tool'})`
          : '系统';
    const text = extractPlainText(entry.content);
    const formatted = `${label}: ${text}`;
    used += formatted.length;
    collected.push(formatted);
    if (used >= maxChars) {
      break;
    }
  }
  return collected.reverse().join('\n\n');
}

function extractPlainText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === 'string' ? item : item?.text || ''))
      .join(' ');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return String(content ?? '');
}
