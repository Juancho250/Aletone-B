const { scStreamInfo } = require('./soundcloud');

const positive = new Map();
const negative = new Map();
const pending = new Map();

// SoundCloud stream URLs are signed/temporary, so keep this deliberately short.
const POSITIVE_TTL_MS = 3 * 60_000;
const NEGATIVE_TTL_MS = 45_000;

function now() {
  return Date.now();
}

function prune(map) {
  const ts = now();
  for (const [key, entry] of map) {
    if (!entry || entry.expiresAt <= ts) map.delete(key);
  }
}

async function resolveSoundCloudStream(trackId) {
  const id = String(trackId || '');
  const ts = now();

  const hit = positive.get(id);
  if (hit && hit.expiresAt > ts) return hit.value;

  const miss = negative.get(id);
  if (miss && miss.expiresAt > ts) {
    const error = new Error(miss.message || 'Stream no disponible');
    error.status = miss.status || 409;
    throw error;
  }

  if (pending.has(id)) return pending.get(id);

  const task = scStreamInfo(id)
    .then(value => {
      positive.set(id, { value, expiresAt: now() + POSITIVE_TTL_MS });
      negative.delete(id);
      return value;
    })
    .catch(error => {
      negative.set(id, {
        message: error?.message || 'Stream no disponible',
        status: error?.status || 503,
        expiresAt: now() + NEGATIVE_TTL_MS,
      });
      throw error;
    })
    .finally(() => {
      pending.delete(id);
      if (positive.size > 500) prune(positive);
      if (negative.size > 500) prune(negative);
    });

  pending.set(id, task);
  return task;
}

function getStreamResolverStats() {
  prune(positive);
  prune(negative);
  return {
    cached: positive.size,
    negative: negative.size,
    pending: pending.size,
  };
}

module.exports = {
  resolveSoundCloudStream,
  getStreamResolverStats,
};
