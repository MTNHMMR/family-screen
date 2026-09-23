'use strict';

const crypto = require('crypto');
const camera = require('./camera');
const { sendJson, readJsonBody } = require('./http-util');
const { HaWebrtcSession } = require('./webrtc-session');

/* WebRTC live view: session registry, HA lookups, and the signalling routes.
 * The browser POSTs its offer/candidates and listens on an SSE stream for the
 * answer/candidates/errors; the server relays to HA over a websocket holding
 * the long-lived token. The SSE stream's lifetime IS the session's lifetime. */

const MAX_OFFER = 32 * 1024;
const MAX_CANDIDATE = 1024;
const ABANDON_MS = 10000;               // offer POSTed but no SSE attached
const CAP_MS = 5 * 60 * 1000 + 10000;   // server-side backstop for the 5 min live cap
const MAX_SESSIONS = 2;                 // lets a camera switch overlap briefly

function validOffer(body) {
  return !!body && typeof body.offer === 'string' &&
    body.offer.startsWith('v=0') && body.offer.length <= MAX_OFFER;
}

function normalizeCandidate(body) {
  const c = body && body.candidate;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  if (typeof c.candidate !== 'string' || c.candidate.length > MAX_CANDIDATE) return null;
  const sdpMid = c.sdpMid === undefined ? null : c.sdpMid;
  const sdpMLineIndex = c.sdpMLineIndex === undefined ? null : c.sdpMLineIndex;
  if (sdpMid !== null && typeof sdpMid !== 'string') return null;
  if (sdpMLineIndex !== null && !Number.isInteger(sdpMLineIndex)) return null;
  return { candidate: c.candidate, sdpMid, sdpMLineIndex };
}

function createRegistry({
  createSession = (opts) => new HaWebrtcSession(opts),
  timers = { setTimeout, clearTimeout },
  maxSessions = MAX_SESSIONS,
  abandonMs = ABANDON_MS,
  capMs = CAP_MS,
  randomId = () => crypto.randomBytes(16).toString('hex'),
} = {}) {
  const sessions = new Map(); // insertion order = age, oldest first

  function end(id, reason) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    timers.clearTimeout(s.abandonTimer);
    timers.clearTimeout(s.capTimer);
    s.ha.close();
    if (s.sse) s.sse.end(reason);
  }

  function start(camId, haOpts) {
    while (sessions.size >= maxSessions) end(sessions.keys().next().value, 'replaced');
    const id = randomId();
    const ha = createSession(haOpts);
    const s = { camId, ha, sse: null, buffer: [], abandonTimer: null, capTimer: null };
    sessions.set(id, s);

    const deliver = (event, data) => (s.sse ? s.sse.send(event, data) : s.buffer.push([event, data]));
    ha.on('answer', (sdp) => deliver('answer', { answer: sdp }));
    ha.on('candidate', (candidate) => deliver('candidate', { candidate }));
    ha.on('fail', (err) => {
      console.warn(`camera "${camId}" webrtc failed: ${err.code}`);
      deliver('error', { code: err.code, message: err.message });
    });
    ha.on('close', () => end(id, 'closed'));

    s.abandonTimer = timers.setTimeout(() => end(id, 'abandoned'), abandonMs);
    s.capTimer = timers.setTimeout(() => end(id, 'cap'), capMs);
    return id;
  }

  function has(id, camId) {
    const s = sessions.get(id);
    return !!s && s.camId === camId;
  }

  function attach(id, camId, sse) {
    const s = sessions.get(id);
    if (!s || s.camId !== camId || s.sse) return false;
    timers.clearTimeout(s.abandonTimer);
    s.abandonTimer = null;
    s.sse = sse;
    s.buffer.splice(0).forEach(([event, data]) => sse.send(event, data));
    return true;
  }

  function addCandidate(id, camId, candidate) {
    const s = sessions.get(id);
    if (!s || s.camId !== camId) return false;
    s.ha.addCandidate(candidate);
    return true;
  }

  return { start, has, attach, addCandidate, end, size: () => sessions.size };
}

const MAX_BODY = 64 * 1024;
const CAP_CACHE_MS = 10 * 60 * 1000;
const CFG_CACHE_MS = 5 * 60 * 1000;
const SSE_PING_MS = 15000;

/** One-shot HA websocket command: auth, send `msg`, resolve with its result. */
function haCall(baseUrl, token, msg, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocketImpl !== 'function') {
      reject(new Error('global WebSocket unavailable (need Node >= 22)'));
      return;
    }
    const ws = new WebSocketImpl(String(baseUrl).replace(/^http/i, 'ws') + '/api/websocket');
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) { /* ignore */ }
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('HA websocket timeout')), timeoutMs);
    ws.addEventListener('error', () => finish(reject, new Error('HA websocket error')));
    ws.addEventListener('close', () => finish(reject, new Error('HA websocket closed early')));
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_) { return; }
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (m.type === 'auth_invalid') finish(reject, new Error('HA rejected the token'));
      else if (m.type === 'auth_ok') ws.send(JSON.stringify({ id: 1, ...msg }));
      else if (m.type === 'result' && m.id === 1) {
        if (m.success) finish(resolve, m.result);
        else finish(reject, new Error(`${msg.type} failed: ${(m.error && m.error.code) || 'unknown'}`));
      }
    });
  });
}

