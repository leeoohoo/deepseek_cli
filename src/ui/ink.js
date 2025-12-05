import path from 'path';
import React from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { ConfigError, loadConfig, resolveDefaultConfigPath } from '../config.js';
import { expandHomePath } from '../utils.js';
import { listTools } from '../tools/index.js';

const h = React.createElement;

export function isInkSupported() {
  return (
    !process.env.MODEL_CLI_DISABLE_INK &&
    process.stdout &&
    process.stdout.isTTY &&
    process.stdin &&
    process.stdin.isTTY
  );
}

export function runInkStartupWizard(initialOptions = {}) {
  return renderInkApp(WizardApp, { initialOptions, compact: false });
}

export function runInkInlineConfigurator(initialOptions = {}, control = {}) {
  return renderInkApp(WizardApp, { initialOptions, compact: true }, control);
}

export function runInkMcpToolsConfigurator(config, modelName, control = {}) {
  const available = listTools({ detailed: true });
  if (!isInkSupported() || available.length === 0) {
    return undefined;
  }
  const settings = config.getModel(modelName);
  const initial = Array.isArray(settings.tools) ? settings.tools : [];
  return renderInkApp(
    ToolConfiguratorApp,
    { modelName, available, initialSelection: initial },
    control
  );
}

export function runInkModelPicker(config, currentModel, control = {}) {
  if (!isInkSupported()) {
    return undefined;
  }
  const names = Object.keys(config.models || {});
  if (names.length === 0) {
    return undefined;
  }
  const items = names.map((name) => {
    const settings = config.models[name];
    return {
      label: `${name} (${settings.provider}/${settings.model})`,
      value: name,
    };
  });
  const initialIndex = Math.max(
    0,
    Math.min(
      items.length - 1,
      items.findIndex((item) => item.value === currentModel)
    )
  );
  return renderInkApp(
    ModelPickerApp,
    { items, initialIndex },
    control
  );
}

export function runInkMcpSetupWizard(servers = [], control = {}) {
  if (!isInkSupported()) {
    return undefined;
  }
  return renderInkApp(
    McpWizardApp,
    { servers },
    control
  );
}

function renderInkApp(Component, props = {}, control = {}) {
  if (!isInkSupported()) {
    return undefined;
  }
  const { pause, resume } = control;
  if (typeof pause === 'function') {
    pause();
  }
  return new Promise((resolve) => {
    let instance;
    let settled = false;
    const finalize = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      if (instance) {
        instance.unmount();
      }
      if (typeof resume === 'function') {
        resume();
      }
    };
    instance = render(
      h(Component, {
        ...props,
        onSubmit: (result) => finalize(result),
        onCancel: () => finalize(null),
      }),
      { exitOnCtrlC: false }
    );
    instance.waitUntilExit().catch(() => finalize(null));
  });
}

