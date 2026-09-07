'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Config resolution order (first hit wins for the file body):
 *   1. $CONFIG_PATH
 *   2. ./config/config.json   (the bind-mount location in Docker)
 *   3. ./config.json          (handy for local dev)
 *
 * A handful of scalars can also come from env vars, which override the file.
 * Secrets (the iCal URLs) only come from the file -- they are never read from
 * env, so they don't leak into `docker inspect` / process listings.
 */
function loadConfig() {
  const candidates = [
    process.env.CONFIG_PATH,
    path.join(process.cwd(), 'config', 'config.json'),
    path.join(process.cwd(), 'config.json'),
  ].filter(Boolean);

  let fileCfg = {};
  let loadedFrom = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      fileCfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      loadedFrom = p;
      break;
    }
  }

  const cfg = {
    port: 8080,
    timezone: 'America/Chicago',
    lat: 37.3059,
    lon: -89.5181,
    nwsUserAgent: '',
    hourlyCount: 12,
    dailyCount: 5,
    calendarDays: 10,
    refresh: { weatherMs: 600000, calendarMs: 300000 },
    calendars: [],
    ...fileCfg,
  };
  cfg.refresh = { weatherMs: 600000, calendarMs: 300000, ...(fileCfg.refresh || {}) };

  // env overrides for the non-secret scalars
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.TZ) cfg.timezone = process.env.TZ;
  if (process.env.LAT) cfg.lat = Number(process.env.LAT);
  if (process.env.LON) cfg.lon = Number(process.env.LON);
  if (process.env.NWS_USER_AGENT) cfg.nwsUserAgent = process.env.NWS_USER_AGENT;

  // Node uses $TZ for Date math; make sure it matches whatever we resolved.
  if (!process.env.TZ && cfg.timezone) process.env.TZ = cfg.timezone;

  cfg._loadedFrom = loadedFrom;
  return cfg;
}

module.exports = { loadConfig };
