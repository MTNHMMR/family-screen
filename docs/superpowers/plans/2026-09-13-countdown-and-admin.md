# Event Countdown + Admin Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wall display's "Hourly" forecast card with a countdown to a picked calendar event, and add an unlinked `/admin` page to pick that event and toggle which calendars show on the display.

**Architecture:** A new admin-writable `state.json` (loaded/saved by a new `lib/state.js`) holds the hidden-calendar list and the selected countdown *series* (calendar name + iCal uid). `lib/calendar.js` gets pure helpers (filtering, series dedup, next-occurrence picking, day/hour math) plus two new I/O functions that expand calendars further out than the display's normal window. `server.js` exposes those through new `/api/countdown` and `/api/admin/*` routes. The display (`public/`) polls `/api/countdown` and swaps a card; a new plain `public/admin.html`/`admin.js` page (reachable only by typing `/admin`) drives the admin routes.

**Tech Stack:** Node.js (`>=20`) built-in `http` module, no framework, no build step — matches the existing codebase. Tests use Node's built-in test runner (`node:test` + `node:assert/strict`), so no new dependency is added for testing either.

## Global Constraints

- No new npm dependencies — this project has exactly two runtime dependencies (`ical-expander`, and its own `ical.js` dependency) plus zero dev dependencies; keep it that way. Tests use Node's built-in `node:test`.
- No build step. `public/` stays plain HTML/CSS/vanilla JS (ES5-leaning style: `var`, function declarations — matches the existing `app.js`).
- The admin page has **no authentication** (LAN-only, matches the rest of this app).
- Calendar management on the admin page is **show/hide only** — adding, removing, or editing a calendar's name/color/URL stays a `config.json` edit.
- **Nothing** in `public/index.html` or `public/app.js` links to `/admin`.
- The countdown targets a calendar event **series** (`calendarName` + iCal `uid`), never a frozen timestamp — it must keep tracking a recurring event's next occurrence.
- `state.json` is git-ignored, like `config.json`.
- Full spec: `docs/superpowers/specs/2026-09-13-countdown-and-admin-design.md`.

---

### Task 1: `lib/state.js` — admin-writable runtime state

**Files:**
- Create: `lib/state.js`
- Create: `test/state.test.js`
- Modify: `package.json` (add a `test` script)
- Modify: `.gitignore` (git-ignore the state file)

**Interfaces:**
- Produces: `loadState()` → `{ hiddenCalendars: string[], countdown: { calendarName: string, uid: string, title: string } | null }`. Always returns this shape, even when the file is missing or malformed.
- Produces: `saveState(state)` → writes `state` (that same shape) to disk atomically. No return value.
- Produces: `resolveStatePath()` → the absolute path `loadState`/`saveState` use, resolved from `STATE_PATH` env, else `config/state.json` (if a `config/` directory exists next to the process cwd), else `./state.json`. Exported mainly so tests can reason about it, but not required by later tasks.

- [ ] **Step 1: Write the failing tests**

Create `test/state.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withTempStatePath(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-display-state-'));
  const file = path.join(dir, 'state.json');
  const prev = process.env.STATE_PATH;
  process.env.STATE_PATH = file;
  try {
    return fn(file);
  } finally {
    if (prev === undefined) delete process.env.STATE_PATH;
    else process.env.STATE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const state = require('../lib/state');

test('loadState returns defaults when the file does not exist', () => {
  withTempStatePath(() => {
    assert.deepEqual(state.loadState(), { hiddenCalendars: [], countdown: null });
  });
});

test('saveState then loadState round-trips hiddenCalendars and countdown', () => {
  withTempStatePath(() => {
    state.saveState({
      hiddenCalendars: ['Scouts'],
      countdown: { calendarName: 'Family', uid: 'abc123', title: 'Trivia Night' },
    });
    assert.deepEqual(state.loadState(), {
      hiddenCalendars: ['Scouts'],
      countdown: { calendarName: 'Family', uid: 'abc123', title: 'Trivia Night' },
    });
  });
});

test('loadState returns defaults when the file has invalid JSON', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not valid json');
    assert.deepEqual(state.loadState(), { hiddenCalendars: [], countdown: null });
  });
});

test('loadState normalizes a malformed hiddenCalendars field to an empty array', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hiddenCalendars: 'not-an-array', countdown: null }));
    assert.deepEqual(state.loadState().hiddenCalendars, []);
  });
});
```

- [ ] **Step 2: Add the test script and run the tests to verify they fail**

In `package.json`, change:

```json
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
```

to:

```json
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "test": "node --test test/"
  },
```

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/state'`

- [ ] **Step 3: Implement `lib/state.js`**

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 4 tests passing, 0 failing.

- [ ] **Step 5: Git-ignore the state file**

In `.gitignore`, change:

```
node_modules/
config/config.json
config.json
*.local
```

to:

```
node_modules/
config/config.json
config.json
config/state.json
state.json
*.local
```

- [ ] **Step 6: Commit**

```bash
git add lib/state.js test/state.test.js package.json .gitignore
git commit -m "Add admin-writable runtime state (lib/state.js)"
```

---

### Task 2: `lib/calendar.js` — pure helpers (filter, dedupe, pick, countdown math)

