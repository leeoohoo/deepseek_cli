const { ConfigError } = require('../config');

class ModelProvider {
  constructor(settings) {
    this.settings = settings;
  }

  // To be implemented by subclasses.
  // eslint-disable-next-line class-methods-use-this
  async complete() {
    throw new Error('Not implemented');
  }

  _requireApiKey() {
    const envName = this.settings.api_key_env;
    if (!envName) {
      throw new ConfigError(
        `Provider ${this.settings.provider} for model ${this.settings.name} requires api_key_env`
      );
    }
    const value = process.env[envName];
    if (!value) {
      throw new ConfigError(
        `Environment variable ${envName} is not set but is required for model ${this.settings.name}`
      );
    }
    return value;
  }

  _normalizeMessages(messages) {
    const includeReasoning = this.supportsReasoningContent();
    const normalized = [];
    for (const message of messages) {
      const { role } = message;
      if (!role) {
        throw new ConfigError(
          `Messages must include a role; invalid entry for model ${this.settings.name}`
        );
      }
      const normalizedEntry = { role };
      if (message.content !== undefined) {
        normalizedEntry.content = String(message.content ?? '');
      }
      if (message.tool_call_id) {
        normalizedEntry.tool_call_id = message.tool_call_id;
      }
      if (Array.isArray(message.tool_calls)) {
        normalizedEntry.tool_calls = message.tool_calls;
      }
      if (
        includeReasoning &&
        typeof message.reasoning_content === 'string' &&
        message.reasoning_content.length > 0
      ) {
        normalizedEntry.reasoning_content = message.reasoning_content;
      }
      normalized.push(normalizedEntry);
    }
    return normalized;
  }

  // eslint-disable-next-line class-methods-use-this
  supportsReasoningContent() {
    return false;
  }
}

module.exports = { ModelProvider };
