const path = require('path');
const readline = require('readline');
const colors = require('../colors');
const { ConfigError, loadConfig, resolveDefaultConfigPath } = require('../config');
const { expandHomePath } = require('../utils');
const { listTools } = require('../tools');

function createPromptInterface() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (question) =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  return {
    ask,
    close: () => rl.close(),
  };
}

async function runTextStartupWizard(initialOptions = {}) {
  const prompt = createPromptInterface();
  try {
    return await runSetupFlow(prompt.ask, initialOptions, { compact: false });
  } finally {
    prompt.close();
  }
}

async function runTextInlineConfigurator(ask, initialOptions = {}) {
  return runSetupFlow(ask, initialOptions, { compact: true });
}

async function chooseConfig(ask, providedPath) {
  const suggested = providedPath
    ? path.resolve(expandHomePath(providedPath))
    : resolveDefaultConfigPath();
  while (true) {
    const answer = await ask(colors.magenta(`Step 1/4 – Config file path [${suggested}]: `));
    const resolved = path.resolve(expandHomePath(answer || suggested));
    try {
      const config = loadConfig(resolved);
      const modelCount = Object.keys(config.models).length;
      console.log(
        colors.green(`Loaded ${modelCount} model${modelCount === 1 ? '' : 's'} from ${resolved}.`)
      );
      return { config, path: resolved };
    } catch (err) {
      if (err instanceof ConfigError) {
        console.log(colors.yellow(err.message));
        continue;
      }
      throw err;
    }
  }
}

async function chooseModel(ask, config, providedName) {
  const names = Object.keys(config.models);
  if (names.length === 0) {
    throw new ConfigError('No models are defined in the selected configuration.');
  }
  const defaultName = (providedName && config.models[providedName]) || config.defaultModel || names[0];
  while (true) {
    console.log('\nAvailable models:');
    names.forEach((name, idx) => {
      const settings = config.models[name];
      const indicator = name === defaultName ? '*' : ' ';
      console.log(`  [${idx + 1}]${indicator} ${name}  (${settings.provider} / ${settings.model})`);
    });
    const answer = await ask(colors.magenta(`Step 2/4 – Pick a model (name or #) [${defaultName}]: `));
    const selection = answer.trim();
    let choice = defaultName;
    if (selection) {
      if (/^\d+$/.test(selection)) {
        const index = Number(selection) - 1;
        if (index >= 0 && index < names.length) {
          choice = names[index];
        } else {
          console.log(colors.yellow('Invalid selection. Pick a number from the list.'));
          continue;
        }
      } else if (config.models[selection]) {
        choice = selection;
      } else {
        console.log(colors.yellow('Unknown model name. Please try again.'));
        continue;
      }
    }
    const settings = config.models[choice];
    console.log(colors.green(`Selected model: ${choice}`));
    return { name: choice, settings };
  }
}

async function chooseSystemPrompt(ask, settings, override) {
  console.log('\nStep 3/4 – System prompt');
  if (override !== undefined) {
    if (typeof override === 'string' && override.length > 0) {
      console.log(colors.dim(`Current override: ${override}`));
    } else {
      console.log(colors.dim('Current override: <cleared>'));
    }
  } else if (settings.system_prompt) {
    console.log(colors.dim(`Current: ${settings.system_prompt}`));
  } else {
    console.log(colors.dim('Current: <not set>'));
  }
  console.log(
    colors.dim(
      'Enter a new prompt to override, "." to clear, or leave blank to keep the current setting.'
    )
  );
  const answer = await ask('Override value: ');
  if (!answer) {
    return override;
  }
  if (answer === '.') {
    return '';
  }
  return answer;
}

async function chooseStreaming(ask, initialStream) {
  const defaultValue = initialStream !== undefined ? Boolean(initialStream) : true;
  const label = defaultValue ? 'Y/n' : 'y/N';
  while (true) {
    const answer = await ask(
      colors.magenta(`Step 4/4 – Stream responses? (${label}) [${defaultValue ? 'Y' : 'N'}]: `)
    );
    const normalized = answer.trim().toLowerCase();
    if (!normalized) {
      return defaultValue;
    }
    if (['y', 'yes'].includes(normalized)) {
      return true;
    }
    if (['n', 'no'].includes(normalized)) {
      return false;
    }
    console.log(colors.yellow('Please type y or n.'));
  }
}

