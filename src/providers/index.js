import { ConfigError } from '../config.js';
import { OpenAIProvider } from './openai.js';

const registry = new Map([[OpenAIProvider.name, OpenAIProvider]]);

export function registerProvider(name, provider) {
  registry.set(name, provider);
}

export function createProvider(providerName, settings) {
  const Provider = registry.get(providerName);
  if (!Provider) {
    const available = Array.from(registry.keys()).sort().join(', ') || '<none>';
    throw new ConfigError(`Unknown provider ${providerName}. Available: ${available}`);
  }
  return new Provider(settings);
}

export function listProviders() {
  return Array.from(registry.keys());
}

