const readline = require('readline');
const colors = require('./colors');
const { ChatSession } = require('./session');
const { ModelClient } = require('./client');
const { createSubAgentManager } = require('./subagents');
const { setSubAgentContext } = require('./subagents/runtime');
const { createResponsePrinter } = require('./printer');
const {
  handleCommand,
  handleSlashCommand,
  maybeHandleAutoSubagentRequest,
  resolveSystemPrompt,
} = require('./commands');
const { DEFAULT_SYSTEM_PROMPT } = require('./prompts');

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
      toolHistory,
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
      } else if (slashResult?.type === 'tools-updated') {
        // Tools updated, no session reset needed usually, but context might need refresh if we cache anything
        // For now just continue
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

      const controller = new AbortController();
      const { signal } = controller;
      const wasRaw = process.stdin.isRaw;
      const keyHandler = (ch, key) => {
        if (key && key.name === 'escape') {
          if (!signal.aborted) {
            process.stdout.write(colors.yellow('\n(已中止)\n'));
            controller.abort();
          }
        }
      };
      if (process.stdin.isTTY) {
        process.stdin.on('keypress', keyHandler);
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }

      let finalText;
      try {
        finalText = await client.chat(currentModel, session, {
          stream: streamResponses,
          onToken: printer.onToken,
          onReasoning: printer.onReasoning,
          onToolCall: printer.onToolCall,
          onToolResult: printer.onToolResult,
          signal,
        });
      } finally {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(wasRaw);
          process.stdin.removeListener('keypress', keyHandler);
        }
      }

      summaryManager.maybeSummarize(session, client, currentModel);
      printer.onComplete(finalText);
    } catch (err) {
      session.popLast();
      if (err.name === 'AbortError' || err.message.includes('aborted')) {
        console.log(colors.yellow('对话已由用户中止。'));
      } else {
        console.error(colors.yellow(`Request failed: ${err.message}`));
      }
    }
  }
  rl.close();
  setSubAgentContext(null);
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

module.exports = {
  chatLoop,
  DEFAULT_SYSTEM_PROMPT,
};