**Files:**
- Modify: `lib/calendar.js`
- Create: `test/calendar-pure.test.js`

**Interfaces:**
- Consumes: the existing `normalize()`-shaped event object from `lib/calendar.js:26-40` — `{ uid, title, location, allDay, start, end, calendar, color }` — and the existing `getCalendar()` return shape — `{ updated, days, calendars: [{name,color}], events: [...], errors: [...] }`.
- Produces: `filterHidden(calendarData, hiddenNames)` → same shape as `calendarData`, with `calendars` and `events` filtered.
- Produces: `pickNextOccurrence(events, calendarName, uid, nowMs)` → the earliest event in `events` matching `calendar === calendarName && uid === uid` with `start >= nowMs`, or `null`.
- Produces: `dedupeToSeries(events)` → one event per distinct `(calendar, uid)` pair (the earliest `start`), sorted ascending by `start`.
- Produces: `computeCountdown(startIso, nowMs)` → `{ daysLeft: number, hoursLeft: number }`, both `>= 0` (clamped for a past `startIso`).

- [ ] **Step 1: Write the failing tests**

Create `test/calendar-pure.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { filterHidden, pickNextOccurrence, dedupeToSeries, computeCountdown } = require('../lib/calendar');

test('filterHidden removes events and legend entries for hidden calendar names', () => {
  const data = {
    updated: '2026-09-13T00:00:00.000Z',
    days: 3,
    calendars: [
      { name: 'Family', color: '#111' },
      { name: 'Scouts', color: '#222' },
    ],
    events: [
      { uid: '1', title: 'Dinner', calendar: 'Family', start: '2026-09-14T00:00:00.000Z' },
      { uid: '2', title: 'Meeting', calendar: 'Scouts', start: '2026-09-14T01:00:00.000Z' },
    ],
    errors: [],
  };
  const result = filterHidden(data, ['Scouts']);
  assert.deepEqual(result.calendars, [{ name: 'Family', color: '#111' }]);
  assert.deepEqual(result.events.map((e) => e.uid), ['1']);
});

test('filterHidden returns an equivalent object when nothing is hidden', () => {
  const data = { calendars: [{ name: 'Family' }], events: [{ uid: '1', calendar: 'Family' }] };
  assert.deepEqual(filterHidden(data, []), data);
});

test('pickNextOccurrence returns the earliest future match for the given series', () => {
  const now = new Date('2026-09-13T00:00:00.000Z').getTime();
  const events = [
    { uid: 'trivia', calendar: 'Scouts', start: '2025-11-14T19:00:00.000Z', title: 'Trivia Night (past)' },
    { uid: 'trivia', calendar: 'Scouts', start: '2026-11-14T19:00:00.000Z', title: 'Trivia Night' },
    { uid: 'other', calendar: 'Scouts', start: '2026-10-01T00:00:00.000Z', title: 'Other event' },
  ];
  const result = pickNextOccurrence(events, 'Scouts', 'trivia', now);
  assert.equal(result.start, '2026-11-14T19:00:00.000Z');
});

test('pickNextOccurrence returns null when there is no future match', () => {
  const now = new Date('2026-09-13T00:00:00.000Z').getTime();
  const events = [{ uid: 'trivia', calendar: 'Scouts', start: '2025-11-14T19:00:00.000Z' }];
  assert.equal(pickNextOccurrence(events, 'Scouts', 'trivia', now), null);
});

test('dedupeToSeries keeps one earliest row per calendar+uid pair, sorted by start', () => {
  const events = [
    { uid: 'weekly', calendar: 'Scouts', start: '2026-09-22T00:00:00.000Z', title: 'Troop Meeting' },
    { uid: 'weekly', calendar: 'Scouts', start: '2026-09-15T00:00:00.000Z', title: 'Troop Meeting' },
    { uid: 'trivia', calendar: 'Scouts', start: '2026-11-14T19:00:00.000Z', title: 'Trivia Night' },
  ];
  const result = dedupeToSeries(events);
  assert.equal(result.length, 2);
  assert.equal(result[0].start, '2026-09-15T00:00:00.000Z');
  assert.equal(result[1].title, 'Trivia Night');
});

test('computeCountdown returns whole days and remaining hours until start', () => {
  const now = new Date('2026-09-13T00:00:00.000Z').getTime();
  const start = new Date('2026-09-15T03:00:00.000Z').toISOString();
  assert.deepEqual(computeCountdown(start, now), { daysLeft: 2, hoursLeft: 3 });
});

test('computeCountdown clamps a past start to zero', () => {
  const now = new Date('2026-09-13T00:00:00.000Z').getTime();
  const start = new Date('2026-09-01T00:00:00.000Z').toISOString();
  assert.deepEqual(computeCountdown(start, now), { daysLeft: 0, hoursLeft: 0 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `filterHidden is not a function` (and similarly for the other three).

- [ ] **Step 3: Implement the four pure helpers**

In `lib/calendar.js`, add after the existing `normalize()` function (`lib/calendar.js:26-40`) and before `getCalendar()`:

```js
function filterHidden(data, hidden) {
  const hiddenSet = new Set(hidden || []);
  if (hiddenSet.size === 0) return data;
  return {
    ...data,
    calendars: data.calendars.filter((c) => !hiddenSet.has(c.name)),
    events: data.events.filter((e) => !hiddenSet.has(e.calendar)),
  };
}

