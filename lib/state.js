'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = { hiddenCalendars: [], countdown: null };

function resolveStatePath() {
  if (process.env.STATE_PATH) return process.env.STATE_PATH;
  const configDir = path.join(process.cwd(), 'config');
  if (fs.existsSync(configDir)) return path.join(configDir, 'state.json');
  return path.join(process.cwd(), 'state.json');
}

function loadState() {
  const p = resolveStatePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      hiddenCalendars: Array.isArray(parsed.hiddenCalendars) ? parsed.hiddenCalendars : [],
      countdown: parsed.countdown && typeof parsed.countdown === 'object' ? parsed.countdown : null,
    };
  } catch (err) {
    return { ...DEFAULTS };
  }
}

function saveState(state) {
  const p = resolveStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

module.exports = { loadState, saveState, resolveStatePath };
