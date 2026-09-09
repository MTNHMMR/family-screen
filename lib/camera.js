'use strict';

const { Readable } = require('stream');

/**
 * Home Assistant camera proxy.
 *
 * The wall-display browser must never hold the HA long-lived token, so every
 * camera request is proxied here: the token lives in config (file, or the
 * HOME_ASSISTANT_JSON env var for a Portainer deploy) and only same-origin
 * /api/cam/... URLs ever reach the tablet.
 *
 * config.homeAssistant = {
 *   baseUrl: "http://homeassistant.local:8123",
 *   token:   "<long-lived access token>",
 *   cameras: [ { id: "front", name: "Front Door", entity: "camera.front_door" } ]
 * }
 *
 * Three ways to view a camera, roughly best-to-worst for a live feed:
 *   hls      -- the real live stream, the same one HA's own UI uses. We ask HA
 *               for it over the websocket ("camera/stream"), then proxy the
 *               .m3u8 playlists and .ts segments so the token stays server-side.
 *               ~6-10 s behind real time (inherent to HLS).
 *   stream   -- camera_proxy_stream. For Ring this is just the last snapshot on
 *               a loop, NOT live -- kept only as a legacy path.
 *   snapshot -- camera_proxy. A single still; for Ring, the last event's frame.
 */

function haConfig(config) {
  const ha = (config && config.homeAssistant) || {};
  const baseUrl = String(ha.baseUrl || '').replace(/\/+$/, '');
  const token = String(ha.token || '');
  const cameras = Array.isArray(ha.cameras)
    ? ha.cameras.filter((c) => c && c.id && c.entity)
    : [];
  return {
    baseUrl,
    token,
    cameras,
    enabled: !!(baseUrl && token && cameras.length),
  };
}

/** Public list for the frontend -- id + name only, never the entity or token. */
function listCameras(config) {
  const { cameras, enabled } = haConfig(config);
  if (!enabled) return [];
  return cameras.map((c) => ({ id: String(c.id), name: String(c.name || c.id) }));
}

function findCamera(config, id) {
  const { cameras } = haConfig(config);
  return cameras.find((c) => String(c.id) === String(id)) || null;
}

function plain(res, status, text) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * Proxy one camera request.
 *   kind === 'stream'   -> multipart/x-mixed-replace MJPEG (camera_proxy_stream)
 *   kind === 'snapshot' -> a single JPEG                   (camera_proxy)
 * Never throws; always ends `clientRes`.
 */
async function proxy(config, id, kind, clientRes, clientReq) {
  try {
    const { baseUrl, token, enabled } = haConfig(config);
    if (!enabled) return plain(clientRes, 503, 'home assistant not configured');

    const cam = findCamera(config, id);
    if (!cam) return plain(clientRes, 404, 'unknown camera');

    const endpoint = kind === 'stream' ? 'camera_proxy_stream' : 'camera_proxy';
    const url = `${baseUrl}/api/${endpoint}/${encodeURIComponent(cam.entity)}`;

    const controller = new AbortController();
    const abort = () => controller.abort();
    clientReq.on('close', abort);

    let upstream;
    try {
      upstream = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (err) {
      clientReq.off('close', abort);
      if (err && err.name === 'AbortError') {
        clientRes.destroy();
        return;
      }
      console.warn(`camera "${id}" fetch failed: ${err && err.message}`);
      return plain(clientRes, 502, 'camera fetch failed');
    }

    if (!upstream.ok || !upstream.body) {
      clientReq.off('close', abort);
      console.warn(`camera "${id}" upstream ${upstream.status} ${upstream.statusText}`);
      return plain(clientRes, upstream.status === 401 ? 502 : upstream.status || 502,
        `camera upstream ${upstream.status}`);
    }

    clientRes.writeHead(200, {
      'Content-Type':
        upstream.headers.get('content-type') ||
        (kind === 'stream' ? 'multipart/x-mixed-replace' : 'image/jpeg'),
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
    });
    if (kind === 'stream' && typeof clientRes.setTimeout === 'function') {
      clientRes.setTimeout(0); // long-lived; don't let Node time it out
    }

    const body = Readable.fromWeb(upstream.body);
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      body.on('error', () => { controller.abort(); clientRes.destroy(); finish(); });
      body.on('end', finish);
      clientRes.on('close', () => { controller.abort(); body.destroy(); finish(); });
      body.pipe(clientRes);
    });
    clientReq.off('close', abort);
  } catch (err) {
    console.error(`camera "${id}" proxy error:`, err);
    plain(clientRes, 502, 'camera proxy error');
  }
}

/* ------------------------------------------------------------------ HLS live */

const WS_TIMEOUT_MS = 15000;
const HLS_URL_TTL = 90 * 1000;
const hlsUrlCache = new Map(); // entity -> { url, t }

/**
 * Ask HA over the websocket for a camera's live HLS playlist URL. Returns the
 * path HA gives back, e.g. "/api/hls/<signed-token>/master_playlist.m3u8"
 * (valid a few minutes; it auto-extends while something keeps reading it).
 */