function pickNextOccurrence(events, calendarName, uid, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  const matches = events
    .filter((e) => e.calendar === calendarName && e.uid === uid)
    .filter((e) => new Date(e.start).getTime() >= now)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return matches[0] || null;
}

function dedupeToSeries(events) {
  const seen = new Map();
  for (const e of events) {
    const key = `${e.calendar}::${e.uid}`;
    const existing = seen.get(key);
    if (!existing || e.start < existing.start) seen.set(key, e);
  }
  return Array.from(seen.values()).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

function computeCountdown(startIso, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  const ms = Math.max(0, new Date(startIso).getTime() - now);
  return {
    daysLeft: Math.floor(ms / 86400000),
    hoursLeft: Math.floor((ms % 86400000) / 3600000),
  };
}
```

Update the final export line at the bottom of `lib/calendar.js` from:

```js
module.exports = { getCalendar };
```

to:

```js
module.exports = { getCalendar, filterHidden, pickNextOccurrence, dedupeToSeries, computeCountdown };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests from Task 1 and Task 2 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/calendar.js test/calendar-pure.test.js
git commit -m "Add pure calendar helpers: filterHidden, pickNextOccurrence, dedupeToSeries, computeCountdown"
```

---

### Task 3: `lib/calendar.js` — wide-window I/O (`findNextOccurrence`, `listUpcomingSeries`)

These two functions do live network I/O (fetching real iCal URLs), so they are **not** unit tested — this project has no network mocking today and none is being introduced now. They're built directly on top of Task 2's pure functions and the existing `fetchCalendar()`, and verified manually against the real calendars already configured in the local `config.json`.

**Files:**
- Modify: `lib/calendar.js`

**Interfaces:**
- Consumes: `fetchCalendar(cal, start, end)` (existing, `lib/calendar.js:8-24`), `pickNextOccurrence` and `dedupeToSeries` (Task 2), `cache` (existing `makeCache()` instance, `lib/calendar.js:6`).
- Produces: `findNextOccurrence(config, calendarName, uid)` → `Promise<event | null>` (an event in the `normalize()` shape, or `null` if the calendar isn't found, the uid has no future occurrence, or the network call fails and there's no cached value).
- Produces: `listUpcomingSeries(config, days)` → `Promise<event[]>` — one row per series (see `dedupeToSeries`), sorted by `start`.

- [ ] **Step 1: Implement both functions**

In `lib/calendar.js`, add after `getCalendar()` and before `module.exports`:

```js
async function findNextOccurrence(config, calendarName, uid) {
  const cal = (config.calendars || []).find((c) => c.name === calendarName);
  if (!cal) return null;
  const ttl = (config.refresh && config.refresh.calendarMs) || 5 * 60 * 1000;
  const now = new Date();
  const end = new Date(now.getTime() + 400 * 24 * 60 * 60 * 1000);
  const events = await cache.get(`wide:${calendarName}`, ttl, () => fetchCalendar(cal, now, end));
  return pickNextOccurrence(events, calendarName, uid, Date.now());
}

async function listUpcomingSeries(config, days) {
  const cals = Array.isArray(config.calendars) ? config.calendars : [];
  const ttl = (config.refresh && config.refresh.calendarMs) || 5 * 60 * 1000;
  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const events = await cache.get(`wide:all:${days}`, ttl, async () => {
    const results = await Promise.allSettled(cals.map((c) => fetchCalendar(c, now, end)));
    const out = [];
    results.forEach((r) => {
      if (r.status === 'fulfilled') out.push(...r.value);
    });
    return out;
  });
  return dedupeToSeries(events);
}
```

Update the export line from:

```js
module.exports = { getCalendar, filterHidden, pickNextOccurrence, dedupeToSeries, computeCountdown };
```

to:

```js
module.exports = {
  getCalendar,
  filterHidden,
  pickNextOccurrence,
  dedupeToSeries,
  computeCountdown,
  findNextOccurrence,
  listUpcomingSeries,
};
```

- [ ] **Step 2: Manually verify against the real calendars in the local config**

The local `config.json` in this repo already has real family/Scouting calendar URLs configured, so this can be checked directly:

```bash
node -e "
const { loadConfig } = require('./lib/config');
const { listUpcomingSeries, findNextOccurrence } = require('./lib/calendar');
(async () => {
  const config = loadConfig();
  const series = await listUpcomingSeries(config, 365);
  console.log('series found:', series.length);
  console.log(series.slice(0, 5));
  if (series.length) {
    const one = series[0];
    const occ = await findNextOccurrence(config, one.calendar, one.uid);
    console.log('findNextOccurrence for first series:', occ);
  }
})();
"
```

Expected: prints a non-empty `series` list (no duplicate `calendar`+`uid` pairs — a recurring weekly event should appear once), and `findNextOccurrence` for the first series' `(calendar, uid)` returns an occurrence whose `start` is on or after the one `listUpcomingSeries` reported.

- [ ] **Step 3: Run the full test suite to make sure nothing else broke**

Run: `npm test`
Expected: PASS — same tests as Task 2, still passing.

- [ ] **Step 4: Commit**

```bash
git add lib/calendar.js
git commit -m "Add findNextOccurrence and listUpcomingSeries (wide-window calendar I/O)"
```

---

### Task 4: `server.js` — countdown + admin routes

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `loadState`/`saveState` (Task 1); `getCalendar`, `filterHidden`, `findNextOccurrence`, `listUpcomingSeries`, `computeCountdown` (Tasks 2-3).
- Produces: the routes in the table below, plus a `/admin` → `public/admin.html` static rewrite (consumed by Task 6).

| Route | Method | Response |
|---|---|---|
| `/api/calendar` | GET | existing `getCalendar()` result, filtered through `filterHidden` using the current state |
| `/api/countdown` | GET | `{active:false}` or `{active:true, title, start, calendarName, color, daysLeft, hoursLeft}` |
| `/api/admin/state` | GET | `{hiddenCalendars, countdown, calendars:[{name,color}]}` |
| `/api/admin/events` | GET | `{series: [...]}` — accepts `?days=` (default 365, clamped 1-400) |
| `/api/admin/calendars` | POST | body `{hidden: string[]}` → `{ok:true, hiddenCalendars}` |
| `/api/admin/countdown` | POST | body `{calendarName, uid, title}` or `{clear:true}` → `{ok:true, countdown}` |

No automated tests for this task — this project has no HTTP test harness today (verified via `curl` against a running `npm start`, matching how `/api/health` is already documented as the deploy verification point in `README.md`).

- [ ] **Step 1: Replace `server.js` with the updated routing**

Overwrite `server.js` with:

```js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./lib/config');
const { getWeather } = require('./lib/weather');
const {
  getCalendar,
  filterHidden,
  findNextOccurrence,
  listUpcomingSeries,
  computeCountdown,
} = require('./lib/calendar');
const camera = require('./lib/camera');
const { loadState, saveState } = require('./lib/state');

const config = loadConfig();
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, body, status = 200) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readJsonBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel).replace(/\.\.+/g, ''); // no path traversal
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, { error: 'bad url' }, 400);
  }

  try {
    if (url.pathname === '/api/health') {
      return sendJson(res, {
        ok: true,
        ts: Date.now(),
        configFrom: config._loadedFrom || '(defaults/env)',
        calendars: config.calendars.length,
        cameras: camera.listCameras(config).length,
      });
    }
    if (url.pathname === '/api/weather') {
      return sendJson(res, await getWeather(config));
    }
    if (url.pathname === '/api/calendar') {
      const data = await getCalendar(config);
      const state = loadState();
      return sendJson(res, filterHidden(data, state.hiddenCalendars));
    }
    if (url.pathname === '/api/countdown') {
      const state = loadState();
      if (!state.countdown) return sendJson(res, { active: false });
      const occ = await findNextOccurrence(config, state.countdown.calendarName, state.countdown.uid);
      if (!occ) return sendJson(res, { active: false });
      const { daysLeft, hoursLeft } = computeCountdown(occ.start, Date.now());
      return sendJson(res, {
        active: true,
        title: state.countdown.title || occ.title,
        start: occ.start,
        calendarName: state.countdown.calendarName,
        color: occ.color,
        daysLeft,
        hoursLeft,
      });
    }
    if (url.pathname === '/api/admin/state') {
      const state = loadState();
      return sendJson(res, {
        hiddenCalendars: state.hiddenCalendars,
        countdown: state.countdown,
        calendars: config.calendars.map((c) => ({ name: c.name, color: c.color })),
      });
    }
    if (url.pathname === '/api/admin/events') {
      const requested = Number(url.searchParams.get('days')) || 365;
      const days = Math.min(Math.max(requested, 1), 400);
      return sendJson(res, { series: await listUpcomingSeries(config, days) });
    }
    if (url.pathname === '/api/admin/calendars' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, { error: err.message }, 400);
      }
      if (!Array.isArray(body.hidden) || !body.hidden.every((n) => typeof n === 'string')) {
        return sendJson(res, { error: 'hidden must be an array of calendar names' }, 400);
      }
      const state = loadState();
      state.hiddenCalendars = body.hidden;
      saveState(state);
      return sendJson(res, { ok: true, hiddenCalendars: state.hiddenCalendars });
    }
    if (url.pathname === '/api/admin/countdown' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, { error: err.message }, 400);
      }
      const state = loadState();
      if (body.clear) {
        state.countdown = null;
      } else {
        if (!body.calendarName || !body.uid) {
          return sendJson(res, { error: 'calendarName and uid are required' }, 400);
        }
        state.countdown = {
          calendarName: String(body.calendarName),
          uid: String(body.uid),
          title: body.title ? String(body.title) : '',
        };
      }
      saveState(state);
      return sendJson(res, { ok: true, countdown: state.countdown });
    }
    if (url.pathname === '/api/cameras') {
      return sendJson(res, { cameras: camera.listCameras(config) });
    }
    const hlsMatch = url.pathname.match(/^\/api\/cam\/([A-Za-z0-9_-]+)\/hls(?:\/([A-Za-z0-9_-]+))?$/);
    if (hlsMatch) {
      return camera.proxyHls(config, hlsMatch[1], hlsMatch[2] || '', res, req);
    }
    const camMatch = url.pathname.match(/^\/api\/cam\/([A-Za-z0-9_-]+)\/(stream|snapshot)$/);
    if (camMatch) {
      return camera.proxy(config, camMatch[1], camMatch[2], res, req);
    }
    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, { error: 'unknown endpoint' }, 404);
    }
    const staticPath = url.pathname === '/admin' ? '/admin.html' : url.pathname;
    return serveStatic(staticPath, res);
  } catch (err) {
    console.error(`error handling ${url.pathname}:`, err);
    return sendJson(res, { error: String((err && err.message) || err) }, 502);
  } finally {
    if (url.pathname.startsWith('/api/')) {
      console.log(`${req.method} ${url.pathname} -> ${Date.now() - started}ms`);
    }
  }
});

