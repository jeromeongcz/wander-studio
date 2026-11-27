export const NODE_REQUIREMENT = 'Node.js 22.18+ (22.x) or 24+';

export function supportedNode(version) {
  const versionParts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!versionParts) return false;
  const [, major, minor] = versionParts.map(Number);
  return major >= 24 || (major === 22 && minor >= 18);
}

export function requireSupportedNode(version = process.version, io = console) {
  if (supportedNode(version)) return true;
  io.error(`Wander Studio requires ${NODE_REQUIREMENT}. Found ${version}.`);
  io.error('Install a supported Node.js LTS release and reopen your terminal.');
  return false;
}
