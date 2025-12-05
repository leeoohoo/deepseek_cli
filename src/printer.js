const colors = require('./colors');
const { renderMarkdown } = require('./markdown');

function createResponsePrinter(model, streamEnabled, options = {}) {
  let buffer = '';
  let reasoningBuffer = '';
  let reasoningStreamActive = false;
  let reasoningShownInStream = false;
  const streamShowRaw = process.env.MODEL_CLI_STREAM_RAW === '1';
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;
  let previewInterval = null;
  let previewLineActive = false;
  const activeTools = new Map();
  let toolLineVisible = false;
  let toolLineLength = 0;

  // Cool spinner for initial thinking/connecting state
  const coolSpinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const colorsList = [colors.cyan, colors.blue, colors.magenta];
  let coolSpinnerInterval = null;

  const startCoolSpinner = () => {
    if (!streamEnabled || streamShowRaw || coolSpinnerInterval || previewInterval || reasoningShownInStream) {
      return;
    }
    let frameIndex = 0;
    coolSpinnerInterval = setInterval(() => {
      const frame = coolSpinnerFrames[frameIndex % coolSpinnerFrames.length];
      const colorFn = colorsList[Math.floor(frameIndex / 3) % colorsList.length];
      const text = colorFn(` ${frame} AI 正在思考... (按 ESC 取消)`);
      process.stdout.write(`\r\x1b[K${text}`);
      frameIndex++;
    }, 80);
  };

  const stopCoolSpinner = () => {
    if (coolSpinnerInterval) {
      clearInterval(coolSpinnerInterval);
      coolSpinnerInterval = null;
      process.stdout.write('\r\x1b[K'); // Clear line
    }
  };

  const formatActiveTools = () => {
    if (activeTools.size === 0) return '';
    const entries = Array.from(activeTools.entries()).map(([tool, count]) =>
      `${tool}${count > 1 ? `×${count}` : ''}`
    );
    return entries.join(', ');
  };
  const stripAnsi = (value) => value.replace(/\x1b\[[0-9;]*m/g, '');
  const clearToolLine = () => {
    if (!streamEnabled || !toolLineVisible) {
      return;
    }
    const blank = ' '.repeat(toolLineLength);
    process.stdout.write(`\r${blank}\r`);
    toolLineVisible = false;
    toolLineLength = 0;
  };
  const updateToolStatus = () => {
    if (!streamEnabled) return;
    const summary = formatActiveTools();
    if (!summary) {
      clearToolLine();
      return;
    }
    const line = colors.dim(`[tools] ${summary} … (/tool 查看详情)`);
    const plain = stripAnsi(line);
    const padding = toolLineLength > plain.length ? ' '.repeat(toolLineLength - plain.length) : '';
    process.stdout.write(`\r${line}${padding}`);
    toolLineVisible = true;
    toolLineLength = plain.length;
  };
  const noteToolStart = (tool) => {
    activeTools.set(tool, (activeTools.get(tool) || 0) + 1);
    updateToolStatus();
  };
  const noteToolDone = (tool) => {
    if (!activeTools.has(tool)) return;
    const next = activeTools.get(tool) - 1;
    if (next > 0) {
      activeTools.set(tool, next);
    } else {
      activeTools.delete(tool);
    }
    updateToolStatus();
  };
  if (streamEnabled) {
    console.log(colors.magenta(`\n[${model}]`));
    startCoolSpinner(); // Start cool spinner immediately
  }
  const registerToolResult =
    typeof options.registerToolResult === 'function' ? options.registerToolResult : null;
  const ensureReasoningClosed = () => {
    stopCoolSpinner();
    stopPreviewLine();
    if (streamEnabled && reasoningStreamActive) {
      process.stdout.write('\n');
      reasoningStreamActive = false;
    }
  };
  const startPreviewLine = () => {
    stopCoolSpinner(); // Ensure cool spinner is off when preview starts
    if (!streamEnabled || streamShowRaw || previewInterval) {
      return;
    }
    previewInterval = setInterval(() => {
      const frame = spinnerFrames[spinnerIndex % spinnerFrames.length];
      spinnerIndex += 1;
      const previewText = buffer.slice(-80).replace(/\s+/g, ' ');
      const line = colors.dim(`[${frame}] ${previewText || '流式接收中…'}`);
      process.stdout.write(`\r${line}`);
      previewLineActive = true;
    }, 150);
  };
  const stopPreviewLine = () => {
    if (previewInterval) {
      clearInterval(previewInterval);
      previewInterval = null;
    }
    if (previewLineActive) {
      process.stdout.write('\r\x1b[K');
      previewLineActive = false;
    }
  };
  const printReasoningBlock = () => {
    if (!reasoningBuffer) {
      return;
    }
    console.log(colors.dim('\n[thinking]'));
    console.log(colors.dim(reasoningBuffer));
    console.log('');
  };
  const printToolInfo = (text) => {
    if (streamEnabled) {
      stopCoolSpinner();
      ensureReasoningClosed();
      clearToolLine();
    }
    console.log(text);
    updateToolStatus();
  };
  return {
    onToken: (chunk) => {
      if (!chunk) return;
      stopCoolSpinner(); // Stop spinner on first token
      buffer += chunk;
      if (streamEnabled) {
        if (reasoningStreamActive) {
          ensureReasoningClosed();
        }
        if (streamShowRaw) {
          process.stdout.write(chunk);
        } else {
          startPreviewLine();
        }
      }
    },
    onReasoning: (chunk) => {
      if (!chunk) return;
      stopCoolSpinner();
      reasoningBuffer += chunk;
      if (streamEnabled) {
        stopPreviewLine();
        reasoningShownInStream = true;
        if (!reasoningStreamActive) {
          reasoningStreamActive = true;
          process.stdout.write(colors.dim('\n[thinking]\n'));
        }
        process.stdout.write(colors.dim(chunk));
      }
    },
    onToolCall: ({ tool }) => {
      stopCoolSpinner(); // Stop spinner when tool starts
      stopPreviewLine();
      if (streamEnabled && reasoningStreamActive) {
        ensureReasoningClosed();
      }
      noteToolStart(tool);
    },
    onToolResult: ({ tool, result }) => {
      const normalized = formatToolResult(result);
      let storedContent = normalized;
      let hint = colors.dim('执行完成，使用 /tool 查看输出。');
      if (shouldHideToolResult(tool)) {
        const summary = formatHiddenToolSummary(normalized);
        storedContent = summary.historyText;
        hint = colors.dim(summary.preview);
      }
      const entryId = registerToolResult ? registerToolResult(tool, storedContent) : null;
      const label = colors.green(`↳ ${tool}`);
      const suffix = entryId ? `${hint} ${colors.dim(`(/tool ${entryId})`)}` : hint;
      printToolInfo(`${label} ${suffix}`);
      noteToolDone(tool);
    },
    onComplete: (finalText) => {
      stopCoolSpinner();
      stopPreviewLine();
      if (streamEnabled) {
        ensureReasoningClosed();
        clearToolLine();
        const formattedSource = finalText || buffer;
        if (formattedSource) {
          console.log(renderMarkdown(formattedSource));
          console.log('');
        }
      }
      if (reasoningBuffer && (!streamEnabled || !reasoningShownInStream)) {
        printReasoningBlock();
      }
      if (streamEnabled) {
        if (!buffer && !finalText) {
          process.stdout.write(colors.dim('[no text]'));
        }
        process.stdout.write('\n');
      } else {
        const output = finalText || buffer || colors.dim('[no text]');
        printResponse(model, output);
      }
    },
  };
}

function printResponse(model, text) {
  const border = '-'.repeat(Math.min(60, Math.max(10, model.length + 4)));
  const formatted = renderMarkdown(text || '');
  console.log(`\n${colors.magenta(`[${model}]`)}\n${border}\n${formatted}\n`);
}

function formatToolResult(result) {
  if (typeof result === 'string') {
    return result;
  }
  if (result === null || result === undefined) {
    return '';
  }
  if (typeof result === 'object') {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

function shouldHideToolResult(toolName) {
  if (!toolName) {
    return false;
  }
  const normalized = String(toolName).toLowerCase();
  return /(^|_)search(_|$)/.test(normalized);
}

function formatHiddenToolSummary(originalText) {
  const files = extractSearchFiles(originalText);
  if (files.length === 0) {
    const message = '搜索命中内容已隐藏（未识别到具体文件）。';
    return {
      preview: message,
      historyText: `${message}\n原始搜索结果未在终端显示。`,
    };
  }
  const formatted = files.map((file) => `  - ${file}`).join('\n');
  const preview = `搜索命中内容已隐藏，仅记录涉及文件：\n${formatted}`;
  return {
    preview,
    historyText: `${preview}\n原始搜索结果未在终端显示。`,
  };
}

function extractSearchFiles(text) {
  if (!text) {
    return [];
  }
  const seen = new Set();
  const lines = text.split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[')) {
      return;
    }
    const match = trimmed.match(/^([^:\s][^:]*)\s*:(\d+)/);
    if (match && match[1]) {
      const file = match[1].trim();
      if (file && !seen.has(file)) {
        seen.add(file);
      }
    }
  });
  return Array.from(seen);
}

module.exports = {
  createResponsePrinter,
};