server.listen(config.port, () => {
  console.log(`wall-display listening on :${config.port}`);
  console.log(`  config file: ${config._loadedFrom || '(none - defaults + env)'}`);
  console.log(`  location: ${config.lat}, ${config.lon}  tz: ${process.env.TZ || config.timezone}`);
  console.log(`  calendars: ${config.calendars.length} (from ${config._calendarsFrom || 'config file'})`);
  if (!config.nwsUserAgent) {
    console.warn('  WARNING: nwsUserAgent is empty -- set it to a contact email; NWS may throttle anonymous clients.');
  }
});
```

Note: `/admin.html` and `/admin.js` don't exist on disk yet (Task 6 creates them) — `serveStatic` will 404 for `/admin` until then. That's fine for this task's verification, which only checks the JSON API routes.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS — unchanged from Task 3 (this task only touches `server.js`, which has no unit tests).

- [ ] **Step 3: Manually verify the new routes**

```bash
npm start &
sleep 1
curl -s http://localhost:8080/api/admin/state
curl -s "http://localhost:8080/api/admin/events?days=365" | head -c 500
curl -s http://localhost:8080/api/countdown
curl -s -X POST http://localhost:8080/api/admin/calendars -H "Content-Type: application/json" -d "{\"hidden\":[\"Scouts\"]}"
curl -s http://localhost:8080/api/calendar | grep -o "Scouts" # expect no output now
curl -s -X POST http://localhost:8080/api/admin/calendars -H "Content-Type: application/json" -d "{\"hidden\":[]}"
kill %1
```

Expected:
- `/api/admin/state` returns `{"hiddenCalendars":[],"countdown":null,"calendars":[...]}`.
- `/api/admin/events` returns a `series` array.
- `/api/countdown` returns `{"active":false}` (nothing selected yet).
- The `POST /api/admin/calendars` call returns `{"ok":true,"hiddenCalendars":["Scouts"]}`, and the following `curl ... | grep Scouts` prints nothing (the calendar is now filtered out of `/api/calendar`).
- The final `POST` restores `hiddenCalendars` to `[]` so later tasks start clean.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "Wire countdown + admin routes into server.js"
```

