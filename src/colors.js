export const cyan = (text) => `\x1b[36m${text}\x1b[0m`;
export const green = (text) => `\x1b[32m${text}\x1b[0m`;
export const magenta = (text) => `\x1b[35m${text}\x1b[0m`;
export const yellow = (text) => `\x1b[33m${text}\x1b[0m`;
export const blue = (text) => `\x1b[34m${text}\x1b[0m`;
export const dim = (text) => `\x1b[2m${text}\x1b[0m`;
export const bold = (text) => `\x1b[1m${text}\x1b[0m`;
export const italic = (text) => `\x1b[3m${text}\x1b[0m`;

export default {
  cyan,
  green,
  magenta,
  yellow,
  blue,
  dim,
  bold,
  italic,
};
