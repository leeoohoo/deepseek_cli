class ChatSession {
  constructor(systemPrompt = null) {
    this.systemPrompt = null;
    this.messages = [];
    this.reset(systemPrompt);
  }

  addUser(content) {
    this.messages.push({ role: 'user', content: String(content) });
  }

  addAssistant(content, toolCalls = null, metadata = null) {
    const payload = { role: 'assistant', content: String(content ?? '') };
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      payload.tool_calls = toolCalls;
    }
    if (
      metadata &&
      Object.prototype.hasOwnProperty.call(metadata, 'reasoning_content') &&
      typeof metadata.reasoning_content === 'string'
    ) {
      payload.reasoning_content = metadata.reasoning_content;
    }
    this.messages.push(payload);
  }

  addToolResult(toolCallId, content) {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: String(content ?? ''),
    });
  }

  popLast() {
    if (this.messages.length > 0) {
      this.messages.pop();
    }
  }

  reset(systemPrompt = undefined) {
    if (systemPrompt !== undefined) {
      if (typeof systemPrompt === 'string') {
        this.systemPrompt = systemPrompt.length > 0 ? systemPrompt : null;
      } else if (systemPrompt === null) {
        this.systemPrompt = null;
      } else {
        const normalized = String(systemPrompt);
        this.systemPrompt = normalized.length > 0 ? normalized : null;
      }
    }
    this.messages = [];
    if (typeof this.systemPrompt === 'string' && this.systemPrompt.length > 0) {
      this.messages.push({ role: 'system', content: this.systemPrompt });
    }
  }

  asDicts() {
    return this.messages.map((message) => ({ ...message }));
  }

  checkpoint() {
    return this.messages.length;
  }

  restore(length) {
    if (typeof length !== 'number') {
      return;
    }
    this.messages.length = Math.max(0, length);
  }
}

module.exports = { ChatSession };