---

### Task 5: Display widget — countdown card replaces "Hourly" when active

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `GET /api/countdown` (Task 4) → `{active:false}` or `{active:true, title, start, calendarName, color, daysLeft, hoursLeft}`.
- Produces: no new interfaces for later tasks (this is the last consumer of `/api/countdown` on the display side).

- [ ] **Step 1: Add the countdown card markup**

In `public/index.html`, change the `#rail` block (currently at `public/index.html:60-69`):

```html
    <aside id="rail">
      <div class="card">
        <h2>Hourly</h2>
        <div id="hourly" class="hourly"></div>
      </div>
      <div class="card">
        <h2>Forecast</h2>
        <div id="forecast" class="forecast"></div>
      </div>
    </aside>
```

to:

```html
    <aside id="rail">
      <div class="card" id="hourlyCard">
        <h2>Hourly</h2>
        <div id="hourly" class="hourly"></div>
      </div>
      <div class="card" id="countdownCard" hidden>
        <h2 id="countdownTitle">Countdown</h2>
        <div id="countdown" class="countdown"></div>
      </div>
      <div class="card">
        <h2>Forecast</h2>
        <div id="forecast" class="forecast"></div>
      </div>
    </aside>
```

- [ ] **Step 2: Add countdown styles**

In `public/style.css`, add after the `.forecast` / `.fc` rules (after `public/style.css:177`, right before the `/* ---------- status bar ---------- */` comment):

```css
.countdown {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 10px 0 4px;
}
.cd-num { font-size: 64px; font-weight: 300; line-height: 1; }
.cd-unit {
  font-size: 20px;
  color: var(--dim);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-top: 2px;
}
.cd-date { font-size: 18px; color: var(--dim); margin-top: 10px; }
```

- [ ] **Step 3: Add `loadCountdown()` / `renderCountdown()` to `app.js`**

In `public/app.js`, add `countdown: null` to the `state` object (`public/app.js:9-17`):

```js
var state = {
  weather: null,
  weatherAt: 0,
  weatherFail: 0,
  calendar: null,
  calendarAt: 0,
  calendarFail: 0,
  countdown: null,
  bootAt: Date.now(),
};
```

Add the following two functions right after `renderCalendar()`'s helpers, i.e. after `escapeHtml()` (`public/app.js:266-270`) and before the `/* cameras */` section comment:

