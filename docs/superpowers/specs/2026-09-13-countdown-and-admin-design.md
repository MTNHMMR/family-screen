# Event countdown + admin backend

Date: 2026-09-13

## Goal

Replace the "By the Hour" weather forecast card on the wall display with a
countdown to a selected calendar event, and add a small unlinked admin page
(for use from a computer, not the wall tablet) to pick that event and to
toggle which calendars are shown on the display.

## Out of scope

- Editing calendar URLs/names/colors from the admin page (still a
  `config.json` edit, as today).
- Auth on the admin page (LAN-only, matches the rest of the app).
- Any change to the Daily Forecast card, weather "now" header, or cameras.

## 1. Data model & persistence

New file: `state.json` — mutable, admin-writable runtime state. Distinct from
`config.json` (deploy-time, mostly static: calendar URLs, weather point,
etc). Loaded like config (`STATE_PATH` env override, else
`./config/state.json`, else `./state.json`), and re-written in place on every
admin change. Git-ignored.

```json
{
  "hiddenCalendars": ["Scouts"],
  "countdown": { "calendarName": "Troop 4022 (Girls)", "uid": "...", "title": "Trivia Night" }
}
```

- `hiddenCalendars`: calendar `name`s currently hidden from the display.
  Matched by name against `config.calendars[].name` (names are already the
  de facto unique key used throughout the app, e.g. in the legend).
- `countdown`: identifies an event **series**, not a fixed date/time —
  `calendarName` + iCal `uid`. The next occurrence on/after "now" is resolved
  fresh on every read (see endpoint below), so a recurring event (e.g. an
  annual Trivia Night) keeps counting down to its next instance without the
  admin having to reselect it each year. `null`/absent = no countdown
  selected.
- Missing file / missing keys default to `{ hiddenCalendars: [], countdown: null }`
  — first run needs no setup.

**Docker deploy:** `state.json` must survive stack redeploys, so
`docker-compose.yml` gets a small named volume (`wall-display-state`) mounted
at `/app/state`, and `STATE_PATH` defaults to `/app/state/state.json` in the
container. This is the first writable/persistent thing this app has; today
everything is either read-only config (env vars) or in-memory cache.

## 2. Server changes

### `lib/state.js` (new)

Mirrors `lib/config.js`'s load pattern but adds a `saveState(state)` that
writes the file atomically (write to a temp file, rename over). No env-var
override story needed — this data doesn't belong in an env var (it changes
at runtime, admin env vars don't get pushed back to Portainer).

### `lib/calendar.js` changes

- Existing `getCalendar(config)` (used by `/api/calendar`) additionally
  filters `events` and the `calendars` legend list to exclude any calendar
  name present in `state.hiddenCalendars`. This means hidden calendars are
  still fetched (cache stays warm, errors still surface in logs) but never
  reach the display.
- New `findNextOccurrence(config, calendarName, uid)`: fetches just that one
  calendar, expanded ~400 days out (cached separately from the short
  display-window fetch, same TTL as `calendarMs`), and returns the earliest
  occurrence with `start >= now` whose `uid` matches. Returns `null` if the
  calendar is gone, the uid no longer appears, or nothing matches within the
  window (e.g. a non-recurring event that already happened).
- New `listUpcomingSeries(config, days)`: fetches all calendars expanded
  `days` out (default 365, capped e.g. 400) and returns one row per distinct
  `(calendarName, uid)` pair — the *next* occurrence of each series — sorted
  by start time. This is what powers the admin event picker; it intentionally
  collapses "every Tuesday troop meeting" into a single pickable row instead
  of 50.

### `server.js` new routes

| Route | Method | Purpose |
|---|---|---|
| `/api/countdown` | GET | Public; display polls this. Resolves the saved series via `findNextOccurrence`; returns `{active:false}` if nothing selected or no future occurrence. |
| `/api/admin/state` | GET | Current `hiddenCalendars` + `countdown` selection, plus the calendar list (name/color) — everything the admin page needs to render its current state in one call. |
| `/api/admin/events` | GET | `?days=` optional (default 365). Calls `listUpcomingSeries`. |
| `/api/admin/calendars` | POST | Body `{ hidden: string[] }` — replaces `hiddenCalendars` wholesale and saves. |
| `/api/admin/countdown` | POST | Body `{ calendarName, uid, title }` to set, or `{ clear: true }` to unset. Saves. |
| `/admin` | GET | Serves `public/admin.html` (static serving only maps `/` -> `index.html`; this needs one explicit rewrite in `server.js`). |

