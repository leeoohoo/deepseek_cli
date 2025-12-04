const { ConfigError } = require('../config');
const { OpenAIProvider } = require('./openai');

const registry = new Map([[OpenAIProvider.name, OpenAIProvider]]);

function registerProvider(name, provider) {
  registry.set(name, provider);
}

function createProvider(providerName, settings) {
  const Provider = registry.get(providerName);
  if (!Provider) {
    const available = Array.from(registry.keys()).sort().join(', ') || '<none>';
    throw new ConfigError(`Unknown provider ${providerName}. Available: ${available}`);
  }
  return new Provider(settings);
}

function listProviders() {
  return Array.from(registry.keys());
}

module.exports = {
  createProvider,
  listProviders,
  registerProvider,
};
