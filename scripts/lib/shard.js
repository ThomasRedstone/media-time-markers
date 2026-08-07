// Shared sharding convention: data/<uuid[0:2]>/<uuid[2:4]>/<uuid>.json
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isValidAcoustId(uuid) {
  return typeof uuid === "string" && UUID_RE.test(uuid);
}

function shardPath(uuid) {
  if (!isValidAcoustId(uuid)) {
    throw new Error(`not a lowercase AcoustID UUID: ${uuid}`);
  }
  const a = uuid.slice(0, 2);
  const b = uuid.slice(2, 4);
  return `data/${a}/${b}/${uuid}.json`;
}

module.exports = { isValidAcoustId, shardPath, UUID_RE };
