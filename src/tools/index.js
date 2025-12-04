const { registerTool, resolveToolset, listTools } = require('./registry');

// Register built-in examples.
require('./builtin');

module.exports = {
  registerTool,
  resolveToolset,
  listTools,
};
