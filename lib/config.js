'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Config sources, lowest to highest precedence:
 *   1. built-in defaults
 *   2. a JSON file:  $CONFIG_PATH, else ./config/config.json, else ./config.json
 *   3. env vars:     scalars (PORT, TZ, LAT, LON, NWS_USER_AGENT) and the whole
 *      calendar list via CALENDARS_JSON (a JSON array). CALENDARS_JSON lets a
 *      Portainer-only deploy skip the bind-mounted file entirely -- the trade
 *      is that the iCal URLs are then visible in `docker inspect` / the
 *      Portainer UI, which is fine for a home LAN display.
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

  // env overrides
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.TZ) cfg.timezone = process.env.TZ;
  if (process.env.LAT) cfg.lat = Number(process.env.LAT);
  if (process.env.LON) cfg.lon = Number(process.env.LON);
  if (process.env.NWS_USER_AGENT) cfg.nwsUserAgent = process.env.NWS_USER_AGENT;

  if (process.env.CALENDARS_JSON) {
    try {
      const parsed = JSON.parse(process.env.CALENDARS_JSON);
      if (!Array.isArray(parsed)) throw new Error('not a JSON array');
      cfg.calendars = parsed;
      cfg._calendarsFrom = 'CALENDARS_JSON env';
    } catch (err) {
      console.error(`config: CALENDARS_JSON is set but could not be parsed (${err.message}); ignoring it`);
    }
  }

  // Node uses $TZ for Date math; make sure it matches whatever we resolved.
  if (!process.env.TZ && cfg.timezone) process.env.TZ = cfg.timezone;

  cfg._loadedFrom = loadedFrom;
  return cfg;
}

module.exports = { loadConfig };
