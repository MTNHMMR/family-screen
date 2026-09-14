# Multi-Event Countdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the admin select multiple calendar events to count down to; the wall display cycles through all of them with a fade transition, soonest-first, falling back to Hourly only when none survive.

**Architecture:** `state.json`'s single `countdown` object becomes a `countdowns` array (with transparent migration from the old shape). `/api/countdown` resolves every entry in parallel, drops expired/gone ones, and returns a sorted `items` array instead of one flat object. The display's `renderCountdown()` splits into an initial render plus a `setInterval`-driven rotation that fades the card's content out, swaps it, and fades back in. The admin page's single-select event rows become checkboxes that always POST the complete current selection.

**Tech Stack:** Same as the base feature — Node.js built-in `http`, no framework, no build step, Node's built-in `node:test` for the two automated-test tasks. No new dependencies.

## Global Constraints

- No new npm dependencies.
- No build step. `public/` stays plain HTML/CSS/vanilla ES5-leaning JS (`var`, function declarations — matches `app.js`/`admin.js`'s existing style).
- Cycle order is always soonest-first (server-computed), never admin selection order.
- Rotation interval is a fixed 10000ms; fade is a fixed ~300ms CSS opacity transition — neither is user-configurable.
- `state.json`'s field is `countdowns` (array), not `countdown` (object) — old singular `countdown` values are migrated transparently on load, never written back in the old shape.
- Full spec: `docs/superpowers/specs/2026-09-13-multi-countdown-design.md`.

---

### Task 1: `lib/state.js` — `countdowns` array with legacy migration

**Files:**
- Modify: `lib/state.js`
- Modify: `test/state.test.js`

**Interfaces:**
- Produces: `loadState()` → `{ hiddenCalendars: string[], countdowns: Array<{calendarName: string, uid: string, title: string}> }`. Always this shape — a missing/invalid file, or a legacy single `countdown` field, both normalize into it.
- `saveState(state)` and `resolveStatePath()` are unchanged (still exported, same signatures) — only the shape of the object passed to/from them changes.

- [ ] **Step 1: Update the existing tests to the new `countdowns` shape, and add migration tests**

Replace the full contents of `test/state.test.js` with:

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
    assert.deepEqual(state.loadState(), { hiddenCalendars: [], countdowns: [] });
  });
});

test('saveState then loadState round-trips hiddenCalendars and countdowns', () => {
  withTempStatePath(() => {
    state.saveState({
      hiddenCalendars: ['Scouts'],
      countdowns: [
        { calendarName: 'Family', uid: 'abc123', title: 'Trivia Night' },
        { calendarName: 'Elizabeth', uid: 'def456', title: 'Softball Round Robin' },
      ],
    });
    assert.deepEqual(state.loadState(), {
      hiddenCalendars: ['Scouts'],
      countdowns: [
        { calendarName: 'Family', uid: 'abc123', title: 'Trivia Night' },
        { calendarName: 'Elizabeth', uid: 'def456', title: 'Softball Round Robin' },
      ],
    });
  });
});

test('loadState returns defaults when the file has invalid JSON', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not valid json');
    assert.deepEqual(state.loadState(), { hiddenCalendars: [], countdowns: [] });
  });
});

test('loadState normalizes a malformed hiddenCalendars field to an empty array', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hiddenCalendars: 'not-an-array', countdowns: [] }));
    assert.deepEqual(state.loadState().hiddenCalendars, []);
  });
});

test('loadState migrates a legacy singular countdown object into a one-item countdowns array', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      hiddenCalendars: [],
      countdown: { calendarName: 'Family', uid: 'abc123', title: 'Trivia Night' },
    }));
    assert.deepEqual(state.loadState().countdowns, [
      { calendarName: 'Family', uid: 'abc123', title: 'Trivia Night' },
    ]);
  });
});

test('loadState migrates a legacy null countdown into an empty countdowns array', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hiddenCalendars: [], countdown: null }));
    assert.deepEqual(state.loadState().countdowns, []);
  });
});

