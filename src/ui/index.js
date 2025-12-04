const textUi = require('./text');

let inkUi = null;
try {
  // eslint-disable-next-line global-require
  inkUi = require('./ink');
} catch {
  inkUi = null;
}

function inkAvailable() {
  return Boolean(inkUi && inkUi.isInkSupported());
}

async function tryInk(fn) {
  if (!inkAvailable()) {
    return undefined;
  }
  try {
    return await fn();
  } catch (err) {
    if (process.env.MODEL_CLI_DEBUG_UI) {
      console.error('[model-cli] Ink UI failed, falling back to text UI:', err.message);
    }
    return undefined;
  }
}

async function runStartupWizard(initialOptions = {}) {
  const result = await tryInk(() => inkUi.runInkStartupWizard(initialOptions));
  if (result !== undefined) {
    return result;
  }
  return textUi.runTextStartupWizard(initialOptions);
}

async function runInlineConfigurator(ask, initialOptions = {}, control = {}) {
  const result = await tryInk(() =>
    inkUi.runInkInlineConfigurator(initialOptions, control)
  );
  if (result !== undefined) {
    return result;
  }
  return textUi.runTextInlineConfigurator(ask, initialOptions);
}

async function runMcpToolsConfigurator(ask, config, modelName, control = {}) {
  const result = await tryInk(() =>
    inkUi.runInkMcpToolsConfigurator(config, modelName, control)
  );
  if (result !== undefined) {
    return result;
  }
  return textUi.runTextMcpToolsConfigurator(ask, config, modelName);
}

async function runModelPicker(ask, config, currentModel, control = {}) {
  const result = await tryInk(() =>
    inkUi.runInkModelPicker(config, currentModel, control)
  );
  if (result !== undefined) {
    return result;
  }
  return textUi.runTextModelPicker(ask, config, currentModel);
}

async function runMcpSetup(ask, servers = [], control = {}) {
  const result = await tryInk(() =>
    inkUi.runInkMcpSetupWizard(servers, control)
  );
  if (result !== undefined) {
    return result;
  }
  return textUi.runTextMcpSetup(ask, servers);
}

module.exports = {
  runStartupWizard,
  runInlineConfigurator,
  runMcpToolsConfigurator,
  runModelPicker,
  runMcpSetup,
};
