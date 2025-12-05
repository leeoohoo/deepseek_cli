const fs = require('fs');
const path = require('path');
const colors = require('./colors');
const { ChatSession } = require('./session');
const { createResponsePrinter } = require('./printer');
const { runModelPicker, runMcpSetup, runMcpToolsConfigurator } = require('./ui');
const { loadMcpConfig, saveMcpConfig } = require('./mcp');
const { expandHomePath } = require('./utils');
const { selectAgent } = require('./subagents/selector');
const { renderMarkdown } = require('./markdown');
const { DEFAULT_SYSTEM_PROMPT } = require('./prompts');

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
      if (typeof target.content === 'string') {
        console.log(renderMarkdown(target.content));
      } else {
        console.log(JSON.stringify(target.content, null, 2));
      }
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

module.exports = {
  handleCommand,
  handleSlashCommand,
  maybeHandleAutoSubagentRequest,
  resolveSystemPrompt,
  executeSubAgentTask,
};
