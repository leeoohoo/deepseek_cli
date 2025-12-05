export function selectAgent(manager, options = {}) {
  if (!manager) return null;
  if (options.agentId) {
    const direct = manager.getAgent(options.agentId);
    if (direct) {
      return direct;
    }
  }
  const agents = manager.listAgents();
  if (agents.length === 0) {
    return null;
  }
  let candidates = agents;
  if (options.category) {
    const needle = options.category.toLowerCase();
    const filtered = agents.filter(
      (agent) =>
        agent.pluginId?.toLowerCase().includes(needle) ||
        agent.pluginName?.toLowerCase().includes(needle)
    );
    if (filtered.length > 0) {
      candidates = filtered;
    }
  }
  const skillSet = new Set(
    Array.isArray(options.skills) ? options.skills.map((entry) => entry.toLowerCase()) : []
  );
  if (skillSet.size === 0) {
    const fallback = manager.getAgent(candidates[0].id);
    return fallback;
  }
  let best = null;
  let bestScore = -1;
  candidates.forEach((agent) => {
    const available = agent.skills || [];
    const score = available.reduce((acc, skill) => {
      if (!skill || !skill.id) return acc;
      return skillSet.has(skill.id.toLowerCase()) ? acc + 1 : acc;
    }, 0);
    if (score > bestScore) {
      bestScore = score;
      best = agent;
    }
  });
  if (!best) {
    best = candidates[0];
  }
  return manager.getAgent(best.id);
}

