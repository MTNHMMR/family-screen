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
| `homeAssistant` | optional. `baseUrl` + a long-lived `token` + `cameras[]` (`{id, name, entity}`) enables the on-screen **Cam** button. Leave `token` blank and the button never appears. |

### Getting a calendar's private iCal URL

Google Calendar (web) -> hover the calendar in the left list -> **⋮** ->
**Settings and sharing** -> scroll to **Integrate calendar** -> copy
**Secret address in iCal format** (ends in `/private-<hash>/basic.ics`).

Treat that URL like a password - anyone with it can read the calendar. Keep it
in `config/config.json` (git-ignored) or in the `CALENDARS_JSON` env var - see
deploy options below.

### Home Assistant camera (the Cam button)

Optional. With `homeAssistant` configured, a **Cameras** button appears in the top
bar between the clock and the weather. Tapping it opens a grid with every
configured camera as its own live tile; tap a tile to blow it up full-screen, tap
again for the grid. It closes on ✕, `Esc`, or after 90 s (so live Ring feeds
don't sit open burning the panel and your Ring quota). The Node service proxies
every frame, so the HA token never reaches the tablet.

Config keys (`homeAssistant` block for a local run; the matching env vars for a
Portainer deploy — see below):

1. **`baseUrl`** / `HA_BASE_URL` — your HA address on the LAN, e.g.
   `http://homeassistant.local:8123` or `http://192.168.1.x:8123`. Default is
   `homeassistant.local`; switch to the IP if that name doesn't resolve from the
   container.
2. **`token`** / `HA_TOKEN` — in HA, click your user (bottom-left) → **Long-Lived
   Access Tokens** → **Create Token**. Shown once. Treat it like a password: keep
   it in `config/config.json` (git-ignored) for a local run, or the `HA_TOKEN`
   env var for the deploy. **This is the on/off switch** — no token, no button.
3. **`cameras[]`** / `HA_CAMERAS_JSON` — one entry per feed:
   `{ "id": "front", "name": "Front Door", "entity": "camera.front_door_live_view" }`.
   Find `camera.` entity ids in HA under **Developer Tools → States**. `id` is a
   short slug you pick (`[A-Za-z0-9_-]`); `name` is the tile label. The three
   family Ring cameras are already baked into `docker-compose.yml`.

Only cameras listed here can be requested — the proxy never forwards a
caller-supplied entity. MJPEG is used first; a camera that won't hold the stream
(Ring usually won't) falls back to a 2 s snapshot poll automatically.

## 2. Run locally

```bash
npm install
npm start                 # http://localhost:8080
```

## 3. Deploy on the HomeLab (Portainer)

**Portainer -> Stacks -> Add stack -> Repository**

- Repository URL: `https://github.com/MTNHMMR/family-screen`
- Reference: `refs/heads/main`
- Compose path: `docker-compose.yml`

Under **Environment variables** on the same screen, add:

| name | value |
| ---- | ----- |
| `CALENDARS_JSON` | the calendar list as a **one-line JSON array** of `{name,color,url}` (see `config.example.json`) |
| `HA_TOKEN` | Home Assistant long-lived access token. Setting it turns on the **Cameras** button; leave it unset and nothing changes. Visible in `docker inspect` — same accepted trade-off as `CALENDARS_JSON`. |
| `HA_BASE_URL` | only if `http://homeassistant.local:8123` doesn't resolve from the container — set the HA host's LAN IP, e.g. `http://192.168.1.20:8123` |
| `HA_CAMERAS_JSON` | only to change the camera list baked into `docker-compose.yml` — a one-line JSON array of `{id,name,entity}` |
| `NWS_USER_AGENT` | your email |
| `TZ` | `America/Chicago` (optional; already the default) |
| `LAT` / `LON` | only to move off the Cape Girardeau default |

*(`HOME_ASSISTANT_JSON` — the whole `{baseUrl,token,cameras[]}` object as one env var — also still works and overrides all three `HA_*` scalars.)*

Deploy. Portainer builds the image from the Dockerfile and starts the container
on port `8080`. The repo compose has no secrets in it -- the iCal URLs only
exist in the `CALENDARS_JSON` value you enter here (visible in the Portainer UI
and `docker inspect`, which is fine for a LAN display).

*Alternative (bind-mounted file instead of the env var):* on the Docker host
shell -- Linux, or the WSL side of Docker Desktop, **not** Windows PowerShell --
`mkdir -p /opt/wall-display/config`, put `config.json` there, and add
`- /opt/wall-display/config:/app/config:ro` back under a `volumes:` key. On
Docker Desktop for Windows the env var is far less hassle.

The container listens on `8080`. Point the tablet at `http://<homelab-ip>:8080`.

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
