const fs = require('fs');
const path = require('path');
const { getHomeDir } = require('../utils');

function createSubAgentManager(options = {}) {
  return new SubAgentManager(options);
}

class SubAgentManager {
  constructor(options = {}) {
    const rootDir = options.baseDir || path.resolve(__dirname, '..', '..', 'subagents');
    this.baseDir = rootDir;
    this.marketplacePath = path.join(rootDir, 'marketplace.json');
    this.pluginsDir = path.join(rootDir, 'plugins');
    const home = getHomeDir() || process.cwd();
    const stateDir = path.join(home, '.deepseek_cli');
    this.stateDir = stateDir;
    this.statePath = path.join(stateDir, 'subagents.json');
    this.marketplaceCache = null;
    this.pluginCache = new Map();
    this.installedCache = null;
  }

  listMarketplace() {
    const entries = this.#loadMarketplace();
    return entries.slice().sort((a, b) => a.name.localeCompare(b.name));
  }

  listInstalledPlugins() {
    const installedIds = this.#loadInstalledIds();
    return installedIds
      .map((id) => {
        try {
          return this.#loadPlugin(id);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  install(pluginId) {
    const marketplace = this.#loadMarketplace();
    const exists = marketplace.some((entry) => entry.id === pluginId);
    if (!exists) {
      throw new Error(`Plugin "${pluginId}" not found in marketplace.`);
    }
    const installed = new Set(this.#loadInstalledIds());
    if (installed.has(pluginId)) {
      return false;
    }
    installed.add(pluginId);
    this.#saveInstalled(Array.from(installed));
    return true;
  }

  uninstall(pluginId) {
    const installed = new Set(this.#loadInstalledIds());
    if (!installed.delete(pluginId)) {
      return false;
    }
    this.#saveInstalled(Array.from(installed));
    return true;
  }

  listAgents() {
    const plugins = this.listInstalledPlugins();
    const agents = [];
    plugins.forEach((plugin) => {
      plugin.agents.forEach((agent) => {
        const availableSkills = this.#resolveAgentSkills(agent, plugin);
        agents.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          id: agent.id,
          name: agent.name,
          description: agent.description || '',
          model: agent.model || null,
          defaultSkills: Array.isArray(agent.defaultSkills) ? agent.defaultSkills : [],
          skills: availableSkills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description || '',
          })),
        });
      });
    });
    return agents;
  }

  getAgent(agentId) {
    if (!agentId) {
      return null;
    }
    const plugins = this.listInstalledPlugins();
    for (const plugin of plugins) {
      const agent = plugin.agentMap.get(agentId);
      if (agent) {
        return { plugin, agent };
      }
    }
    return null;
  }

  buildSystemPrompt(agentRef, requestedSkills = []) {
    if (!agentRef || !agentRef.agent || !agentRef.plugin) {
      throw new Error('Invalid agent reference.');
    }
    const agent = agentRef.agent;
    const plugin = agentRef.plugin;
    const basePrompt = this.#loadAgentPrompt(agent);
    const skillMap = this.#agentSkillMap(agent, plugin);
    const desiredSkills =
      requestedSkills && requestedSkills.length > 0
        ? requestedSkills
        : Array.isArray(agent.defaultSkills)
          ? agent.defaultSkills
          : [];
    const usedSkills = [];
    desiredSkills.forEach((skillId) => {
      const skill = skillMap.get(skillId);
      if (!skill) {
        return;
      }
      const instructions = this.#loadSkillInstructions(skill);
      if (!instructions) {
        return;
      }
      usedSkills.push({
        id: skill.id,
        name: skill.name,
        instructions,
      });
    });
    const sections = [];
    if (basePrompt && basePrompt.trim()) {
      sections.push(basePrompt.trim());
    }
    usedSkills.forEach((skill) => {
      sections.push(`# Skill: ${skill.name}\n${skill.instructions.trim()}`);
    });
    const systemPrompt = sections.join('\n\n');
    return {
      systemPrompt,
      usedSkills: usedSkills.map((skill) => ({ id: skill.id, name: skill.name })),
      extra: {
        reasoning: agent.reasoning === undefined ? true : Boolean(agent.reasoning),
      },
    };
  }