function WizardApp({ initialOptions = {}, compact = false, onSubmit, onCancel }) {
  const { exit } = useApp();
  const [step, setStep] = React.useState('config');
  const [configState, setConfigState] = React.useState(() => ({
    path: initialOptions.config
      ? path.resolve(expandHomePath(initialOptions.config))
      : resolveDefaultConfigPath(),
    config: null,
    error: null,
  }));
  const [modelName, setModelName] = React.useState(initialOptions.model || null);
  const [systemOverride, setSystemOverride] = React.useState(
    initialOptions.system !== undefined ? initialOptions.system : undefined
  );
  const [stream, setStream] = React.useState(
    initialOptions.stream !== undefined ? Boolean(initialOptions.stream) : true
  );

  const models = configState.config ? Object.keys(configState.config.models) : [];
  const heading = compact ? 'Reconfigure session' : 'model-cli setup';
  const description = compact
    ? 'Update config, model, or streaming preferences (ESC to cancel).'
    : 'Follow the guided steps below to configure the chat session. Press ESC to cancel.';

  const handleCancel = () => {
    onCancel();
    exit();
  };

  const handleFinish = (result) => {
    onSubmit(result);
    exit();
  };

  const handleConfigSubmit = (rawValue) => {
    const candidate = rawValue || configState.path || resolveDefaultConfigPath();
    const resolved = path.resolve(expandHomePath(candidate));
    try {
      const config = loadConfig(resolved);
      const keys = Object.keys(config.models);
      if (keys.length === 0) {
        throw new ConfigError('No models defined in this config file.');
      }
      const nextModel =
        (modelName && config.models[modelName]) || config.defaultModel || keys[0];
      setConfigState({ path: resolved, config, error: null });
      setModelName(nextModel);
      setStep('model');
    } catch (err) {
      setConfigState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const handleModelSubmit = (item) => {
    setModelName(item.value);
    setStep('system');
  };

  const handleSystemSubmit = (value) => {
    if (value === '.') {
      setSystemOverride('');
    } else if (value === '') {
      setSystemOverride(undefined);
    } else {
      setSystemOverride(value);
    }
    setStep('stream');
  };

  const handleStreamSubmit = (choice) => {
    setStream(Boolean(choice.value));
    setStep('summary');
  };

  const handleSummaryAction = (action) => {
    switch (action) {
      case 'back':
        setStep('stream');
        break;
      case 'restart':
        setStep('config');
        break;
      case 'cancel':
        handleCancel();
        break;
      case 'confirm':
        handleFinish({
          configPath: configState.path,
          model: modelName,
          system: systemOverride,
          stream,
        });
        break;
      default:
        break;
    }
  };

  let content = null;
  if (step === 'config') {
    content = h(TextPrompt, {
      key: 'config-step',
      title: 'Step 1/4 – Config file path',
      description: 'Type a models.yaml path or press Enter to accept the suggested file.',
      value: configState.path,
      onSubmit: handleConfigSubmit,
      onCancel: handleCancel,
      error: configState.error,
    });
  } else if (step === 'model' && configState.config) {
    const items = models.map((name) => {
      const settings = configState.config.models[name];
      return {
        label: `${name} (${settings.provider}/${settings.model})`,
        value: name,
      };
    });
    const initialIndex = Math.max(
      0,
      Math.min(
        items.length - 1,
        items.findIndex((item) => item.value === modelName)
      )
    );
    content = h(SelectPrompt, {
      key: 'model-step',
      title: 'Step 2/4 – Select a model',
      items,
      initialIndex,
      instructions: 'Use ↑/↓ to highlight a model, Enter to continue, ESC/backspace to return.',
      onSubmit: handleModelSubmit,
      onCancel: () => setStep('config'),
    });
  } else if (step === 'system' && configState.config) {
    const currentModel = configState.config.models[modelName];
    const currentPrompt = currentModel?.system_prompt || '<not set>';
    const overrideText =
      systemOverride === undefined
        ? 'Using configuration prompt (leave blank).'
        : systemOverride === ''
          ? 'System prompt will be cleared.'
          : `Override: ${systemOverride}`;
    content = h(TextPrompt, {
      key: 'system-step',
      title: 'Step 3/4 – System prompt',
      description: `${overrideText}\nEnter text to override, "." to clear, or leave blank to keep the config value (${currentPrompt}).`,
      value: typeof systemOverride === 'string' ? systemOverride : '',
      onSubmit: handleSystemSubmit,
      onCancel: () => setStep('model'),
    });
  } else if (step === 'stream') {
    const items = [
      { label: 'Enable streaming (recommended)', value: true },
      { label: 'Disable streaming', value: false },
    ];
    const initialIndex = stream ? 0 : 1;
    content = h(SelectPrompt, {
      key: 'stream-step',
      title: 'Step 4/4 – Stream responses?',
      items,
      initialIndex,
      instructions: 'Use ↑/↓ to choose, Enter to confirm, ESC to go back.',
      onSubmit: handleStreamSubmit,
      onCancel: () => setStep('system'),
    });
  } else if (step === 'summary' && configState.config) {
    content = h(SummaryStep, {
      key: 'summary-step',
      configPath: configState.path,
      settings: configState.config.models[modelName],
      systemOverride,
      stream,
      onAction: handleSummaryAction,
    });
  }

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { color: 'cyan', bold: true }, `\n=== ${heading} ===`),
    h(Text, { color: 'gray' }, description),
    content
  );
}