test('loadState prefers a present countdowns array over a legacy countdown field', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      hiddenCalendars: [],
      countdown: { calendarName: 'Old', uid: 'old-uid', title: 'Old Selection' },
      countdowns: [{ calendarName: 'New', uid: 'new-uid', title: 'New Selection' }],
    }));
    assert.deepEqual(state.loadState().countdowns, [
      { calendarName: 'New', uid: 'new-uid', title: 'New Selection' },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — the round-trip and migration tests fail because `lib/state.js` still reads/writes a singular `countdown` field, not `countdowns`.

- [ ] **Step 3: Implement the `countdowns` shape and migration in `lib/state.js`**

Replace the full contents of `lib/state.js` with:

```js
'use strict';

const fs = require('fs');
const path = require('path');

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
    const hiddenCalendars = Array.isArray(parsed.hiddenCalendars) ? parsed.hiddenCalendars : [];

    let countdowns;
    if (Array.isArray(parsed.countdowns)) {
      countdowns = parsed.countdowns.filter((c) => c && typeof c === 'object');
    } else if (parsed.countdown && typeof parsed.countdown === 'object') {
      // Legacy shape from before multi-select: a single countdown object.
      countdowns = [parsed.countdown];
    } else {
      countdowns = [];
    }

    return { hiddenCalendars, countdowns };
  } catch (err) {
    return { hiddenCalendars: [], countdowns: [] };
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
Expected: PASS — 7 tests in this file (was 4), plus all other existing test files unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/state.js test/state.test.js
git commit -m "state: replace singular countdown with a countdowns array, migrate legacy shape"
```

---

### Task 2: `server.js` — multi-item `/api/countdown`, admin routes updated

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `loadState()`/`saveState()` (Task 1, now `countdowns` array); `findNextOccurrence`, `computeCountdown` (unchanged from the base feature, still resolve one series at a time).
- Produces: `GET /api/countdown` → `{ active: boolean, items: Array<{title, start, calendarName, color, daysLeft, hoursLeft}> }`, sorted by `start` ascending. `GET /api/admin/state` → `{ hiddenCalendars, countdowns, calendars }` (renamed field, consumed by Task 4). `POST /api/admin/countdown` → body `{ items: Array<{calendarName, uid, title}> }` or `{ clear: true }`, response `{ ok: true, countdowns }`.

No automated tests for this task — matches the established pattern for this file (verified manually via curl against a running server).

- [ ] **Step 1: Update `/api/countdown` to resolve every selected series**

In `server.js`, replace the `/api/countdown` block (currently):

```js
    if (url.pathname === '/api/countdown') {
      const state = loadState();
      if (!state.countdown) return sendJson(res, { active: false });
      const occ = await findNextOccurrence(config, state.countdown.calendarName, state.countdown.uid);
      if (!occ) return sendJson(res, { active: false });
      const { daysLeft, hoursLeft } = computeCountdown(occ.start, Date.now());
      return sendJson(res, {
        active: true,
        title: occ.title || state.countdown.title,
        start: occ.start,
        calendarName: state.countdown.calendarName,
        color: occ.color,
        daysLeft,
        hoursLeft,
      });
    }
```

with:

```js
    if (url.pathname === '/api/countdown') {
      const state = loadState();
      const resolved = await Promise.all(
        state.countdowns.map((c) =>
          findNextOccurrence(config, c.calendarName, c.uid).then((occ) => ({ c, occ }))
        )
      );
      const items = resolved
        .filter((r) => r.occ)
        .map((r) => {
          const { daysLeft, hoursLeft } = computeCountdown(r.occ.start, Date.now());
          return {
            title: r.occ.title || r.c.title,
            start: r.occ.start,
            calendarName: r.c.calendarName,
            color: r.occ.color,
            daysLeft,
            hoursLeft,
          };
        })
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      return sendJson(res, { active: items.length > 0, items });
    }
```

- [ ] **Step 2: Update `/api/admin/state` to expose `countdowns` instead of `countdown`**

Replace:

```js
    if (url.pathname === '/api/admin/state') {
      const state = loadState();
      return sendJson(res, {
        hiddenCalendars: state.hiddenCalendars,
        countdown: state.countdown,
        calendars: config.calendars.map((c) => ({ name: c.name, color: c.color })),
      });
    }
```

with:

```js
    if (url.pathname === '/api/admin/state') {
      const state = loadState();
      return sendJson(res, {
        hiddenCalendars: state.hiddenCalendars,
        countdowns: state.countdowns,
        calendars: config.calendars.map((c) => ({ name: c.name, color: c.color })),
      });
    }
```

- [ ] **Step 3: Update `POST /api/admin/countdown` to replace the whole selection list**

Replace:

```js
    if (url.pathname === '/api/admin/countdown' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, { error: err.message }, 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
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
```

with:

```js
    if (url.pathname === '/api/admin/countdown' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, { error: err.message }, 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
      const state = loadState();
      if (body.clear) {
        state.countdowns = [];
      } else {
        const valid = Array.isArray(body.items) &&
          body.items.every((it) => it && typeof it === 'object' && it.calendarName && it.uid);
        if (!valid) {
          return sendJson(res, { error: 'items must be an array of {calendarName, uid, title}' }, 400);
        }
        state.countdowns = body.items.map((it) => ({
          calendarName: String(it.calendarName),
          uid: String(it.uid),
          title: it.title ? String(it.title) : '',
        }));
      }
      saveState(state);
      return sendJson(res, { ok: true, countdowns: state.countdowns });
    }
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — unchanged from Task 1 (this task only touches `server.js`, which has no unit tests).

- [ ] **Step 5: Manually verify the updated routes**

```bash
npm start &
sleep 1
curl -s http://localhost:8080/api/admin/state
```

Expected: `{"hiddenCalendars":[],"countdowns":[],"calendars":[...]}`.

```bash
curl -s "http://localhost:8080/api/admin/events?days=365" | head -c 900
```

Note two different `{calendar, uid}` pairs from the output (call them EVENT_A and EVENT_B, from two different calendars if possible), then:

```bash
curl -s -X POST http://localhost:8080/api/admin/countdown -H "Content-Type: application/json" \
  -d '{"items":[{"calendarName":"<EVENT_A calendar>","uid":"<EVENT_A uid>","title":"Event A"},{"calendarName":"<EVENT_B calendar>","uid":"<EVENT_B uid>","title":"Event B"}]}'
curl -s http://localhost:8080/api/countdown
```

Expected: the `POST` returns `{"ok":true,"countdowns":[...]}` with both entries; the following `GET /api/countdown` returns `{"active":true,"items":[...]}` with **two** items, sorted so the soonest `start` comes first regardless of which order they were POSTed in.

```bash
curl -s -X POST http://localhost:8080/api/admin/countdown -H "Content-Type: application/json" -d '{"clear":true}'
curl -s http://localhost:8080/api/countdown
kill %1
```

Expected: `{"ok":true,"countdowns":[]}` then `{"active":false,"items":[]}`. Leave state clean (empty) when done.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "server: resolve multiple selected countdown series, sorted soonest-first"
```

---

### Task 3: Display — rotate through multiple countdown items with a fade

**Files:**
- Modify: `public/app.js`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `GET /api/countdown` (Task 2) → `{ active: boolean, items: Array<{title, start, calendarName, color, daysLeft, hoursLeft}> }`.
- Produces: no new interfaces for later tasks — this is the last consumer of `/api/countdown` on the display side.

No automated tests for this task (DOM/timer wiring) — matches the established pattern; verified manually.

- [ ] **Step 1: Add rotation state and constants**

In `public/app.js`, add two new constants near the top alongside the existing ones (after `var RELOAD_MIN = 30;`, currently line 7):

```js
var COUNTDOWN_ROTATE_MS = 10000;
var COUNTDOWN_FADE_MS = 300;
```

Add `countdownIdx: 0` and `countdownTimer: null` to the `state` object (currently lines 9-18):

```js
var state = {
  weather: null,
  weatherAt: 0,
  weatherFail: 0,
  calendar: null,
  calendarAt: 0,
  calendarFail: 0,
  countdown: null,
  countdownIdx: 0,
  countdownTimer: null,
  bootAt: Date.now(),
};
```

- [ ] **Step 2: Split `renderCountdown()` into a per-item renderer plus a rotation driver**

Replace the existing `renderCountdown()` function (currently in the `/* countdown */` section) — the whole function from `function renderCountdown() {` through its closing `}` — with these four functions:

```js
function stopCountdownRotation() {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
}

function renderCountdownItem(item) {
  var big = item.daysLeft > 0 ? item.daysLeft : item.hoursLeft;
  var unit;
  if (item.daysLeft > 0) {
    unit = item.daysLeft === 1 ? 'day' : 'days';
  } else {
    unit = item.hoursLeft === 1 ? 'hour' : 'hours';
  }
  var targetDate = parseEventStart(item.start);

  var titleEl = $('countdownTitle');
  titleEl.textContent = item.title || 'Countdown';
  titleEl.style.color = item.color || '';

  $('countdown').innerHTML =
    '<div class="cd-num">' + big + '</div>' +
    '<div class="cd-unit">' + unit + '</div>' +
    '<div class="cd-date">' +
    targetDate.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) +
    '</div>';
}

function advanceCountdown() {
  var items = (state.countdown && state.countdown.items) || [];
  if (items.length === 0) return;
  var el = $('countdown');
  el.classList.add('fade-out');
  setTimeout(function () {
    state.countdownIdx = (state.countdownIdx + 1) % items.length;
    renderCountdownItem(items[state.countdownIdx]);
    el.classList.remove('fade-out');
  }, COUNTDOWN_FADE_MS);
}

function renderCountdown() {
  var c = state.countdown;
  var hourlyCard = $('hourlyCard');
  var countdownCard = $('countdownCard');
  var items = (c && c.items) || [];
  if (!c || !c.active || items.length === 0) {
    hourlyCard.hidden = false;
    countdownCard.hidden = true;
    stopCountdownRotation();
    return;
  }
  hourlyCard.hidden = true;
  countdownCard.hidden = false;

  stopCountdownRotation();
  state.countdownIdx = 0;
  renderCountdownItem(items[0]);
  state.countdownTimer = setInterval(advanceCountdown, COUNTDOWN_ROTATE_MS);
}
```

Do not change `loadCountdown()` — it already stores the raw `/api/countdown` response into `state.countdown` and calls `renderCountdown()`, which is exactly what the new multi-item shape needs.

- [ ] **Step 3: Add the fade CSS**

In `public/style.css`, add right after the existing `.cd-date` rule (currently the line `.cd-date { font-size: 18px; color: var(--dim); margin-top: 10px; }`):

```css
.countdown { transition: opacity 0.3s; }
.countdown.fade-out { opacity: 0; }
```

- [ ] **Step 4: Manually verify rotation and fade in a browser**

```bash
npm start &
sleep 1
curl -s "http://localhost:8080/api/admin/events?days=365" | head -c 900
```

Pick two different upcoming events (EVENT_A, EVENT_B — ideally on different calendars so the color change is visible), then:

```bash
curl -s -X POST http://localhost:8080/api/admin/countdown -H "Content-Type: application/json" \
  -d '{"items":[{"calendarName":"<EVENT_A calendar>","uid":"<EVENT_A uid>","title":"Event A"},{"calendarName":"<EVENT_B calendar>","uid":"<EVENT_B uid>","title":"Event B"}]}'
```

Open `http://localhost:8080/` in a browser (or the Browser pane tool). Confirm:
- The countdown card shows the soonest of the two events first.
- After ~10 seconds, the card briefly fades out and back in showing the other event.
- After another ~10 seconds, it rotates back to the first.
- The title color changes to match each event's calendar.

Then clear the selection and confirm the Hourly card returns:

```bash
curl -s -X POST http://localhost:8080/api/admin/countdown -H "Content-Type: application/json" -d '{"clear":true}'
```

Reload the page — Hourly should be showing again. Then:

```bash
kill %1
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — unchanged (this task has no unit-testable logic; it's DOM/timer wiring).

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/style.css
git commit -m "display: rotate through multiple countdown items with a fade transition"
```

---

### Task 4: Admin page — checkboxes for multi-select

**Files:**
- Modify: `public/admin.html`
- Modify: `public/admin.js`

**Interfaces:**
- Consumes: `GET /api/admin/state` → now `{ hiddenCalendars, countdowns, calendars }` (Task 2); `GET /api/admin/events?days=365` (unchanged); `POST /api/admin/countdown` → now takes `{ items: [...] }` or `{ clear: true }` (Task 2).
- Produces: nothing consumed by later tasks — this is the last piece of application code for this feature.

No automated tests for this task — matches the established pattern; verified manually.

- [ ] **Step 1: Relabel the clear button**

In `public/admin.html`, change:

```html
<h2>Countdown Event <button id="clearBtn" type="button">Clear countdown</button></h2>
```

to:

```html
<h2>Countdown Events <button id="clearBtn" type="button">Clear all</button></h2>
```

- [ ] **Step 2: Rewrite `admin.js`'s countdown-selection logic for multi-select**

In `public/admin.js`, change the initial `adminState` object (currently line 26):

```js
var adminState = { hiddenCalendars: [], countdown: null, calendars: [] };
```

to:

```js
var adminState = { hiddenCalendars: [], countdowns: [], calendars: [] };
```

Replace `isSelected(ev)` (currently lines 71-74):

```js
function isSelected(ev) {
  var c = adminState.countdown;
  return !!c && c.calendarName === ev.calendar && c.uid === ev.uid;
}
```

with:

```js
function isSelected(ev) {
  return adminState.countdowns.some(function (c) {
    return c.calendarName === ev.calendar && c.uid === ev.uid;
  });
}
```

In `renderEvents(series)`, the event row currently renders as a plain clickable `<div>` (lines 100-118):

```js
    groups[calName].forEach(function (ev) {
      var row = document.createElement('div');
      row.className = 'ev-row' + (isSelected(ev) ? ' selected' : '');

      var title = document.createElement('span');
      title.className = 'ev-title';
      title.textContent = ev.title;

      var date = document.createElement('span');
      date.className = 'ev-date';
      date.textContent = parseEventStart(ev.start).toLocaleDateString([], {
        month: 'short', day: 'numeric', year: 'numeric',
      });

      row.appendChild(title);
      row.appendChild(date);
      row.addEventListener('click', function () { selectCountdown(ev); });
      group.appendChild(row);
    });
```

Replace it with a checkbox-driven row:

```js
    groups[calName].forEach(function (ev) {
      var row = document.createElement('label');
      row.className = 'ev-row' + (isSelected(ev) ? ' selected' : '');

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isSelected(ev);
      cb.addEventListener('change', function () { toggleCountdown(ev, cb.checked); });

      var title = document.createElement('span');
      title.className = 'ev-title';
      title.textContent = ev.title;

      var date = document.createElement('span');
      date.className = 'ev-date';
      date.textContent = parseEventStart(ev.start).toLocaleDateString([], {
        month: 'short', day: 'numeric', year: 'numeric',
      });

      row.appendChild(cb);
      row.appendChild(title);
      row.appendChild(date);
      group.appendChild(row);
    });
```

Replace `selectCountdown(ev)` (currently lines 124-137):

```js
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
```

with:

```js
function toggleCountdown(ev, selected) {
  var items = adminState.countdowns.filter(function (c) {
    return !(c.calendarName === ev.calendar && c.uid === ev.uid);
  });
  if (selected) {
    items.push({ calendarName: ev.calendar, uid: ev.uid, title: ev.title });
  }
  return fetchJSON('/api/admin/countdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: items }),
  }).then(function (data) {
    adminState.countdowns = data.countdowns;
    flash(selected ? 'Countdown added' : 'Countdown removed');
    loadEvents();
  }).catch(function (err) {
    console.error('save countdown failed', err);
    flash('Save failed');
    loadEvents(); // revert the checkbox to the last known-good state
  });
}
```

Replace `clearCountdown()` (currently lines 139-152):

```js
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
```

with:

```js
function clearCountdown() {
  return fetchJSON('/api/admin/countdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clear: true }),
  }).then(function (data) {
    adminState.countdowns = data.countdowns;
    flash('All countdowns cleared');
    loadEvents();
  }).catch(function (err) {
    console.error('clear countdowns failed', err);
    flash('Save failed');
  });
}
```

Finally, in `start()` (currently lines 163-178), change:

```js
function start() {
  fetchJSON('/api/admin/state')
    .then(function (data) {
      adminState.hiddenCalendars = data.hiddenCalendars || [];
      adminState.countdown = data.countdown || null;
      adminState.calendars = data.calendars || [];
      renderCalendars();
      return loadEvents();
    })
```

to:

```js
function start() {
  fetchJSON('/api/admin/state')
    .then(function (data) {
      adminState.hiddenCalendars = data.hiddenCalendars || [];
      adminState.countdowns = data.countdowns || [];
      adminState.calendars = data.calendars || [];
      renderCalendars();
      return loadEvents();
    })
```

(The rest of `start()` — the `.catch` and the `$('clearBtn').addEventListener(...)` line — is unchanged.)

- [ ] **Step 3: Manually verify the admin multi-select flow end-to-end**

```bash
npm start &
sleep 1
```

Open `http://localhost:8080/admin` in a browser (or the Browser pane tool):
- Check two event checkboxes on **different** calendars.
- Confirm a "Countdown added" flash appears each time, and both rows stay checked/highlighted after reloading `http://localhost:8080/admin`.
- Uncheck one — confirm "Countdown removed" flashes and that row's checkbox stays unchecked after reload, while the other stays checked.
- Open `http://localhost:8080/` (the display) and confirm the countdown card is active and rotating (see Task 3's verification).
- Click "Clear all" on the admin page — confirm "All countdowns cleared" flashes and every checkbox is unchecked after reload.
- Reload the display and confirm it falls back to the Hourly card.

```bash
kill %1
```

- [ ] **Step 4: Run the full test suite one last time**

Run: `npm test`
Expected: PASS — unchanged (no unit-testable logic added in this task).

- [ ] **Step 5: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "admin: checkboxes for selecting multiple countdown events"
```
