'use strict';

const crypto = require('crypto');
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

module.exports = {
  ABANDON_MS,
  CAP_MS,
  MAX_SESSIONS,
  validOffer,
  normalizeCandidate,
  createRegistry,
};