function TextPrompt({ title, description, value, onSubmit, onCancel, error }) {
  const [inputValue, setInputValue] = React.useState(value || '');
  React.useEffect(() => {
    setInputValue(value || '');
  }, [value]);
  useInput((input, key) => {
    if (key.return) {
      onSubmit(inputValue.trim());
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.backspace || key.delete) {
      setInputValue((prev) => prev.slice(0, -1));
      return;
    }
    if (key.ctrl && input === 'c') {
      onCancel();
      return;
    }
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      return;
    }
    if (input) {
      setInputValue((prev) => prev + input);
    }
  });
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { bold: true }, title),
    description ? h(Text, { color: 'gray' }, description) : null,
    h(Text, { color: 'cyan' }, inputValue || ''),
    error ? h(Text, { color: 'red' }, `✖ ${error}`) : null
  );
}

function SelectPrompt({
  title,
  items,
  initialIndex = 0,
  instructions,
  onSubmit,
  onCancel,
}) {
  const [index, setIndex] = React.useState(
    Math.max(0, Math.min(items.length - 1, initialIndex))
  );
  useInput((input, key) => {
    if (key.escape || key.backspace || (key.ctrl && input === 'c')) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setIndex((prev) => (prev - 1 + items.length) % items.length);
      return;
    }
    if (key.downArrow) {
      setIndex((prev) => (prev + 1) % items.length);
      return;
    }
    if (key.return) {
      onSubmit(items[index]);
    }
  });
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { bold: true }, title),
    instructions ? h(Text, { color: 'gray' }, instructions) : null,
    ...items.map((item, idx) =>
      h(
        Text,
        {
          key: item.value,
          color: idx === index ? 'green' : undefined,
        },
        `${idx === index ? '›' : ' '} ${item.label}`
      )
    )
  );
}

function SummaryStep({ configPath, settings, systemOverride, stream, onAction }) {
  const summaryEntries = [
    ['Config', configPath],
    ['Model', `${settings.name || ''} (${settings.provider}/${settings.model})`],
    ['System prompt', summarizePrompt(systemOverride, settings.system_prompt)],
    ['Streaming', stream ? 'enabled' : 'disabled'],
  ];
  useInput((input, key) => {
    if (key.return) {
      onAction('confirm');
      return;
    }
    if (key.escape || (key.ctrl && input === 'c')) {
      onAction('cancel');
      return;
    }
    if (input && input.toLowerCase() === 'r') {
      onAction('restart');
      return;
    }
    if (input && input.toLowerCase() === 'b') {
      onAction('back');
    }
  });
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { bold: true }, 'Summary'),
    summaryEntries.map(([label, value]) =>
      h(
        Text,
        { key: label },
        `${label}: ${value}`
      )
    ),
    h(
      Text,
      { color: 'gray' },
      'Press Enter to confirm, "r" to restart, "b" to adjust streaming, or ESC to cancel.'
    )
  );
}

function summarizePrompt(override, basePrompt) {
  if (override !== undefined) {
    if (!override) {
      return 'cleared (no system prompt)';
    }
    return truncate(override);
  }
  if (basePrompt) {
    return `${truncate(basePrompt)} (from config)`;
  }
  return '<not set>';
}

function truncate(value) {
  const text = String(value);
  return text.length > 50 ? `${text.slice(0, 47)}...` : text;
}