function printSummary(configPath, modelResult, systemOverride, stream) {
  const summary = [
    '\nConfiguration summary:',
    `- Config: ${configPath}`,
    `- Model: ${modelResult.name} (${modelResult.settings.provider} / ${modelResult.settings.model})`,
    `- System prompt: ${describeSystemPrompt(systemOverride, modelResult.settings)}`,
    `- Streaming: ${stream ? 'enabled' : 'disabled'}`,
    '',
  ];
  console.log(colors.cyan(summary.join('\n')));
}

function describeSystemPrompt(override, settings) {
  if (override !== undefined) {
    if (!override) {
      return 'cleared (no system prompt)';
    }
    return `custom (${truncateText(override)})`;
  }
  if (settings.system_prompt) {
    return `from config (${truncateText(settings.system_prompt)})`;
  }
  return 'not set';
}

function truncateText(value) {
  const str = String(value);
  if (str.length <= 50) {
    return str;
  }
  return `${str.slice(0, 47)}...`;
}

async function runSetupFlow(ask, initialOptions = {}, options = {}) {
  if (typeof ask !== 'function') {
    throw new Error('runSetupFlow requires an ask() helper.');
  }
  const compact = Boolean(options.compact);
  printIntro(compact);
  let defaults = {
    config: initialOptions.config,
    model: initialOptions.model,
    system: initialOptions.system,
    stream: initialOptions.stream,
  };
  while (true) {
    const configResult = await chooseConfig(ask, defaults.config);
    const modelResult = await chooseModel(ask, configResult.config, defaults.model);
    const systemOverride = await chooseSystemPrompt(ask, modelResult.settings, defaults.system);
    const stream = await chooseStreaming(ask, defaults.stream);
    printSummary(configResult.path, modelResult, systemOverride, stream);
    defaults = {
      config: configResult.path,
      model: modelResult.name,
      system: systemOverride,
      stream,
    };
    const confirmPrompt = compact
      ? 'Press Enter to apply changes, type "restart" to run again, or "cancel" to abort: '
      : 'Press Enter to start chatting or type "restart" to reconfigure: ';
    const confirm = (await ask(colors.cyan(confirmPrompt))).toLowerCase();
    if (!confirm || ['y', 'yes', 'start', 'apply'].includes(confirm)) {
      return {
        configPath: configResult.path,
        model: modelResult.name,
        system: systemOverride,
        stream,
      };
    }
    if (['cancel', 'abort', 'exit', 'stop'].includes(confirm)) {
      return null;
    }
  }
}

function printIntro(compact) {
  if (!compact) {
    console.log(colors.cyan('\n=== model-cli setup ==='));
    console.log(
      colors.dim('Follow the guided steps below to choose a config file, model, and chat preferences.\n')
    );
    return;
  }
  console.log(colors.cyan('\n=== Reconfigure session ==='));
  console.log(colors.dim('Update config, model, or streaming preferences without leaving chat.\n'));
}

async function runTextMcpToolsConfigurator(ask, config, modelName) {
  const available = listTools({ detailed: true });
  if (available.length === 0) {
    console.log(colors.yellow('No MCP tools are registered yet.'));
    return null;
  }
  const settings = config.getModel(modelName);
  const active = new Set(settings.tools || []);
  console.log(colors.cyan(`\n=== MCP tools for ${modelName} ===`));
  console.log(
    colors.dim('Toggle tools via their numbers, type "all"/"none", or press Enter to confirm.')
  );
  while (true) {
    printToolChecklist(available, active);
    const answer = (
      await ask(colors.magenta('Selection (comma separated, Enter to finish): '))
    ).trim();
    const normalized = answer.toLowerCase();
    if (!normalized) {
      return Array.from(active);
    }
    if (['cancel', 'abort', 'exit'].includes(normalized)) {
      return null;
    }
    if (normalized === 'all') {
      available.forEach((tool) => active.add(tool.name));
      continue;
    }
    if (['none', 'clear'].includes(normalized)) {
      active.clear();
      continue;
    }
    const tokens = normalized.split(/[,\\s]+/).filter(Boolean);
    let valid = true;
    for (const token of tokens) {
      const index = Number(token) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= available.length) {
        console.log(colors.yellow(`Invalid selection "${token}".`));
        valid = false;
        break;
      }
      const toolName = available[index].name;
      if (active.has(toolName)) {
        active.delete(toolName);
      } else {
        active.add(toolName);
      }
    }
    if (valid) {
      console.log(
        colors.green(`Current selection: ${active.size > 0 ? Array.from(active).join(', ') : '<none>'}`)
      );
    }
  }
}

