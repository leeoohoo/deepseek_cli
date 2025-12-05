const colors = require('./colors');

function renderMarkdown(input) {
  if (!input) {
    return '';
  }
  const lines = [];
  const rawLines = String(input).replace(/\r\n/g, '\n').split('\n');
  let inCodeBlock = false;
  let codeFence = '';
  rawLines.forEach((originalLine) => {
    const line = originalLine.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFence = trimmed.slice(3).trim();
        const label = codeFence ? ` code (${codeFence})` : ' code';
        lines.push(colors.dim(`┌────${label}`));
      } else {
        inCodeBlock = false;
        codeFence = '';
        lines.push(colors.dim('└────────────'));
      }
      return;
    }
    if (inCodeBlock) {
      lines.push(colors.dim(`  ${line}`));
      return;
    }
    if (!trimmed) {
      lines.push('');
      return;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      const level = trimmed.match(/^#+/)[0].length;
      const title = formatInline(trimmed.replace(/^#{1,6}\s+/, ''));
      const prefix = level === 1 ? '##' : level === 2 ? '#' : '-';
      lines.push(colors.cyan(`${prefix.repeat(level)} ${title}`));
      return;
    }
    if (/^[-*+]\s+/.test(trimmed)) {
      const content = formatInline(trimmed.replace(/^[-*+]\s+/, ''));
      lines.push(` ${colors.green('•')} ${content}`);
      return;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const match = trimmed.match(/^(\d+)\.\s+/);
      const number = match ? match[1] : '1';
      const content = formatInline(trimmed.replace(/^\d+\.\s+/, ''));
      lines.push(` ${colors.yellow(number)}. ${content}`);
      return;
    }
    if (trimmed.startsWith('>')) {
      const content = formatInline(trimmed.replace(/^>\s?/, ''));
      lines.push(colors.dim(`│ ${content}`));
      return;
    }
    lines.push(formatInline(line));
  });
  return lines.join('\n');
}

function formatInline(text) {
  if (!text) {
    return '';
  }
  let result = text;
  result = result.replace(/\*\*(.+?)\*\*/g, (_, value) => colors.bold(value));
  result = result.replace(/`([^`]+)`/g, (_, value) => colors.yellow(value));
  result = result.replace(/\*(.+?)\*/g, (_, value) => colors.italic(value));
  return result;
}

module.exports = {
  renderMarkdown,
};
