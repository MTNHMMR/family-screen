'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./lib/config');
const { getWeather } = require('./lib/weather');
const { getCalendar } = require('./lib/calendar');
const camera = require('./lib/camera');

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
      return sendJson(res, await getCalendar(config));
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
    return serveStatic(url.pathname, res);
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
