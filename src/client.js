import { ConfigError } from './config.js';
import { createProvider } from './providers/index.js';
import { resolveToolset } from './tools/index.js';

export class ModelClient {
  constructor(config) {
    this.config = config;
    this.providerCache = new Map();
  }

  getModelNames() {
    return Object.keys(this.config.models);
  }

  getDefaultModel() {
    return this.config.getModel(null).name;
  }

  async chat(modelName, session, options = {}) {
    const settings = this.config.getModel(modelName);
    const provider = this.#getOrCreateProvider(settings);
    const toolset = resolveToolset(settings.tools);
    const stream = options.stream !== false;

    const providerOptions = {
      stream,
      tools: toolset.map((tool) => tool.definition),
      onToken: options.onToken,
      onReasoning: options.onReasoning,
      signal: options.signal,
    };

    const maxToolPasses = options.maxToolPasses ?? 60;
    let iteration = 0;
    while (iteration < maxToolPasses) {
      const result = await provider.complete(session.asDicts(), providerOptions);
      const finalText = (result.content ?? '').trim();
      const toolCalls = result.toolCalls || [];
      const reasoningContent =
        typeof result.reasoning === 'string' && result.reasoning.length > 0
          ? result.reasoning
          : undefined;
      const assistantMeta = reasoningContent ? { reasoning_content: reasoningContent } : null;
      if (toolCalls.length > 0) {
        const checkpoint = session.checkpoint();
        session.addAssistant(finalText, toolCalls, assistantMeta);
        try {
          for (const call of toolCalls) {
            const target = toolset.find((tool) => tool.name === call.function?.name);
            if (!target) {
              throw new ConfigError(
                `Tool "${call.function?.name}" is not registered but was requested by the model`
              );
            }
            const argsRaw = call.function?.arguments || '{}';
            const parsedArgs = parseToolArguments(target.name, argsRaw);
            options.onToolCall?.({
              tool: target.name,
              callId: call.id,
              args: parsedArgs,
            });
            const toolResult = await target.handler(parsedArgs, {
              model: settings.name,
              session,
            });
            session.addToolResult(call.id, toolResult);
            options.onToolResult?.({
              tool: target.name,
              callId: call.id,
              result: toolResult,
            });
          }
        } catch (err) {
          session.restore(checkpoint);
          throw err;
        }
        iteration += 1;
        continue;
      }
      session.addAssistant(finalText, null, assistantMeta);
      return finalText;
    }
    throw new Error('Too many consecutive tool calls. Aborting.');
  }

  #getOrCreateProvider(settings) {
    let provider = this.providerCache.get(settings.name);
    if (!provider) {
      provider = createProvider(settings.provider, settings);
      this.providerCache.set(settings.name, provider);
    }
    return provider;
  }
}

function parseToolArguments(toolName, argsRaw) {
  if (!argsRaw || !argsRaw.trim()) {
    return {};
  }
  try {
    return JSON.parse(argsRaw);
  } catch (err) {
    logToolArgumentParseFailure('raw', toolName, argsRaw, err);
    const repaired = repairJsonString(argsRaw);
    if (repaired && repaired !== argsRaw) {
      try {
        return JSON.parse(repaired);
      } catch (err2) {
        logToolArgumentParseFailure('repaired', toolName, repaired, err2);
        throw new Error(
          `Failed to parse arguments for tool ${toolName}: ${err2.message}`
        );
      }
    }
    throw new Error(`Failed to parse arguments for tool ${toolName}: ${err.message}`);
  }
}

