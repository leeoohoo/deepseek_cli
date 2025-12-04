const path = require('path');

function expandHomePath(target) {
  if (!target || !target.startsWith('~')) {
    return target;
  }
  const home = getHomeDir();
  if (!home) {
    return target;
  }
  if (target === '~') {
    return home;
  }
  if (target.startsWith('~/')) {
    return path.join(home, target.slice(2));
  }
  return target;
}

function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || '';
}

module.exports = {
  expandHomePath,
  getHomeDir,
};