  #loadMarketplace() {
    if (this.marketplaceCache) {
      return this.marketplaceCache;
    }
    try {
      const data = fs.readFileSync(this.marketplacePath, 'utf8');
      const parsed = JSON.parse(data);
      this.marketplaceCache = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.marketplaceCache = [];
    }
    return this.marketplaceCache;
  }

  #loadInstalledIds() {
    if (this.installedCache) {
      return this.installedCache;
    }
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed.plugins) ? parsed.plugins : [];
      this.installedCache = entries;
    } catch {
      this.installedCache = [];
    }
    return this.installedCache;
  }

  #saveInstalled(ids) {
    this.installedCache = ids.slice();
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify({ plugins: ids }, null, 2), 'utf8');
    } catch (err) {
      throw new Error(`Failed to write subagent state: ${err.message}`);
    }
  }

  #loadPlugin(pluginId) {
    if (this.pluginCache.has(pluginId)) {
      return this.pluginCache.get(pluginId);
    }
    const pluginDir = path.join(this.pluginsDir, pluginId);
    const manifestPath = path.join(pluginDir, 'plugin.json');
    let manifest;
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      manifest = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to read plugin ${pluginId}: ${err.message}`);
    }
    const normalized = {
      id: manifest.id || pluginId,
      name: manifest.name || pluginId,
      description: manifest.description || '',
      category: manifest.category || 'general',
      directory: pluginDir,
    };
    normalized.skills = Array.isArray(manifest.skills)
      ? manifest.skills.map((skill) => ({
          ...skill,
          instructionsPath: skill.instructionsPath
            ? path.join(pluginDir, skill.instructionsPath)
            : null,
        }))
      : [];
    normalized.skillMap = new Map(
      normalized.skills.map((skill) => [skill.id, skill])
    );
    normalized.agents = Array.isArray(manifest.agents)
      ? manifest.agents.map((agent) => ({
          ...agent,
          pluginId: normalized.id,
          systemPromptPath: agent.systemPromptPath
            ? path.join(pluginDir, agent.systemPromptPath)
            : null,
        }))
      : [];
    normalized.agentMap = new Map(
      normalized.agents.map((agent) => [agent.id, agent])
    );
    this.pluginCache.set(pluginId, normalized);
    return normalized;
  }

  #resolveAgentSkills(agent, plugin) {
    const skillIds = Array.isArray(agent.skills) && agent.skills.length > 0
      ? agent.skills
      : Array.from(plugin.skillMap.keys());
    return skillIds
      .map((id) => plugin.skillMap.get(id))
      .filter(Boolean);
  }

  #agentSkillMap(agent, plugin) {
    const map = new Map();
    this.#resolveAgentSkills(agent, plugin).forEach((skill) => {
      map.set(skill.id, skill);
    });
    return map;
  }

  #loadAgentPrompt(agent) {
    if (agent._systemPrompt !== undefined) {
      return agent._systemPrompt;
    }
    if (agent.system) {
      agent._systemPrompt = agent.system;
      return agent._systemPrompt;
    }
    if (!agent.systemPromptPath) {
      agent._systemPrompt = '';
      return agent._systemPrompt;
    }
    try {
      agent._systemPrompt = fs.readFileSync(agent.systemPromptPath, 'utf8');
    } catch {
      agent._systemPrompt = '';
    }
    return agent._systemPrompt;
  }

  #loadSkillInstructions(skill) {
    if (skill._instructions !== undefined) {
      return skill._instructions;
    }
    if (skill.instructions) {
      skill._instructions = skill.instructions;
      return skill._instructions;
    }
    if (!skill.instructionsPath) {
      skill._instructions = '';
      return skill._instructions;
    }
    try {
      skill._instructions = fs.readFileSync(skill.instructionsPath, 'utf8');
    } catch {
      skill._instructions = '';
    }
    return skill._instructions;
  }
}

module.exports = {
  createSubAgentManager,
};
