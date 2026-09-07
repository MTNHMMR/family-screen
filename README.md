# wall-display

An always-on **calendar + weather** panel for a wall-mounted tablet (built for a
Fire HD 8, 10th gen). A small Node service on the HomeLab pulls Google Calendar
(via private iCal URLs) and the National Weather Service, caches both, and serves
one static page. The tablet just runs a kiosk browser pointed at it.

- No Google OAuth. Read-only iCal URLs only.
- No API keys. NWS (`api.weather.gov`) is free and keyless.
- Two runtime dependencies (`ical-expander` + `ical.js`). No build step.
- Serves stale data rather than going blank when an upstream API hiccups.

```
server.js            HTTP server: /api/weather, /api/calendar, /api/health, static files
lib/weather.js       NWS points -> forecast / hourly / latest observation, normalised
lib/calendar.js      fetch + parse each iCal URL, expand recurrences, merge, sort
lib/cache.js         in-memory TTL cache with serve-stale-on-error
lib/config.js        config.json + a few env overrides
public/              index.html + style.css + app.js  (the display itself)
```

## 1. Configure

```bash
cp config.example.json config/config.json     # or ./config.json for local runs
```

Edit `config/config.json`:

| key            | meaning |
| -------------- | ------- |
| `lat` / `lon`  | weather point. Default is Cape Girardeau, MO (`37.3059, -89.5181`). Put in your actual address for the most local grid + observation station. |
| `nwsUserAgent` | any string that identifies you, e.g. your email. NWS may throttle anonymous clients. |
| `timezone`     | IANA zone, e.g. `America/Chicago`. Drives "Today / Tomorrow" grouping. Also set `TZ` on the container (compose does this). |
| `hourlyCount`  | hourly rows to fetch (display shows 7). |
| `dailyCount`   | forecast days shown (today + 3). |
| `calendarDays` | how far ahead to pull events. The agenda only renders **Today and Tomorrow**, so `3` is plenty (the extra day is timezone slack). |
| `refresh`      | server-side cache TTLs in ms. The browser polls weather every 10 min, calendar every 5 min. |
| `calendars[]`  | one object per calendar: `name`, `color` (hex, used for the left bar + legend), `url` (the **private** iCal address). |

### Getting a calendar's private iCal URL

Google Calendar (web) -> hover the calendar in the left list -> **⋮** ->
**Settings and sharing** -> scroll to **Integrate calendar** -> copy
**Secret address in iCal format** (ends in `/private-<hash>/basic.ics`).

Treat that URL like a password - anyone with it can read the calendar. Keep it
in `config/config.json` (git-ignored) or in the `CALENDARS_JSON` env var - see
deploy options below.

## 2. Run locally

```bash
npm install
npm start                 # http://localhost:8080
```

## 3. Deploy on the HomeLab (Portainer)

**Portainer -> Stacks -> Add stack -> Repository**, repo URL, branch `main`,
compose path `docker-compose.yml`. Portainer builds the image from the Dockerfile.

Then choose how the calendars get in:

**Option A - all in Portainer (no host shell).** In the stack's environment set:

- `TZ` = `America/Chicago`
- `NWS_USER_AGENT` = your email
- `CALENDARS_JSON` = the calendar list as a **one-line JSON array**, e.g.
  `[{"name":"Justin","color":"#4d9de0","url":"https://calendar.google.com/calendar/ical/.../basic.ics"},{"name":"Carrie","color":"#a855f7","url":"https://..."}]`
- optionally `LAT` / `LON` to move off the Cape Girardeau default

and delete the `volumes:` block from the compose. Downside: the iCal URLs are
then visible in the Portainer UI and `docker inspect`.

**Option B - bind-mounted file.** On the Docker host (SSH / its console, *not*
Windows PowerShell - `/opt/...` and `mkdir -p` are Linux):

```bash
mkdir -p /opt/wall-display/config
# create config.json there from config.example.json, with your calendars
```

Keep the `volumes:` block. Set `WALL_DISPLAY_CONFIG_DIR` in the stack env if the
dir is somewhere other than `/opt/wall-display/config`. The URLs stay in that
file only.

The container listens on `8080` (published as `8080` on the host). Point the
tablet at `http://<homelab-ip>:8080`.

Health check: `GET /api/health` returns `{ "ok": true, ... }`.

## 4. Set up the Fire HD 8 as a wall panel

1. Register the Fire to Wi-Fi; disable the lock screen (Settings -> Security).
2. Install a kiosk browser. **Fully Kiosk Browser** (free tier is enough) is the
   usual pick and runs on Fire OS 7:
   - Start URL: `http://<homelab-ip>:8080`
   - **Start on boot**: on
   - **Keep screen on**: on  (optionally "screen off" on a schedule overnight,
     or use motion detection to wake it)
   - **Auto reload on idle / on connection error**: ~15 min, as a backstop
     (the page also self-reloads at 3:30 AM and after ~26 h uptime)
   - Enable fullscreen / hide the navigation + status bars
3. Set display brightness low; the page is already a dark theme to be easy on an
   always-on LCD and on the room at night.
4. Give it permanent USB power at the mount point.

## Notes

- All-day events use iCal's exclusive `DTEND`, so a one-day holiday shows on the
  single correct date.
- Weather source is NWS only for now. A hyper-local station feed
  (capecountyweather.com or a specific PWS) can be added later as the
  current-conditions source - see the project note in the Brain vault.
- Weather icons are emoji so there are no external image requests and nothing to
  cache; the mapping is in `lib/weather.js` (`pickIcon`).