```js
/* ------------------------------------------------------------------ countdown */

function renderCountdown() {
  var c = state.countdown;
  var hourlyCard = $('hourlyCard');
  var countdownCard = $('countdownCard');
  if (!c || !c.active) {
    hourlyCard.hidden = false;
    countdownCard.hidden = true;
    return;
  }
  hourlyCard.hidden = true;
  countdownCard.hidden = false;

  var big = c.daysLeft > 0 ? c.daysLeft : c.hoursLeft;
  var unit;
  if (c.daysLeft > 0) {
    unit = c.daysLeft === 1 ? 'day' : 'days';
  } else {
    unit = c.hoursLeft === 1 ? 'hour' : 'hours';
  }
  var targetDate = new Date(c.start);

  var titleEl = $('countdownTitle');
  titleEl.textContent = c.title || 'Countdown';
  titleEl.style.color = c.color || '';

  $('countdown').innerHTML =
    '<div class="cd-num">' + big + '</div>' +
    '<div class="cd-unit">' + unit + '</div>' +
    '<div class="cd-date">' +
    targetDate.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) +
    '</div>';
}

function loadCountdown() {
  return fetchJSON('/api/countdown')
    .then(function (data) {
      state.countdown = data;
      renderCountdown();
    })
    .catch(function (err) {
      console.warn('countdown fetch failed', err);
    });
}
```

- [ ] **Step 4: Wire `loadCountdown()` into the boot + refresh loops**

In `public/app.js`, in `start()` (`public/app.js:583-600`), change:

```js
  loadWeather();
  loadCalendar();
  setInterval(loadWeather, WEATHER_MS);
  setInterval(loadCalendar, CAL_MS);
  setInterval(renderStatus, 30000);
  setInterval(renderCalendar, 60000); // keep "Today/Tomorrow" honest across midnight

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { loadWeather(); loadCalendar(); }
  });
```

to:

```js
  loadWeather();
  loadCalendar();
  loadCountdown();
  setInterval(loadWeather, WEATHER_MS);
  setInterval(loadCalendar, CAL_MS);
  setInterval(loadCountdown, CAL_MS);
  setInterval(renderStatus, 30000);
  setInterval(renderCalendar, 60000); // keep "Today/Tomorrow" honest across midnight

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { loadWeather(); loadCalendar(); loadCountdown(); }
  });
```

- [ ] **Step 5: Manually verify in the browser**

```bash
npm start &
sleep 1
curl -s http://localhost:8080/api/admin/events?days=365 | head -c 800
```

Note one `calendar` + `uid` pair from that output, then:

```bash
curl -s -X POST http://localhost:8080/api/admin/countdown -H "Content-Type: application/json" -d "{\"calendarName\":\"<calendar from above>\",\"uid\":\"<uid from above>\",\"title\":\"Test Event\"}"
```

Open `http://localhost:8080/` in a browser (or the Browser pane tool): the "Hourly" card should be replaced by a "Test Event" countdown card showing a number, unit, and date. Then clear it and confirm the hourly card comes back:

```bash
curl -s -X POST http://localhost:8080/api/admin/countdown -H "Content-Type: application/json" -d "{\"clear\":true}"
```

Reload the page — the Hourly card should be showing again. Then:

```bash
kill %1
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS — unchanged (this task has no unit-testable logic; it's DOM wiring).

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "Display: countdown card replaces Hourly forecast when an event is selected"
```

---

### Task 6: Admin page — `public/admin.html` + `public/admin.js`

**Files:**
- Create: `public/admin.html`
- Create: `public/admin.js`

**Interfaces:**
- Consumes: `GET /api/admin/state`, `GET /api/admin/events?days=365`, `POST /api/admin/calendars`, `POST /api/admin/countdown` (all from Task 4).
- Produces: nothing consumed by later tasks — this is the last piece of application code.

- [ ] **Step 1: Create `public/admin.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wall Display Admin</title>
<link rel="icon" href="data:," />
<style>
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    background: #0f1216;
    color: #e9ebee;
    margin: 0;
    padding: 24px;
  }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 {
    font-size: 16px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #97a0aa;
    margin: 28px 0 10px;
  }
  .card { background: #171c22; border-radius: 10px; padding: 16px 18px; max-width: 640px; }
  .cal-row, .ev-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid #2a323c;
  }
  .cal-row:last-child, .ev-row:last-child { border-bottom: none; }
  .dot { width: 11px; height: 11px; border-radius: 3px; flex: none; }
  .ev-group h3 { font-size: 14px; color: #97a0aa; margin: 14px 0 4px; }
  .ev-row { cursor: pointer; }
  .ev-row.selected { background: #1f262e; }
  .ev-title { flex: 1; }
  .ev-date { color: #97a0aa; font-size: 13px; }
  button {
    font: inherit;
    background: #1f262e;
    color: #e9ebee;
    border: 1px solid #2a323c;
    border-radius: 6px;
    padding: 8px 14px;
    cursor: pointer;
  }
  #flash { font-size: 13px; color: #5aa9ff; margin-left: 10px; }
  #eventList { max-height: 420px; overflow-y: auto; }
</style>
</head>
<body>
<h1>Wall Display Admin</h1>
<span id="flash"></span>

<h2>Calendars</h2>
<div class="card"><div id="calendarList">Loading&hellip;</div></div>

<h2>Countdown Event <button id="clearBtn" type="button">Clear countdown</button></h2>
<div class="card"><div id="eventList">Loading&hellip;</div></div>

<script src="/admin.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/admin.js`**

