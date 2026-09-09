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
    semoCurrentUrl: 'https://semoweathernetwork.com/api/cape-county-current.php',
    hourlyCount: 12,
    dailyCount: 5,
    calendarDays: 10,
    refresh: { weatherMs: 600000, calendarMs: 300000 },
    calendars: [],
    homeAssistant: {},
    ...fileCfg,
  };
  cfg.refresh = { weatherMs: 600000, calendarMs: 300000, ...(fileCfg.refresh || {}) };
  cfg.homeAssistant = { ...(fileCfg.homeAssistant || {}) };

  // env overrides
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.TZ) cfg.timezone = process.env.TZ;
  if (process.env.LAT) cfg.lat = Number(process.env.LAT);
  if (process.env.LON) cfg.lon = Number(process.env.LON);
  if (process.env.NWS_USER_AGENT) cfg.nwsUserAgent = process.env.NWS_USER_AGENT;
  if (process.env.SEMO_CURRENT_URL !== undefined) {
    cfg.semoCurrentUrl = process.env.SEMO_CURRENT_URL; // set to '' to disable
  }

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

  // Home Assistant (the Cam button). Whole-object override first, then the
  // individual scalars -- so a Portainer deploy only needs to set HA_TOKEN
  // (base URL + camera list have safe defaults baked into docker-compose.yml).
  if (process.env.HOME_ASSISTANT_JSON) {
    try {
      const parsed = JSON.parse(process.env.HOME_ASSISTANT_JSON);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not a JSON object');
      }
      cfg.homeAssistant = parsed;
      cfg._homeAssistantFrom = 'HOME_ASSISTANT_JSON env';
    } catch (err) {
      console.error(`config: HOME_ASSISTANT_JSON is set but could not be parsed (${err.message}); ignoring it`);
    }
  }
  cfg.homeAssistant = cfg.homeAssistant || {};
  if (process.env.HA_BASE_URL) cfg.homeAssistant.baseUrl = process.env.HA_BASE_URL;
  if (process.env.HA_TOKEN) cfg.homeAssistant.token = process.env.HA_TOKEN;
  if (process.env.HA_CAMERAS_JSON) {
    try {
      const parsed = JSON.parse(process.env.HA_CAMERAS_JSON);
      if (!Array.isArray(parsed)) throw new Error('not a JSON array');
      cfg.homeAssistant.cameras = parsed;
    } catch (err) {
      console.error(`config: HA_CAMERAS_JSON is set but could not be parsed (${err.message}); ignoring it`);
    }
  }

  // Node uses $TZ for Date math; make sure it matches whatever we resolved.
  if (!process.env.TZ && cfg.timezone) process.env.TZ = cfg.timezone;

  cfg._loadedFrom = loadedFrom;
  return cfg;
}

module.exports = { loadConfig };