function printToolChecklist(available, active) {
  console.log('\nRegistered tools:');
  available.forEach((tool, idx) => {
    const marker = active.has(tool.name) ? 'x' : ' ';
    const description = tool.description ? ` – ${tool.description}` : '';
    console.log(`  [${idx + 1}] [${marker}] ${tool.name}${description}`);
  });
  console.log('');
}

async function runTextModelPicker(ask, config, currentModel) {
  const names = Object.keys(config.models);
  if (names.length === 0) {
    console.log(colors.yellow('No models are configured.'));
    return null;
  }
  console.log('\nSelect a model:');
  names.forEach((name, idx) => {
    const settings = config.models[name];
    const indicator = name === currentModel ? '*' : ' ';
    console.log(`  [${idx + 1}]${indicator} ${name} (${settings.provider}/${settings.model})`);
  });
  while (true) {
    const answer = (await ask(colors.magenta('Enter model name or number (Enter to keep current): '))).trim();
    if (!answer) {
      return currentModel;
    }
    if (['cancel', 'exit', 'abort'].includes(answer.toLowerCase())) {
      return null;
    }
    if (/^\d+$/.test(answer)) {
      const index = Number(answer) - 1;
      if (index >= 0 && index < names.length) {
        return names[index];
      }
    } else if (config.models[answer]) {
      return answer;
    }
    console.log(colors.yellow('Invalid selection. Try again or press Enter to keep the current model.'));
  }
}

async function runTextMcpSetup(ask, servers = []) {
  console.log(colors.cyan('\n=== MCP configuration ==='));
  if (servers.length > 0) {
    console.log(colors.dim('Existing MCP servers:'));
    servers.forEach((server, idx) => {
      console.log(
        `  [${idx + 1}] ${server.name || '<unnamed>'} – ${server.url || '<no url>'}`
      );
    });
  } else {
    console.log(colors.dim('No MCP servers defined yet.'));
  }
  console.log(
    colors.dim('Press Enter to create a new MCP server or type the number/name to edit an existing one.')
  );
  let target = null;
  while (true) {
    const answer = (await ask(colors.magenta('Selection (Enter for new): '))).trim();
    if (!answer) {
      break;
    }
    if (['cancel', 'exit', 'abort'].includes(answer.toLowerCase())) {
      return null;
    }
    const matchByIndex = /^\d+$/.test(answer)
      ? servers[Number(answer) - 1]
      : servers.find((server) => server.name === answer);
    if (matchByIndex) {
      target = matchByIndex;
      break;
    }
    console.log(colors.yellow('Invalid selection. Try again or press Enter to create a new entry.'));
  }
  const base = target || { name: '', url: '', api_key_env: '', description: '' };
  const name = await askWithDefault(ask, 'Server name', base.name || '');
  if (!name) {
    console.log(colors.yellow('Name is required.'));
    return null;
  }
  const url = await askWithDefault(ask, 'Endpoint URL or command', base.url || '');
  if (!url) {
    console.log(colors.yellow('URL/command is required.'));
    return null;
  }
  const apiKeyEnv = await askWithDefault(
    ask,
    'API key env variable (optional)',
    base.api_key_env || ''
  );
  const description = await askWithDefault(
    ask,
    'Description (optional)',
    base.description || ''
  );
  const confirm = await askWithDefault(ask, 'Save this MCP entry? (Y/n)', 'y');
  if (confirm.toLowerCase() === 'n' || confirm.toLowerCase() === 'no') {
    console.log(colors.yellow('MCP configuration cancelled.'));
    return null;
  }
  return {
    originalName: target ? target.name : null,
    server: {
      name,
      url,
      api_key_env: apiKeyEnv,
      description,
    },
  };
}

async function askWithDefault(ask, label, existing) {
  const promptLabel = existing ? `${label} [${existing}]` : label;
  const answer = await ask(colors.magenta(`${promptLabel}: `));
  return answer.trim() ? answer.trim() : existing;
}

module.exports = {
  runTextStartupWizard,
  runTextInlineConfigurator,
  runTextMcpToolsConfigurator,
  runTextModelPicker,
  runTextMcpSetup,
};