```js
'use strict';

function $(id) { return document.getElementById(id); }

function fetchJSON(url, opts) {
  return fetch(url, opts).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function flash(msg) {
  var el = $('flash');
  el.textContent = msg;
  setTimeout(function () {
    if (el.textContent === msg) el.textContent = '';
  }, 2000);
}

var adminState = { hiddenCalendars: [], countdown: null, calendars: [] };

function renderCalendars() {
  var host = $('calendarList');
  host.innerHTML = '';
  adminState.calendars.forEach(function (c) {
    var row = document.createElement('label');
    row.className = 'cal-row';

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = adminState.hiddenCalendars.indexOf(c.name) === -1;
    cb.addEventListener('change', function () { toggleCalendar(c.name, cb.checked); });

    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = c.color || '#5aa9ff';

    var label = document.createElement('span');
    label.textContent = c.name;

    row.appendChild(cb);
    row.appendChild(dot);
    row.appendChild(label);
    host.appendChild(row);
  });
}

function toggleCalendar(name, shown) {
  var hidden = adminState.hiddenCalendars.filter(function (n) { return n !== name; });
  if (!shown) hidden.push(name);
  return fetchJSON('/api/admin/calendars', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden: hidden }),
  }).then(function (data) {
    adminState.hiddenCalendars = data.hiddenCalendars;
    flash('Saved');
  }).catch(function (err) {
    console.error('save calendars failed', err);
    flash('Save failed');
    renderCalendars(); // revert the checkbox to the last known-good state
  });
}

function isSelected(ev) {
  var c = adminState.countdown;
  return !!c && c.calendarName === ev.calendar && c.uid === ev.uid;
}

function renderEvents(series) {
  var host = $('eventList');
  host.innerHTML = '';
  if (!series.length) {
    host.textContent = 'No upcoming events found.';
    return;
  }
  var groups = {};
  var order = [];
  series.forEach(function (ev) {
    if (!groups[ev.calendar]) {
      groups[ev.calendar] = [];
      order.push(ev.calendar);
    }
    groups[ev.calendar].push(ev);
  });
  order.forEach(function (calName) {
    var group = document.createElement('div');
    group.className = 'ev-group';

    var h3 = document.createElement('h3');
    h3.textContent = calName;
    group.appendChild(h3);

    groups[calName].forEach(function (ev) {
      var row = document.createElement('div');
      row.className = 'ev-row' + (isSelected(ev) ? ' selected' : '');

      var title = document.createElement('span');
      title.className = 'ev-title';
      title.textContent = ev.title;

      var date = document.createElement('span');
      date.className = 'ev-date';
      date.textContent = new Date(ev.start).toLocaleDateString([], {
        month: 'short', day: 'numeric', year: 'numeric',
      });

      row.appendChild(title);
      row.appendChild(date);
      row.addEventListener('click', function () { selectCountdown(ev); });
      group.appendChild(row);
    });

    host.appendChild(group);
  });
}

function selectCountdown(ev) {
  return fetchJSON('/api/admin/countdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarName: ev.calendar, uid: ev.uid, title: ev.title }),
  }).then(function (data) {
    adminState.countdown = data.countdown;
    flash('Countdown set');
    loadEvents();
  }).catch(function (err) {
    console.error('set countdown failed', err);
    flash('Save failed');
  });
}

function clearCountdown() {
  return fetchJSON('/api/admin/countdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clear: true }),
  }).then(function (data) {
    adminState.countdown = data.countdown;
    flash('Countdown cleared');
    loadEvents();
  }).catch(function (err) {
    console.error('clear countdown failed', err);
    flash('Save failed');
  });
}

function loadEvents() {
  return fetchJSON('/api/admin/events?days=365')
    .then(function (data) { renderEvents(data.series || []); })
    .catch(function (err) {
      console.error('events fetch failed', err);
      $('eventList').textContent = 'Failed to load events.';
    });
}

function start() {
  fetchJSON('/api/admin/state')
    .then(function (data) {
      adminState.hiddenCalendars = data.hiddenCalendars || [];
      adminState.countdown = data.countdown || null;
      adminState.calendars = data.calendars || [];
      renderCalendars();
      return loadEvents();
    })
    .catch(function (err) {
      console.error('admin state fetch failed', err);
      $('calendarList').textContent = 'Failed to load.';
    });

  $('clearBtn').addEventListener('click', clearCountdown);
}

start();
```

- [ ] **Step 3: Manually verify the admin page end-to-end**

```bash
npm start &
sleep 1
```

Open `http://localhost:8080/admin` in a browser (or the Browser pane tool):
- The Calendars section lists every calendar from `config.json` with a checked checkbox.
- Unchecking one shows a brief "Saved" flash; reloading the page keeps it unchecked.
- The Countdown Event section lists upcoming events grouped by calendar.
- Clicking a row shows "Countdown set" and highlights that row; reloading `http://localhost:8080/admin` keeps it highlighted.
- Opening `http://localhost:8080/` (the actual display) now shows the countdown card instead of Hourly, matching the row just clicked.
- Clicking "Clear countdown" on the admin page shows "Countdown cleared"; reloading the display shows the Hourly card again.
- Confirm nothing on `http://localhost:8080/` (view page source or inspect) contains a link to `/admin`.

