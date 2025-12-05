import { ConfigError } from '../config.js';

const registry = new Map();

export function registerTool(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new Error('Tool definition must be an object');
  }
  const { name, description, parameters, handler } = definition;
  if (!name || typeof name !== 'string') {
    throw new Error('Tool definition requires a string name');
  }
  if (typeof handler !== 'function') {
    throw new Error(`Tool "${name}" must include a handler function`);
  }
  registry.set(name, {
    name,
    description: description || '',
    parameters:
      parameters && typeof parameters === 'object'
        ? parameters
        : { type: 'object', properties: {} },
    handler,
  });
}

export function resolveToolset(names = []) {
  if (!names || names.length === 0) {
    return [];
  }
  return names.map((name) => {
    const entry = registry.get(name);
    if (!entry) {
      throw new ConfigError(
        `Tool "${name}" is not registered. Define it under node_cli/src/tools before enabling it in your models.`
      );
    }
    return {
      name: entry.name,
      definition: {
        type: 'function',
        function: {
          name: entry.name,
          description: entry.description,
          parameters: entry.parameters,
        },
      },
      handler: entry.handler,
    };
  });
}

export function listTools(options = {}) {
  if (options.detailed) {
    return Array.from(registry.values()).map((entry) => ({
      name: entry.name,
      description: entry.description || '',
      parameters: entry.parameters || { type: 'object', properties: {} },
    }));
  }
  return Array.from(registry.keys());
}

