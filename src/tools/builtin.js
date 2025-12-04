const { registerTool } = require('./registry');

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
