import fs from 'fs';
import path from 'path';
import os from 'os';
import YAML from 'yaml';

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

const DEFAULT_INTERNAL_SYSTEM_PROMPT = `你运行在本地 Deepseek CLI 中，必须始终遵守以下准则，不可省略：
- 保持回答紧凑，用中文给出结论和下一步；涉及文件或命令时写出相对路径/命令。
- 任何需要代码修改的场景，先说明改动点与风险，再给出步骤或补丁。
- 充分使用可用的 MCP 工具（文件、Shell、Task 管理等）以及 invoke_sub_agent；能用工具获取信息或执行操作时，避免主观臆测。
- 如需拆解/跟踪任务，优先调用可用的任务类 MCP 工具记录/更新条目；缺少工具或信息时先澄清。`;

const DEFAULT_SYSTEM_PROMPT = `你是一名资深全栈工程师，帮助我在终端里完成日常开发工作。优先：
- 用中文解释整体思路，再给出可运行的代码片段。
- 每当引用项目文件时，标注相对路径并指出需要修改的文件。
- 主动提醒缺失的测试、潜在风险以及后续步骤。
- 输出内容保持简洁，必要时使用列表或代码块。
- 每个用户任务都先判断是否需要更细分的专家。如果适合，让 invoke_sub_agent 工具自动选择对应的子代理（例如 Python 架构/交付、安全、K8s 等），并把任务描述与技能偏好传给该工具；只有在工具不可用或不合适时再直接回答。`;

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

function resolveSystemPromptPath(configPath) {
  const baseDir = configPath ? path.dirname(configPath) : getDefaultConfigDir();
  return path.join(baseDir, 'system-prompt.yaml');
}

function ensureSystemPromptFile(filePath) {
  if (fs.existsSync(filePath)) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    internal: DEFAULT_INTERNAL_SYSTEM_PROMPT,
    default: DEFAULT_SYSTEM_PROMPT,
  };
  fs.writeFileSync(filePath, YAML.stringify(payload), 'utf8');
}

function loadSystemPromptConfig(configPath) {
  const filePath = resolveSystemPromptPath(configPath);
  ensureSystemPromptFile(filePath);
  let parsed;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    parsed = YAML.parse(raw) || {};
  } catch (err) {
    console.error(
      `[prompts] Failed to read ${filePath}: ${err.message}. Falling back to defaults.`
    );
    parsed = {};
  }
  const internal =
    typeof parsed.internal === 'string' && parsed.internal.trim()
      ? parsed.internal.trim()
      : DEFAULT_INTERNAL_SYSTEM_PROMPT;
  const defaultPrompt =
    typeof parsed.default === 'string' && parsed.default.trim()
      ? parsed.default.trim()
      : DEFAULT_SYSTEM_PROMPT;
  return {
    path: filePath,
    internal,
    defaultPrompt,
  };
}

function composeSystemPrompt({ configPath, systemOverride, modelPrompt }) {
  const config = loadSystemPromptConfig(configPath);
  const sections = [];
  if (config.internal) {
    sections.push(config.internal.trim());
  }
  const userSection =
    systemOverride !== undefined ? systemOverride : modelPrompt || config.defaultPrompt;
  if (userSection && String(userSection).trim()) {
    sections.push(String(userSection).trim());
  }
  return {
    prompt: sections.join('\n\n'),
    path: config.path,
  };
}

export {
  loadPromptProfiles,
  savePromptProfiles,
  resolvePromptPath,
  resolveSystemPromptPath,
  loadSystemPromptConfig,
  composeSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_INTERNAL_SYSTEM_PROMPT,
};
