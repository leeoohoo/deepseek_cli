import OpenAI from 'openai';
import { ModelProvider } from './base.js';

export class OpenAIProvider extends ModelProvider {
  static name = 'openai';

  constructor(settings) {
    super(settings);
    this._client = null;
    this._supportsReasoning = this.#detectReasoningSupport();
  }

  async complete(messages, options = {}) {
    const normalized = this._normalizeMessages(messages);
    const payload = {
      model: this.settings.model,
      messages: normalized,
    };
    if (this.settings.temperature !== null && this.settings.temperature !== undefined) {
      payload.temperature = this.settings.temperature;
    }
    if (
      this.settings.max_output_tokens !== null &&
      this.settings.max_output_tokens !== undefined
    ) {
      payload.max_tokens = this.settings.max_output_tokens;
    }
    if (Array.isArray(options.tools) && options.tools.length > 0) {
      payload.tools = options.tools;
      payload.tool_choice = 'auto';
    }
    Object.assign(payload, this.settings.extra_body || {});

    const client = this.#getClient();
    if (options.stream) {
      return this.#streamResponse(
        client,
        payload,
        options.onToken,
        options.onReasoning,
        options.signal
      );
    }
    return this.#singleResponse(
      client,
      payload,
      options.onToken,
      options.onReasoning,
      options.signal
    );
  }

  #getClient() {
    if (this._client) {
      return this._client;
    }
    const apiKey = this._requireApiKey();
    this._client = new OpenAI({
      apiKey,
      baseURL: this.settings.base_url || undefined,
      defaultHeaders: this.settings.extra_headers || undefined,
    });
    return this._client;
  }

  supportsReasoningContent() {
    return this._supportsReasoning;
  }

  #detectReasoningSupport() {
    const explicit =
      this.settings.reasoning ??
      this.settings.reasoning_mode ??
      this.settings.enable_reasoning ??
      this.settings.supports_reasoning;
    if (explicit !== undefined) {
      return Boolean(explicit);
    }
    const modelId = String(this.settings.model || '').toLowerCase();
    if (!modelId) {
      return false;
    }
    return modelId.includes('reasoner') || modelId.includes('reasoning');
  }

  async #streamResponse(client, payload, onToken, onReasoning, signal) {
    const stream = await client.chat.completions.create(
      { ...payload, stream: true },
      { signal }
    );
    const toolCalls = [];
    let accumulated = '';
    let reasoningBuffer = '';
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        accumulated += delta.content;
        onToken?.(delta.content);
      } else if (Array.isArray(delta.content)) {
        delta.content.forEach((part) => {
          if (typeof part?.text === 'string' && part.text.length > 0) {
            accumulated += part.text;
            onToken?.(part.text);
          }
        });
      }
      if (Array.isArray(delta.tool_calls)) {
        this.#mergeToolCalls(toolCalls, delta.tool_calls);
      }
      const reasoningDelta = this.#extractReasoningText(delta.reasoning_content);
      if (reasoningDelta) {
        reasoningBuffer += reasoningDelta;
        onReasoning?.(reasoningDelta);
      }
    }
    const reasoningText = reasoningBuffer.trim().length > 0 ? reasoningBuffer : '';
    return {
      content: accumulated,
      reasoning: reasoningText || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  async #singleResponse(client, payload, onToken, onReasoning, signal) {
    const response = await client.chat.completions.create(payload, { signal });
    const message = response.choices?.[0]?.message;
    const content = message?.content || '';
    if (content) {
      onToken?.(content);
    }
    const reasoningText = this.#extractReasoningText(message?.reasoning_content);
    if (reasoningText) {
      onReasoning?.(reasoningText);
    }
    return {
      content,
      reasoning: reasoningText || undefined,
      toolCalls: message?.tool_calls || undefined,
    };
  }

  #mergeToolCalls(existing, deltas) {
    for (const delta of deltas) {
      const index = delta.index ?? existing.length;
      const target =
        existing[index] ||
        (existing[index] = {
          id: delta.id || '',
          type: delta.type || 'function',
          function: {
            name: delta.function?.name || '',
            arguments: '',
          },
        });
      if (delta.id) {
        target.id = delta.id;
      }
      if (delta.function?.name) {
        target.function.name = delta.function.name;
      }
      if (delta.function?.arguments) {
        target.function.arguments += delta.function.arguments;
      }
    }
  }

  #extractReasoningText(blocks) {
    if (!blocks) {
      return '';
    }
    if (typeof blocks === 'string') {
      return blocks;
    }
    if (Array.isArray(blocks)) {
      return blocks
        .map((entry) => {
          if (!entry) return '';
          if (typeof entry === 'string') {
            return entry;
          }
          if (typeof entry.text === 'string') {
            return entry.text;
          }
          if (typeof entry.content === 'string') {
            return entry.content;
          }
          return '';
        })
        .join('');
    }
    if (typeof blocks === 'object') {
      if (typeof blocks.text === 'string') {
        return blocks.text;
      }
      if (typeof blocks.content === 'string') {
        return blocks.content;
      }
    }
    return '';
  }
}