`/api/countdown` response shape:
```json
{ "active": true, "title": "Trivia Night", "start": "2026-11-14T19:00:00.000Z",
  "calendarName": "Troop 4022 (Girls)", "color": "#38bdf8",
  "daysLeft": 62, "hoursLeft": 5 }
```
`daysLeft`/`hoursLeft` are computed server-side from `start` and `Date.now()`
using `config.timezone`, consistent with how the rest of the backend treats
time.

## 3. Display changes (`public/`)

`index.html`: the current single "Hourly" card in `#rail` becomes two
sibling cards, toggled via the `hidden` attribute — never both visible:

```html
<div class="card" id="hourlyCard">
  <h2>Hourly</h2>
  <div id="hourly" class="hourly"></div>
</div>
<div class="card" id="countdownCard" hidden>
  <h2 id="countdownTitle">Countdown</h2>
  <div id="countdown" class="countdown"></div>
</div>
```

`app.js`:
- `loadCountdown()` — fetches `/api/countdown` on the same interval as
  calendar (`CAL_MS`, 5 min) plus on `visibilitychange`, mirroring
  `loadCalendar`.
- `renderCountdown()` — when `active`, hides `#hourlyCard`, shows
  `#countdownCard`: big number (`daysLeft`, or `hoursLeft` when `daysLeft`
  is 0 — "day of" framing), the event title, and the target date/time. Sets
  `#countdownTitle` to the calendar's color as an accent, matching the
  legend-dot convention used elsewhere. When `active:false` (or the fetch
  fails), shows `#hourlyCard` and hides `#countdownCard` — i.e. the existing
  hourly-forecast code path is untouched, just conditionally hidden.
- No change to `renderWeather`'s daily-forecast logic.

`style.css`: new `.countdown` rules (large centered number + unit + title),
sized to fit the same card footprint the hourly rows use today.

## 4. Admin page (`public/admin.html` + `public/admin.js`)

Plain HTML/vanilla JS, no build step, no framework — consistent with the
rest of `public/`. Not linked from `index.html` or anywhere in the app;
reached only by navigating to `/admin` directly.

Two sections on one page:

**Calendars** — one row per calendar from `config.calendars` (name, color
dot, checkbox bound to "shown"). Checking/unchecking immediately `POST`s
the full hidden-set to `/api/admin/calendars` and shows a small inline
"Saved" flash.

**Countdown event** — fetches `/api/admin/events`, renders a scrollable list
grouped by calendar (color dot + name heading, then rows: title + next
occurrence date), each row clickable to `POST /api/admin/countdown`. The
currently-selected series (from `/api/admin/state`) is visually marked
(e.g. a checkmark/highlight). A "Clear countdown" button at the top calls
the `{clear:true}` form of the same endpoint.

No polling on this page — it's a one-shot admin tool, reload to refresh.

## 5. Deploy / docs

- `docker-compose.yml`: add
  ```yaml
  volumes:
    - wall-display-state:/app/state
  ```
  under the service, plus a top-level `volumes: { wall-display-state: {} }`,
  and `STATE_PATH: /app/state/state.json` under `environment:`.
- `.gitignore`: add `state.json` and `config/state.json` alongside the
  existing `config.json` entries.
- `README.md`: short new section describing the countdown feature, the
  `/admin` page (URL only — not a "button on the display"), and the new
  volume for local vs. Portainer runs.

## Key decisions

- Countdown targets an event **series** (calendar+uid), not a frozen
  date/time, so recurring events keep tracking their next occurrence
  without admin intervention. Rejected: storing a frozen ISO timestamp —
  simpler, but would silently go stale for anything recurring (which is the
  main use case: yearly Trivia Night).
- Hidden calendars are filtered **server-side** in `/api/calendar`, not
  client-side in `app.js`. Keeps the display dumb (it never has to know
  hidden state exists) and keeps calendar visibility logic in one place
  shared by nothing else.
- Admin page has no auth, matching the rest of this LAN-only app. If this
  ever needs to change (e.g. a guest network), add a shared-password gate
  as a follow-up rather than over-building it now.
- `state.json` is a new persistence tier (previously the app was
  config-in / cache-in-memory only). It gets its own loader/writer
  (`lib/state.js`) rather than being bolted onto `lib/config.js`, since one
  is read-only-at-boot and the other is read-write-at-runtime.