async function fetchHlsUrl(haBase, token, entity) {
  const hit = hlsUrlCache.get(entity);
  if (hit && Date.now() - hit.t < HLS_URL_TTL) return hit.url;

  if (typeof WebSocket === 'undefined') {
    throw new Error('global WebSocket unavailable (need Node >= 22)');
  }
  const wsUrl = haBase.replace(/^http/i, 'ws') + '/api/websocket';

  const url = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const reqId = 1;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) { /* ignore */ }
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('HA websocket timeout')),
      WS_TIMEOUT_MS
    );

    ws.addEventListener('error', () => finish(reject, new Error('HA websocket error')));
    ws.addEventListener('close', () => finish(reject, new Error('HA websocket closed early')));
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); }
      catch (_) { return; }
      if (m.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      } else if (m.type === 'auth_invalid') {
        finish(reject, new Error('HA rejected the token'));
      } else if (m.type === 'auth_ok') {
        ws.send(JSON.stringify({ id: reqId, type: 'camera/stream', entity_id: entity, format: 'hls' }));
      } else if (m.type === 'result' && m.id === reqId) {
        if (m.success && m.result && m.result.url) finish(resolve, m.result.url);
        else finish(reject, new Error('camera/stream failed: ' + JSON.stringify(m.error || {})));
      }
    });
  });

  hlsUrlCache.set(entity, { url, t: Date.now() });
  return url;
}

/** Rewrite one playlist URI (line or URI="...") to route back through us. */
function toHlsProxyPath(u, resolveBase, id, haBase) {
  let abs;
  try { abs = new URL(u, resolveBase).href; } catch (_) { return u; }
  if (!abs.startsWith(haBase + '/')) return u; // never proxy anything off the HA host
  const blob = Buffer.from(abs).toString('base64url');
  return `/api/cam/${encodeURIComponent(id)}/hls/${blob}`;
}

function rewriteM3u8(text, resolveBase, id, haBase) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t[0] === '#') {
        return line.replace(
          /URI="([^"]*)"/g,
          (_m, u) => `URI="${toHlsProxyPath(u, resolveBase, id, haBase)}"`
        );
      }
      return toHlsProxyPath(t, resolveBase, id, haBase);
    })
    .join('\n');
}

async function serveHlsResource(haBase, token, targetAbs, id, clientRes, clientReq) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  clientReq.on('close', abort);

  let upstream;
  try {
    upstream = await fetch(targetAbs, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clientReq.off('close', abort);
    if (err && err.name === 'AbortError') { clientRes.destroy(); return; }
    console.warn(`camera "${id}" hls fetch failed: ${err && err.message}`);
    return plain(clientRes, 502, 'hls fetch failed');
  }

  if (!upstream.ok || !upstream.body) {
    clientReq.off('close', abort);
    console.warn(`camera "${id}" hls upstream ${upstream.status} ${upstream.statusText}`);
    return plain(clientRes, upstream.status || 502, `hls upstream ${upstream.status}`);
  }

  const ct = upstream.headers.get('content-type') || '';
  const isPlaylist = /mpegurl|m3u8/i.test(ct) || /\.m3u8(\?|$)/i.test(targetAbs);

  if (isPlaylist) {
    const text = await upstream.text();
    clientReq.off('close', abort);
    if (clientRes.headersSent) { clientRes.end(); return; }
    clientRes.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
    });
    clientRes.end(rewriteM3u8(text, targetAbs, id, haBase));
    return;
  }

  // segment / key / init -- pipe bytes straight through
  clientRes.writeHead(200, {
    'Content-Type': ct || 'video/mp2t',
    'Cache-Control': 'no-store',
  });
  const body = Readable.fromWeb(upstream.body);
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; resolve(); };
    body.on('error', () => { controller.abort(); clientRes.destroy(); fin(); });
    body.on('end', fin);
    clientRes.on('close', () => { controller.abort(); body.destroy(); fin(); });
    body.pipe(clientRes);
  });
  clientReq.off('close', abort);
}

/**
 * GET /api/cam/:id/hls            -> the (rewritten) master playlist
 * GET /api/cam/:id/hls/<blob>     -> a playlist or segment, <blob> = base64url
 *                                   of the absolute HA URL we handed out
 * Never throws; always ends clientRes.
 */
async function proxyHls(config, id, blob, clientRes, clientReq) {
  try {
    const { baseUrl, token, enabled } = haConfig(config);
    if (!enabled) return plain(clientRes, 503, 'home assistant not configured');

    const cam = findCamera(config, id);
    if (!cam) return plain(clientRes, 404, 'unknown camera');

    let target;
    if (!blob) {
      let rel;
      try {
        rel = await fetchHlsUrl(baseUrl, token, cam.entity);
      } catch (err) {
        console.warn(`camera "${id}" camera/stream failed: ${err && err.message}`);
        return plain(clientRes, 502, 'could not start live stream');
      }
      try { target = new URL(rel, baseUrl + '/').href; }
      catch (_) { return plain(clientRes, 502, 'bad stream url from HA'); }
    } else {
      try { target = Buffer.from(blob, 'base64url').toString('utf8'); }
      catch (_) { return plain(clientRes, 400, 'bad hls path'); }
    }

    // Only ever fetch HA's own API paths -- closes the SSRF hole in <blob>.
    if (!target.startsWith(baseUrl + '/api/')) {
      return plain(clientRes, 400, 'hls target out of bounds');
    }
    return serveHlsResource(baseUrl, token, target, id, clientRes, clientReq);
  } catch (err) {
    console.error(`camera "${id}" hls proxy error:`, err);
    plain(clientRes, 502, 'hls proxy error');
  }
}

module.exports = { haConfig, listCameras, proxy, proxyHls };
