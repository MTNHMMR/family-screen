# Multi-event countdown

Date: 2026-09-13

## Goal

Extend the just-shipped countdown feature (see `2026-09-13-countdown-and-admin-design.md`) so the admin can select **multiple** calendar events, and the wall display cycles through all of them instead of showing only one.

## Out of scope

- Everything from the original design's "Out of scope" still applies (no auth, no calendar CRUD, no display link to `/admin`).
- No user-configurable cycle interval or fade duration — both are fixed constants for now.
- No manual reordering of the cycle — order is always soonest-first.

## 1. Data model

`state.json`'s `countdown` (singular object, possibly `null`) becomes `countdowns` (array of `{calendarName, uid, title}`, possibly empty):

```json
{
  "hiddenCalendars": ["Scouts"],
  "countdowns": [
    { "calendarName": "Troop 4022 (Girls)", "uid": "...", "title": "Trivia Night" },
    { "calendarName": "Elizabeth", "uid": "...", "title": "Softball Round Robin" }
  ]
}
```

`lib/state.js`'s `loadState()` migrates transparently: if a loaded file has an old-style singular `countdown` field (object or `null`) and no `countdowns` field, it's converted to `countdowns: [that object]` or `countdowns: []`. This is cheap insurance rather than a real migration need, since the original feature was never deployed with real state.

## 2. Server changes

### `lib/calendar.js`

No changes to `findNextOccurrence`, `pickNextOccurrence`, `dedupeToSeries`, `listUpcomingSeries`, `computeCountdown`, or `parseEventStart` — all still resolve one series at a time. The "resolve several series, drop expired ones, sort" logic lives in `server.js` (see below) rather than a new `lib/calendar.js` function, since it's pure orchestration of existing pieces with no independent logic worth unit-testing on its own.

### `server.js`

`GET /api/countdown`: for each `{calendarName, uid, title}` in `state.countdowns`, call `findNextOccurrence` (in parallel via `Promise.all`); for each non-null result, compute `{daysLeft, hoursLeft}` via `computeCountdown`. Drop entries where `findNextOccurrence` returned `null` (series gone or no future occurrence). Sort survivors by `start` ascending. Response:

```json
{
  "active": true,
  "items": [
    { "title": "Trivia Night", "start": "2026-11-14T19:00:00.000Z", "calendarName": "Troop 4022 (Girls)", "color": "#38bdf8", "daysLeft": 62, "hoursLeft": 5 },
    { "title": "Softball Round Robin", "start": "2026-09-19T14:00:00.000Z", "calendarName": "Elizabeth", "color": "#ff6fb5", "daysLeft": 5, "hoursLeft": 11 }
  ]
}
```

`active` is `true` iff `items.length > 0`. `{"active": false, "items": []}` when nothing is selected or every selection has expired — this is what tells the display to fall back to Hourly, exactly as today.

`POST /api/admin/countdown`: body becomes `{items: [{calendarName, uid, title}, ...]}` (validated: an array, each entry has `calendarName` and `uid` as non-empty strings) which wholesale-replaces `state.countdowns` — the same replace-the-whole-list pattern `POST /api/admin/calendars` already uses for `hiddenCalendars`. `{clear: true}` still works, setting `state.countdowns = []`.

## 3. Display changes (`public/`)

`app.js`:
- `state.countdown` now holds the full `{active, items}` response; add `countdownIdx` (current rotation position) and `countdownTimer` (the rotation `setInterval` handle) to `state`.
- `renderCountdown()`: if `!active || items.length === 0`, show `#hourlyCard` / hide `#countdownCard` and clear any rotation timer, exactly as today. Otherwise show `#countdownCard`, clear/reset `countdownIdx` to `0`, render `items[0]`, and (re)start a `setInterval` that every `COUNTDOWN_ROTATE_MS` (10000) advances `countdownIdx` modulo `items.length` and re-renders — wrapped in a fade (see below). Called fresh on every successful `/api/countdown` poll (every `CAL_MS`), so a selection change appears within one poll and the rotation always restarts from the soonest item.
- With `items.length === 1`, the `setInterval` still fires every 10s but renders the same single item each time — a fade-to-itself. Harmless, and keeping the logic uniform (no special-casing length 1) is simpler than adding a branch to skip the interval.
- Fade: a `renderCountdownItem(item)` helper sets the card's content. The rotation tick calls `$('countdown').classList.add('fade-out')`, waits ~300ms (`setTimeout`), swaps content via `renderCountdownItem`, removes `fade-out` (triggering the CSS transition back to opacity 1). `style.css` gets `.countdown{transition:opacity .3s} .countdown.fade-out{opacity:0}`.

`index.html`: no structural change — same `#countdownCard`/`#countdown` elements from the original feature.

## 4. Admin page (`public/admin.html` + `admin.js`)

- Each event row in the Countdown Event list gets a checkbox (`<input type="checkbox">`) instead of the row itself being the click target. `adminState.countdowns` becomes an array; `isSelected(ev)` checks array membership instead of equality against a single object.
- Checking/unchecking a box recomputes the full `countdowns` array (add or remove that `{calendarName, uid, title}`) and `POST`s `{items: countdowns}` to `/api/admin/countdown` — same immediate-save-with-flash pattern the calendar checkboxes already use.
- The "Clear countdown" button is relabeled "Clear all" and still posts `{clear: true}`.
- Multiple rows across different calendar groups can be checked simultaneously.

## Key decisions

- **Cycle order is always soonest-first**, recomputed from the resolved `items` (which the server already sorts) — not the admin's selection order. Justin's call: predictable "what's coming up" ordering matters more than remembering pick order.
- **10-second rotation, fixed.** Not configurable — YAGNI for a personal wall display; can be revisited if it ever feels wrong in practice.
- **Fade is a plain CSS opacity transition, not a library.** Matches the project's zero-extra-dependency, no-build-step constraint.
- **Selection state.json field renamed `countdown` → `countdowns`** (with transparent migration) rather than keeping the old key holding an array under the same name — the plural name makes the shape obvious at a glance in the file and in code.
- **Checkbox UI, not click-to-toggle rows.** Justin's call: an explicit checkbox is less ambiguous than overloading "click a row" to mean toggle instead of replace.