Re-check `hidden` on the calendar you unchecked earlier — leave calendars in their original (all-shown) state when done:

```bash
curl -s -X POST http://localhost:8080/api/admin/calendars -H "Content-Type: application/json" -d "{\"hidden\":[]}"
kill %1
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — unchanged (no unit-testable logic added in this task).

- [ ] **Step 5: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "Add unlinked /admin page for calendar visibility + countdown selection"
```

---

### Task 7: Deploy — Docker volume for `state.json`, README docs

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `STATE_PATH` env var (Task 1's `resolveStatePath()` already honors it — no code change needed here, just wiring it in the deploy files).

- [ ] **Step 1: Give the non-root container user write access to the state directory**

The container runs as `USER node` (non-root). A Docker named volume mounted at a path that doesn't already exist in the image gets created owned by `root`, which would make `saveState()` fail with `EACCES` at runtime. Fix this the same way `config/` is already handled — create the directory and hand it to `node` before switching users.

In `Dockerfile`, change:

```dockerfile
# Config is bind-mounted at runtime (see docker-compose.yml)
RUN mkdir -p /app/config
```

to:

```dockerfile
# Config is bind-mounted at runtime; state.json is a named volume (see docker-compose.yml)
RUN mkdir -p /app/config /app/state && chown -R node:node /app/state
```

- [ ] **Step 2: Add the named volume and `STATE_PATH` to `docker-compose.yml`**

In `docker-compose.yml`, change:

```yaml
    environment:
      TZ: "${TZ:-America/Chicago}"
      NWS_USER_AGENT: "${NWS_USER_AGENT:-family-screen}"
      CALENDARS_JSON: "${CALENDARS_JSON:-[]}"
      LAT: "${LAT:-37.3059}"
      LON: "${LON:--89.5181}"
      HA_BASE_URL: "${HA_BASE_URL:-http://homeassistant.local:8123}"
      HA_TOKEN: "${HA_TOKEN:-}"
      HA_CAMERAS_JSON: '[{"id":"front","name":"Front Door","entity":"camera.front_door_live_view"},{"id":"driveway","name":"Driveway","entity":"camera.driveway_live_view"},{"id":"backyard","name":"Back Yard","entity":"camera.backyard_live_view"}]'
```

to:

```yaml
    environment:
      TZ: "${TZ:-America/Chicago}"
      NWS_USER_AGENT: "${NWS_USER_AGENT:-family-screen}"
      CALENDARS_JSON: "${CALENDARS_JSON:-[]}"
      LAT: "${LAT:-37.3059}"
      LON: "${LON:--89.5181}"
      HA_BASE_URL: "${HA_BASE_URL:-http://homeassistant.local:8123}"
      HA_TOKEN: "${HA_TOKEN:-}"
      HA_CAMERAS_JSON: '[{"id":"front","name":"Front Door","entity":"camera.front_door_live_view"},{"id":"driveway","name":"Driveway","entity":"camera.driveway_live_view"},{"id":"backyard","name":"Back Yard","entity":"camera.backyard_live_view"}]'
      STATE_PATH: /app/state/state.json
    volumes:
      - wall-display-state:/app/state

volumes:
  wall-display-state:
```

(The new `volumes:` line under the service and the top-level `volumes:` block at the end of the file are two separate additions — Compose requires both: one to mount it into the container, one to declare the named volume exists.)

- [ ] **Step 3: Document the feature in `README.md`**

In `README.md`, add a new section right after `## 4. Set up the Fire HD 8 as a wall panel` (`README.md:136-150`) and before `## Notes`:

```markdown
## 5. Event countdown + admin page

Optional: replace the "Hourly" forecast card with a countdown to a picked
calendar event.

- Visit `http://<homelab-ip>:8080/admin` from any computer on the LAN — no
  auth, and nothing on the wall display links to it — to:
  - toggle which configured calendars show on the display
  - pick which upcoming calendar event to count down to (a recurring event
    keeps tracking its next occurrence automatically; no need to reselect
    it after it passes)
- The display falls back to the Hourly forecast whenever nothing is
  selected, or the selected event has already passed.
- Admin choices are stored in `state.json`, separate from `config.json`.
  For a local run it lands next to `config.json` (or in `./state.json`);
  for the Portainer deploy it needs the `wall-display-state` volume
  (already declared in `docker-compose.yml`) so choices survive a
  redeploy.
```

- [ ] **Step 4: Run the full test suite one last time**

Run: `npm test`
Expected: PASS — same tests as Task 6 (this task only touches deploy config and docs).

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml README.md
git commit -m "Deploy: persist state.json across redeploys via a named Docker volume"
```

---

## After this plan lands

Update [[PROJECT-Kindle Wall Display]] and [[DESIGN-Countdown-Admin]] in the Brain vault: mark the feature built, note the commits, and move the "Remaining" item from "design done, not yet built" to whatever's left (pushing to the Portainer stack, setting `HA_TOKEN`-style env vars if any are needed, and Justin actually picking a countdown event on the real deploy).