function ToolConfiguratorApp({ modelName, available, initialSelection, onSubmit, onCancel }) {
  const { exit } = useApp();
  const [cursor, setCursor] = React.useState(0);
  const [selected, setSelected] = React.useState(new Set(initialSelection));
  const toggleSelection = (name) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };
  const handleComplete = () => {
    onSubmit(Array.from(selected));
    exit();
  };
  const handleCancel = () => {
    onCancel();
    exit();
  };
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      handleCancel();
      return;
    }
    if (key.upArrow) {
      setCursor((prev) => (prev - 1 + available.length) % available.length);
      return;
    }
    if (key.downArrow) {
      setCursor((prev) => (prev + 1) % available.length);
      return;
    }
    if (key.return) {
      handleComplete();
      return;
    }
    if (input === ' ') {
      toggleSelection(available[cursor].name);
      return;
    }
    if (input && input.toLowerCase() === 'a') {
      setSelected(new Set(available.map((tool) => tool.name)));
      return;
    }
    if (input && ['n', 'c'].includes(input.toLowerCase())) {
      setSelected(new Set());
    }
  });
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { color: 'cyan', bold: true }, `\n=== MCP tools for ${modelName} ===`),
    h(
      Text,
      { color: 'gray' },
      'Use ↑/↓ to navigate, space to toggle, "a" to select all, "n" to clear. Enter to confirm, ESC to cancel.'
    ),
    available.map((tool, idx) => {
      const active = selected.has(tool.name);
      const highlight = idx === cursor;
      return h(
        Text,
        {
          key: tool.name,
          color: highlight ? 'green' : undefined,
        },
        `${highlight ? '›' : ' '} [${active ? 'x' : ' '}] ${tool.name}${
          tool.description ? ` – ${tool.description}` : ''
        }`
      );
    }),
    h(
      Text,
      { color: 'gray' },
      selected.size > 0
        ? `Selected: ${Array.from(selected).join(', ')}`
        : 'Selected: <none>'
    )
  );
}

function ModelPickerApp({ items, initialIndex, onSubmit, onCancel }) {
  const { exit } = useApp();
  const handleChoice = (choice) => {
    onSubmit(choice.value);
    exit();
  };
  const handleCancel = () => {
    onCancel();
    exit();
  };
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { color: 'cyan', bold: true }, '\n=== Select a model ==='),
    h(Text, { color: 'gray' }, 'Use ↑/↓ to highlight, Enter to confirm, ESC to cancel.'),
    h(SelectPrompt, {
      title: '',
      items,
      initialIndex,
      instructions: null,
      onSubmit: handleChoice,
      onCancel: handleCancel,
    })
  );
}

