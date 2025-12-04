const fs = require('fs');
const path = require('path');
const os = require('os');
const YAML = require('yaml');

const DEFAULT_PROMPTS = {
  daily_coding: `你是终端内的资深全栈开发助手，帮助我实现功能、解释思路，输出风格：
- 先用中文概述整体方案，再给出关键命令或代码片段；
- 涉及文件修改时，标注相对路径与重点变更；
- 主动提示潜在风险、待测项与下一步计划；
- 输出简洁，必要时用列表或表格。`,
  code_review: `你是一名严格的代码 Reviewer。对于给出的改动：
- 先列出风险、遗漏、潜在 bug；
- 如果没有发现问题，说明已检查的范围并提示仍需关注的点；
- 输出以“问题 -> 说明 -> 建议”结构展开。`,
  bugfix_partner: `你与我结对调试。流程：
1. 先澄清现象与当前假设；
2. 提出最多 3 个排查步骤，按优先级排列；
3. 根据我反馈持续迭代，直到问题解决。`,
};

function loadPromptProfiles(configPath) {
  const filePath = resolvePromptPath(configPath);
  ensurePromptFile(filePath);
  let data;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    data = YAML.parse(raw) || {};
  } catch (err) {
    console.error(
      `[prompts] Failed to read ${filePath}: ${err.message}. Falling back to defaults.`
    );
    data = { prompts: DEFAULT_PROMPTS };
  }
  const prompts = normalizePromptMap(data.prompts || data || {});
  return { path: filePath, prompts };
}

function savePromptProfiles(filePath, prompts) {
  const payload = { prompts: { ...prompts } };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(payload), 'utf8');
}

function resolvePromptPath(configPath) {
  const baseDir = configPath ? path.dirname(configPath) : getDefaultConfigDir();
  return path.join(baseDir, 'prompts.yaml');
}

function ensurePromptFile(filePath) {
  if (fs.existsSync(filePath)) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = { prompts: DEFAULT_PROMPTS };
  fs.writeFileSync(filePath, YAML.stringify(payload), 'utf8');
}

function normalizePromptMap(input) {
  if (!input || typeof input !== 'object') {
    return { default: DEFAULT_PROMPTS.daily_coding };
  }
  const result = {};
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.trim()) {
      result[name] = value.trim();
      continue;
    }
    if (value && typeof value === 'object' && typeof value.text === 'string') {
      result[name] = value.text.trim();
    }
  }
  if (Object.keys(result).length === 0) {
    return { default: DEFAULT_PROMPTS.daily_coding };
  }
  return result;
}

function getDefaultConfigDir() {
  const home = os.homedir();
  if (home) {
    return path.join(home, '.deepseek_cli', 'auth');
  }
  return path.resolve(process.cwd(), '.deepseek_cli');
}

module.exports = {
  loadPromptProfiles,
  savePromptProfiles,
  resolvePromptPath,
};
