let contextRef = null;

export function setSubAgentContext(context) {
  contextRef = context || null;
}

export function getSubAgentContext() {
  return contextRef;
}

