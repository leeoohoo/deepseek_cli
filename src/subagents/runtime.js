let contextRef = null;

function setSubAgentContext(context) {
  contextRef = context || null;
}

function getSubAgentContext() {
  return contextRef;
}

module.exports = {
  setSubAgentContext,
  getSubAgentContext,
};
