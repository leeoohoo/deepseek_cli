const { registerTool } = require('./registry');
const { ChatSession } = require('../session');
const { getSubAgentContext } = require('../subagents/runtime');
const { selectAgent } = require('../subagents/selector');

registerTool({
  name: 'get_current_time',
  description: 'Return the current timestamp in ISO 8601 format.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => new Date().toISOString(),
});

registerTool({
  name: 'echo_text',
  description: 'Echo back the provided text string.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to echo back.' },
    },
    required: ['text'],
  },
  handler: async ({ text }) => String(text ?? ''),
});

registerTool({
  name: 'invoke_sub_agent',
  description:
    'Invoke a specialized sub-agent from the local marketplace. Automatically selects the best agent based on requested skills/category if agent_id is omitted.',
  parameters: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Specific sub-agent identifier to use.' },
      category: { type: 'string', description: 'Preferred plugin/category when auto-selecting.' },
      skills: {
        type: 'array',
        description: 'List of skill identifiers to activate or prefer.',
        items: { type: 'string' },
      },
      task: { type: 'string', description: 'Task description for the sub-agent.' },
    },
    required: ['task'],
  },
  handler: async ({ agent_id: agentId, category, skills = [], task }) => {
    const context = getSubAgentContext();
    if (!context || !context.manager) {
      throw new Error('Sub-agent runtime unavailable. Ensure chat session initialized.');
    }
    const manager = context.manager;
    const clientProvider = typeof context.getClient === 'function' ? context.getClient : null;
    const client = clientProvider ? clientProvider() : null;
    if (!client) {
      throw new Error('Sub-agent runtime missing client context.');
    }
    const normalizedSkills = Array.isArray(skills)
      ? skills.map((entry) => String(entry).trim()).filter(Boolean)
      : [];
    const agentRef = selectAgent(manager, { agentId, category, skills: normalizedSkills });
    if (!agentRef) {
      throw new Error('No suitable sub-agent is available. Install plugins via /sub install.');
    }
    let systemPrompt;
    let usedSkills = [];
    try {
      const promptResult = manager.buildSystemPrompt(agentRef, normalizedSkills);
      systemPrompt = promptResult.systemPrompt;
      usedSkills = promptResult.usedSkills || [];
    } catch (err) {
      throw new Error(`Failed to build sub-agent prompt: ${err.message}`);
    }
    const targetModel =
      agentRef.agent.model ||
      (typeof context.getCurrentModel === 'function' ? context.getCurrentModel() : null) ||
      client.getDefaultModel();
    const subSession = new ChatSession(systemPrompt);
    subSession.addUser(task);
    const responseText = await client.chat(targetModel, subSession, { stream: false });
    return {
      agent: {
        id: agentRef.agent.id,
        name: agentRef.agent.name,
        plugin: agentRef.plugin.name,
        model: targetModel,
      },
      skills: usedSkills,
      response: responseText || '',
    };
  },
});
