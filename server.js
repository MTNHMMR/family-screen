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
        title: occ.title || state.countdown.title,
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