function McpWizardApp({ servers = [], onSubmit, onCancel }) {
  const { exit } = useApp();
  const [step, setStep] = React.useState('select');
  const [form, setForm] = React.useState({
    name: '',
    url: '',
    api_key_env: '',
    description: '',
  });
  const [originalName, setOriginalName] = React.useState(null);
  const [errors, setErrors] = React.useState({});
  const selectionItems = [
    ...servers.map((server, index) => ({
      label: `${server.name || '<unnamed>'} – ${server.url || '<no url>'}`,
      value: { type: 'existing', index },
    })),
    { label: '+ Create new MCP entry', value: { type: 'new' } },
  ];
  const initialIndex =
    servers.length > 0 ? 0 : selectionItems.length - 1;

  const handleCancel = () => {
    onCancel();
    exit();
  };

  const handleSelection = (choice) => {
    if (choice.value.type === 'existing') {
      const target = servers[choice.value.index];
      setForm({
        name: target.name || '',
        url: target.url || '',
        api_key_env: target.api_key_env || '',
        description: target.description || '',
      });
      setOriginalName(target.name || null);
    } else {
      setForm({
        name: '',
        url: '',
        api_key_env: '',
        description: '',
      });
      setOriginalName(null);
    }
    setStep('name');
  };

  const handleNameSubmit = (value) => {
    if (!value.trim()) {
      setErrors((prev) => ({ ...prev, name: 'Name is required.' }));
      return;
    }
    setErrors((prev) => ({ ...prev, name: null }));
    setForm((prev) => ({ ...prev, name: value.trim() }));
    setStep('url');
  };

  const handleUrlSubmit = (value) => {
    if (!value.trim()) {
      setErrors((prev) => ({ ...prev, url: 'Endpoint is required.' }));
      return;
    }
    setErrors((prev) => ({ ...prev, url: null }));
    setForm((prev) => ({ ...prev, url: value.trim() }));
    setStep('apiKey');
  };

  const handleApiKeySubmit = (value) => {
    setForm((prev) => ({ ...prev, api_key_env: value.trim() }));
    setStep('description');
  };

  const handleDescriptionSubmit = (value) => {
    setForm((prev) => ({ ...prev, description: value }));
    setStep('summary');
  };

  const handleSummaryAction = (action) => {
    switch (action) {
      case 'back':
        setStep('description');
        break;
      case 'restart':
        setStep('select');
        break;
      case 'cancel':
        handleCancel();
        break;
      case 'confirm':
        onSubmit({
          originalName,
          server: form,
        });
        exit();
        break;
      default:
        break;
    }
  };

  let content = null;
  if (step === 'select') {
    content = h(SelectPrompt, {
      title: 'Pick an entry to edit or create a new MCP server',
      items: selectionItems,
      initialIndex,
      instructions: 'Use ↑/↓ to choose, Enter to continue, ESC to cancel.',
      onSubmit: handleSelection,
      onCancel: handleCancel,
    });
  } else if (step === 'name') {
    content = h(TextPrompt, {
      title: 'Server name (unique identifier)',
      value: form.name,
      error: errors.name,
      onSubmit: handleNameSubmit,
      onCancel: () => setStep('select'),
    });
  } else if (step === 'url') {
    content = h(TextPrompt, {
      title: 'Endpoint URL or command',
      description: 'Example: https://example.com/mcp or `node ./server.js`',
      value: form.url,
      error: errors.url,
      onSubmit: handleUrlSubmit,
      onCancel: () => setStep('name'),
    });
  } else if (step === 'apiKey') {
    content = h(TextPrompt, {
      title: 'API key env variable (optional)',
      description: 'Leave blank if not required.',
      value: form.api_key_env,
      onSubmit: handleApiKeySubmit,
      onCancel: () => setStep('url'),
    });
  } else if (step === 'description') {
    content = h(TextPrompt, {
      title: 'Description (optional)',
      value: form.description,
      onSubmit: handleDescriptionSubmit,
      onCancel: () => setStep('apiKey'),
    });
  } else if (step === 'summary') {
    content = h(McpSummaryStep, {
      form,
      onAction: handleSummaryAction,
    });
  }

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { color: 'cyan', bold: true }, '\n=== MCP setup ==='),
    h(
      Text,
      { color: 'gray' },
      'Configure Model Context Protocol connections for remote tools.'
    ),
    content
  );
}

function McpSummaryStep({ form, onAction }) {
  useInput((input, key) => {
    if (key.return) {
      onAction('confirm');
      return;
    }
    if (key.escape || (key.ctrl && input === 'c')) {
      onAction('cancel');
      return;
    }
    if (input && input.toLowerCase() === 'r') {
      onAction('restart');
      return;
    }
    if (input && input.toLowerCase() === 'b') {
      onAction('back');
    }
  });
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { bold: true }, 'Summary'),
    h(Text, null, `Name: ${form.name || '<none>'}`),
    h(Text, null, `Endpoint: ${form.url || '<none>'}`),
    h(Text, null, `API key env: ${form.api_key_env || '<none>'}`),
    h(Text, null, `Description: ${form.description || '<none>'}`),
    h(
      Text,
      { color: 'gray' },
      'Press Enter to confirm, "r" to restart, "b" to adjust streaming, or ESC to cancel.'
    )
  );
}
