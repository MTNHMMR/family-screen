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
const webrtc = require('./lib/webrtc');
const { loadState, saveState } = require('./lib/state');
const { sendJson, readJsonBody } = require('./lib/http-util');

const config = loadConfig();
const PUBLIC_DIR = path.join(__dirname, 'public');

const webrtcLookups = webrtc.createLookups();
const handleWebrtc = webrtc.createWebrtcRoutes({
  registry: webrtc.createRegistry(),
  lookups: webrtcLookups,
});

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
    if (url.pathname === '/api/admin/state') {
      const state = loadState();
      return sendJson(res, {
        hiddenCalendars: state.hiddenCalendars,
        countdowns: state.countdowns,
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
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
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
    if (url.pathname === '/api/cameras') {
      return sendJson(res, { cameras: await webrtc.listCamerasWithLive(config, webrtcLookups) });
    }
    if (await handleWebrtc(req, res, url, config)) return;
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
