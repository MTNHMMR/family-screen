'use strict';

/**
 * Tiny in-memory TTL cache with "serve stale on error".
 * If the refresh function throws and we have a previous value, we keep
 * serving the old one and log a warning -- the wall display should never
 * go blank just because an upstream API hiccuped.
 */
function makeCache() {
  const store = new Map();

  return {
    async get(key, ttlMs, fn) {
      const hit = store.get(key);
      if (hit && Date.now() - hit.t < ttlMs) return hit.v;

      try {
        const v = await fn();
        store.set(key, { v, t: Date.now() });
        return v;
      } catch (err) {
        if (hit) {
          const ageMin = Math.round((Date.now() - hit.t) / 60000);
          console.warn(`cache: "${key}" refresh failed (${err.message}); serving value from ${ageMin} min ago`);
          return hit.v;
        }
        throw err;
      }
    },
  };
}

module.exports = { makeCache };