function repairJsonString(input) {
  if (!input) {
    return input;
  }
  let output = '';
  let inString = false;
  let escaping = false;
  let stringIsKey = false;
  const contextStack = [];
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (inString) {
      if (escaping) {
        if (isValidJsonEscape(char)) {
          output += `\\${char}`;
        } else if (char === '\n') {
          output += '\\\\n';
        } else if (char === '\r') {
          output += '\\\\r';
        } else if (char) {
          output += `\\\\${char}`;
        } else {
          output += '\\\\';
        }
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '"') {
        const containerType =
          contextStack.length > 0 ? contextStack[contextStack.length - 1].type : null;
        if (stringIsKey || looksLikeValueTerminator(input, i, containerType)) {
          inString = false;
          stringIsKey = false;
          updateObjectKeyState(contextStack, false);
          output += char;
        } else {
          output += '\\"';
        }
        continue;
      }
      if (char === '\n') {
        output += '\\n';
        continue;
      }
      if (char === '\r') {
        output += '\\r';
        continue;
      }
      const code = char.charCodeAt(0);
      if (Number.isFinite(code) && code >= 0 && code <= 0x1f) {
        output += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      output += char;
      continue;
    }
    if (char === '"') {
      inString = true;
      escaping = false;
      stringIsKey = isExpectingKey(contextStack);
      output += char;
      continue;
    }
    if (char === '{') {
      contextStack.push({ type: 'object', expectingKey: true });
      output += char;
      continue;
    }
    if (char === '[') {
      contextStack.push({ type: 'array' });
      output += char;
      continue;
    }
    if (char === '}' || char === ']') {
      contextStack.pop();
      output += char;
      continue;
    }
    if (char === ':') {
      updateObjectKeyState(contextStack, false);
      output += char;
      continue;
    }
    if (char === ',') {
      updateObjectKeyState(contextStack, true);
      output += char;
      continue;
    }
    output += char;
  }
  if (escaping) {
    output += '\\\\';
  }
  if (inString) {
    output += '"';
  }
  return output;
}

function isValidJsonEscape(char) {
  if (!char) {
    return false;
  }
  if ('"\\/bfnrt'.includes(char)) {
    return true;
  }
  if (char === 'u') {
    return true;
  }
  return false;
}

function isExpectingKey(stack) {
  if (!stack || stack.length === 0) {
    return false;
  }
  const top = stack[stack.length - 1];
  return Boolean(top && top.type === 'object' && top.expectingKey);
}

function updateObjectKeyState(stack, expecting) {
  if (!stack || stack.length === 0) {
    return;
  }
  const top = stack[stack.length - 1];
  if (top && top.type === 'object') {
    top.expectingKey = Boolean(expecting);
  }
}

function looksLikeValueTerminator(source, index, containerType) {
  let cursor = index + 1;
  while (cursor < source.length && isWhitespace(source[cursor])) {
    cursor += 1;
  }
  if (cursor >= source.length) {
    return true;
  }
  const next = source[cursor];
  if (next === '}' || next === ']') {
    const following = findNextNonWhitespace(source, cursor + 1);
    if (following === null) {
      return true;
    }
    return following === ',' || following === '}' || following === ']';
  }
  if (next === ',') {
    const token = findNextNonWhitespace(source, cursor + 1);
    if (token === null) {
      return true;
    }
    if (containerType === 'object') {
      return token === '"' || token === '}';
    }
    if (
      containerType === 'array' ||
      containerType === null ||
      containerType === undefined
    ) {
      if (
        token === '"' ||
        token === '{' ||
        token === '[' ||
        token === '}' ||
        token === ']' ||
        token === '-' ||
        token === 't' ||
        token === 'f' ||
        token === 'n' ||
        isDigit(token)
      ) {
        return true;
      }
    }
  }
  return false;
}

function findNextNonWhitespace(source, startIndex) {
  let cursor = startIndex;
  while (cursor < source.length && isWhitespace(source[cursor])) {
    cursor += 1;
  }
  if (cursor >= source.length) {
    return null;
  }
  return source[cursor];
}

function isWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function isDigit(char) {
  return char >= '0' && char <= '9';
}

function logToolArgumentParseFailure(stage, toolName, argsRaw, error) {
  try {
    const snippetLimit = 400;
    const snippet = argsRaw.length > snippetLimit ? `${argsRaw.slice(0, snippetLimit - 3)}...` : argsRaw;
    const singleLine = snippet.replace(/\r?\n/g, '\\n');
    const base64Limit = 20000;
    const base64 = Buffer.from(argsRaw, 'utf8').toString('base64');
    const base64Preview = base64.length > base64Limit ? `${base64.slice(0, base64Limit)}...` : base64;
    console.error(
      `[tool-args:${stage}] Failed to parse arguments for ${toolName}: ${
        error?.message || error
      }. Snippet="${singleLine}" Base64Preview=${base64Preview}`
    );
  } catch {
    // ignore logging errors
  }
}

export const _internal = {
  parseToolArguments,
  repairJsonString,
};