function createLookups({ call = haCall, now = Date.now } = {}) {
  const capCache = new Map();
  const cfgCache = new Map();

  async function liveMode(baseUrl, token, entity) {
    const hit = capCache.get(entity);
    if (hit && now() - hit.t < CAP_CACHE_MS) return hit.v;
    try {
      const r = await call(baseUrl, token, { type: 'camera/capabilities', entity_id: entity }, { timeoutMs: 5000 });
      const types = (r && r.frontend_stream_types) || [];
      const v = types.includes('web_rtc') ? 'webrtc' : types.includes('hls') ? 'hls' : 'none';
      capCache.set(entity, { v, t: now() });
      return v;
    } catch (err) {
      console.warn(`camera capabilities lookup failed for ${entity}: ${err.message}`);
      return 'hls'; // the pre-WebRTC behaviour; not cached, so the next call retries
    }
  }

  async function clientConfig(baseUrl, token, entity) {
    const hit = cfgCache.get(entity);
    if (hit && now() - hit.t < CFG_CACHE_MS) return hit.v;
    const r = await call(baseUrl, token, { type: 'camera/webrtc/get_client_config', entity_id: entity });
    const v = { iceServers: (r && r.configuration && r.configuration.iceServers) || [] };
    if (r && r.dataChannel) v.dataChannel = r.dataChannel;
    if (r && r.getCandidatesUpfront) v.getCandidatesUpfront = true;
    cfgCache.set(entity, { v, t: now() });
    return v;
  }

  return { liveMode, clientConfig };
}

async function listCamerasWithLive(config, lookups) {
  const list = camera.listCameras(config);
  const { baseUrl, token, enabled } = camera.haConfig(config);
  if (!enabled) return list;
  return Promise.all(list.map(async (c) => {
    const cam = camera.findCamera(config, c.id);
    return { ...c, live: await lookups.liveMode(baseUrl, token, cam.entity) };
  }));
}

const ROUTE = /^\/api\/cam\/([A-Za-z0-9_-]+)\/webrtc(?:\/(config)|\/([a-f0-9]{32})\/(events|candidate))?$/;

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.setTimeout === 'function') res.setTimeout(0);
  res.write(': open\n\n');
  let open = true;
  const ping = setInterval(() => { if (open) res.write(': ping\n\n'); }, SSE_PING_MS);
  const stop = () => {
    if (!open) return false;
    open = false;
    clearInterval(ping);
    return true;
  };
  return {
    stop,
    send(event, data) {
      if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end(reason) {
      if (!stop()) return;
      res.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
      res.end();
    },
  };
}

async function readBodyOr(res, req) {
  try {
    return await readJsonBody(req, MAX_BODY);
  } catch (err) {
    sendJson(res, { error: err.message }, err.message === 'body too large' ? 413 : 400);
    return null;
  }
}

function createWebrtcRoutes({ registry, lookups }) {
  return async function handle(req, res, url, config) {
    const m = url.pathname.match(ROUTE);
    if (!m) return false;
    const [, camId, isConfig, sid, sub] = m;

    const { baseUrl, token, enabled } = camera.haConfig(config);
    if (!enabled) { sendJson(res, { error: 'home assistant not configured' }, 503); return true; }
    const cam = camera.findCamera(config, camId);
    if (!cam) { sendJson(res, { error: 'unknown camera' }, 404); return true; }

    if (isConfig && req.method === 'GET') {
      try {
        sendJson(res, await lookups.clientConfig(baseUrl, token, cam.entity));
      } catch (err) {
        console.warn(`camera "${camId}" webrtc config failed: ${err.message}`);
        sendJson(res, { error: 'could not get webrtc config' }, 502);
      }
      return true;
    }

    if (!isConfig && !sid && req.method === 'POST') {
      const body = await readBodyOr(res, req);
      if (!body) return true;
      if (!validOffer(body)) { sendJson(res, { error: 'offer must be an SDP string' }, 400); return true; }
      const session = registry.start(camId, { baseUrl, token, entity: cam.entity, offer: body.offer });
      console.log(`camera "${camId}" webrtc session started`);
      sendJson(res, { session }, 201);
      return true;
    }

    if (sub === 'candidate' && req.method === 'POST') {
      const body = await readBodyOr(res, req);
      if (!body) return true;
      const candidate = normalizeCandidate(body);
      if (!candidate) { sendJson(res, { error: 'bad candidate' }, 400); return true; }
      if (!registry.addCandidate(sid, camId, candidate)) { sendJson(res, { error: 'unknown session' }, 404); return true; }
      res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      return true;
    }

    if (sub === 'events' && req.method === 'GET') {
      if (!registry.has(sid, camId)) { sendJson(res, { error: 'unknown session' }, 404); return true; }
      const sse = openSse(res);
      registry.attach(sid, camId, sse);
      req.on('close', () => {
        if (sse.stop()) console.log(`camera "${camId}" webrtc stream closed by client`);
        registry.end(sid, 'client_closed');
      });
      return true;
    }

    sendJson(res, { error: 'unknown endpoint' }, 404);
    return true;
  };
}

module.exports = {
  ABANDON_MS,
  CAP_MS,
  MAX_SESSIONS,
  validOffer,
  normalizeCandidate,
  createRegistry,
  haCall,
  createLookups,
  listCamerasWithLive,
  createWebrtcRoutes,
};
