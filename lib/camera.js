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

module.exports = { haConfig, listCameras, proxy };
