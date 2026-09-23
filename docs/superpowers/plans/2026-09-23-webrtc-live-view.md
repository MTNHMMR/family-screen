# WebRTC Live View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore live Ring camera video on the wall display by adding a WebRTC live path, with signalling relayed through the Node service so the HA token never reaches the tablet.

**Architecture:** `lib/webrtc-session.js` wraps one HA websocket `camera/webrtc/offer` subscription. `lib/webrtc.js` holds the session registry (timers, caps, event buffering), cached HA lookups, and the HTTP routes (POST offer and candidates, plus an SSE stream for the answer, candidates, and errors). `public/webrtc-client.js` runs the browser `RTCPeerConnection`. `public/app.js` switches the grid to snapshot tiles with tap-for-live.

**Tech Stack:** Node 22 (global `WebSocket`, `node:test`), plain `http`, browser WebRTC + `EventSource`, ES5-style frontend. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-webrtc-live-view-design.md`

## Global Constraints

- No new npm dependencies (`package.json` keeps `ical-expander` only).
- Node >= 22 (global `WebSocket` client).
- Frontend files use ES5 style (`var`, function declarations) to match `app.js`.
- The HA token, SDP bodies, and ICE candidates are **never logged**. Logs carry the camera id and event type only.
- Only whitelisted camera ids reach HA; the entity always comes from config, never from the request.
- POST body cap 64 KB (`413` over); offer is a string starting `v=0`, at most 32 KB; `candidate.candidate` is a string of at most 1 KB; `sdpMid` is a string or null; `sdpMLineIndex` is an integer or null.
- Session timers: abandon 10 s (no SSE attached), hard cap 5 min + 10 s server-side, max 2 concurrent sessions (the oldest is closed).
- Frontend timers: 25 s live-start grace (existing `CAM_LIVE_START_MS`), 5 min live cap (`CAM_LIVE_MAX_MS`), 90 s overlay auto-close paused while live.
- Tile copy: `Last event · tap for live` (snapshot grid) and `Live view unavailable — showing last event` (live failed).

## Verified protocol (spike, 2026-09-23, HA 2026.9.3)

- `camera/capabilities` for `camera.front_door_live_view` → `{frontend_stream_types: ["web_rtc"]}`.
- `camera/webrtc/get_client_config` → `{configuration: {iceServers: [{urls: ["stun:stun.home-assistant.io:3478", "stun:stun.home-assistant.io:80"]}]}}`. **No `dataChannel`, no `getCandidatesUpfront`.**
- `camera/webrtc/offer` → `result` (success, `null`), then `event {type:"session", session_id}` at about 0.1 s, then `event {type:"answer", answer}` at about 3 s (2 m-lines). **Ring sent no trickled `candidate` events.** Its candidates are in the answer SDP. Trickle support stays in for other cameras.
- `camera/webrtc/candidate` with `{candidate, sdpMid, sdpMLineIndex}` → `result success`.

## Refinements to the spec (decided while planning)

- `HaWebrtcSession` emits **`fail`**, not `error`. An EventEmitter `error` event with no listener throws and would crash the server.
- `POST /api/cam/:id/webrtc` returns `201` as soon as the session is created. HA auth or Ring failures arrive on the SSE stream as `error` (they're asynchronous by nature). The browser falls back to the snapshot either way.
- `readJsonBody` and `sendJson` move from `server.js` to `lib/http-util.js` so `lib/webrtc.js` and its tests can use them. `server.js` starts listening when loaded, so it can't be imported by tests.

## File Structure

| File | Responsibility |
|---|---|
| `lib/http-util.js` (new) | `sendJson`, `readJsonBody`, moved verbatim from `server.js` |
| `lib/webrtc-session.js` (new) | `HaWebrtcSession`: one HA websocket and offer subscription |
| `lib/webrtc.js` (new) | validation, `createRegistry`, `haCall`, `createLookups`, `listCamerasWithLive`, `createWebrtcRoutes` |
| `lib/camera.js` | export `findCamera` |
| `server.js` | import from `http-util`; wire the WebRTC routes; `/api/cameras` adds `live` |
| `public/webrtc-client.js` (new) | `window.startWebrtc(id, videoEl, {onPlaying, onFail})` → `{close()}` |
| `public/index.html` | load `webrtc-client.js` before `app.js` |
| `public/app.js` | snapshot grid, tap-for-live, timers, teardown |
| `test/webrtc-session.test.js`, `test/webrtc.test.js` (new) | unit tests |
| `README.md` | camera section |

---

### Task 1: `HaWebrtcSession`

**Files:**
- Create: `lib/webrtc-session.js`
- Test: `test/webrtc-session.test.js`

**Interfaces:**
- Produces: `class HaWebrtcSession extends EventEmitter`, `new HaWebrtcSession({ baseUrl, token, entity, offer, WebSocketImpl })`. Events: `session` (string), `answer` (string sdp), `candidate` (object), `fail` ({code, message}), `close` (no args, at most once). Methods: `addCandidate(candidate)`, `close()`. Property: `haSessionId`.

- [ ] **Step 1: Write the failing tests**

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HaWebrtcSession } = require('../lib/webrtc-session');

class FakeWs {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = {};
    this.closed = false;
    FakeWs.last = this;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.fire('close', {});
  }
  fire(type, ev) { (this.listeners[type] || []).forEach((fn) => fn(ev)); }
  recv(obj) { this.fire('message', { data: JSON.stringify(obj) }); }
}

function mk() {
  return new HaWebrtcSession({
    baseUrl: 'http://ha.local',
    token: 'TOKEN',
    entity: 'camera.front',
    offer: 'v=0\r\n',
    WebSocketImpl: FakeWs,
  });
}

function ready(s) {
  const ws = FakeWs.last;
  ws.recv({ type: 'auth_required' });
  ws.recv({ type: 'auth_ok' });
  return ws;
}

function record(s) {
  const log = [];
  for (const ev of ['session', 'answer', 'candidate', 'fail', 'close']) {
    s.on(ev, (arg) => log.push(arg === undefined ? [ev] : [ev, arg]));
  }
  return log;
}

test('authenticates with the token, then sends the offer', () => {
  const s = mk();
  const ws = FakeWs.last;
  assert.equal(ws.url, 'ws://ha.local/api/websocket');
  ws.recv({ type: 'auth_required' });
  assert.deepEqual(ws.sent[0], { type: 'auth', access_token: 'TOKEN' });
  ws.recv({ type: 'auth_ok' });
  assert.deepEqual(ws.sent[1], {
    id: 1, type: 'camera/webrtc/offer', entity_id: 'camera.front', offer: 'v=0\r\n',
  });
  s.close();
});

test('emits session, answer and candidate from offer-subscription events', () => {
  const s = mk();
  const log = record(s);
  const ws = ready(s);
  ws.recv({ id: 1, type: 'result', success: true, result: null });
  ws.recv({ id: 1, type: 'event', event: { type: 'session', session_id: 'S1' } });
  ws.recv({ id: 1, type: 'event', event: { type: 'answer', answer: 'v=0 answer' } });
  ws.recv({ id: 1, type: 'event', event: { type: 'candidate', candidate: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 } } });
  assert.deepEqual(log, [
    ['session', 'S1'],
    ['answer', 'v=0 answer'],
    ['candidate', { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 }],
  ]);
  assert.equal(s.haSessionId, 'S1');
  s.close();
});

test('queues candidates until the HA session id arrives, then flushes in order', () => {
  const s = mk();
  const ws = ready(s);
  s.addCandidate({ candidate: 'a' });
  s.addCandidate({ candidate: 'b' });
  assert.equal(ws.sent.length, 2); // auth + offer only
  ws.recv({ id: 1, type: 'event', event: { type: 'session', session_id: 'S1' } });
  s.addCandidate({ candidate: 'c' });
  assert.deepEqual(ws.sent.slice(2), [
    { id: 2, type: 'camera/webrtc/candidate', entity_id: 'camera.front', session_id: 'S1', candidate: { candidate: 'a' } },
    { id: 3, type: 'camera/webrtc/candidate', entity_id: 'camera.front', session_id: 'S1', candidate: { candidate: 'b' } },
    { id: 4, type: 'camera/webrtc/candidate', entity_id: 'camera.front', session_id: 'S1', candidate: { candidate: 'c' } },
  ]);
  s.close();
});

test('auth_invalid fails and closes', () => {
  const s = mk();
  const log = record(s);
  const ws = FakeWs.last;
  ws.recv({ type: 'auth_required' });
  ws.recv({ type: 'auth_invalid', message: 'bad' });
  assert.deepEqual(log, [['fail', { code: 'auth_invalid', message: 'HA rejected the token' }], ['close']]);
  assert.equal(ws.closed, true);
  assert.equal(s.closed, true);
});

test('a failed offer result fails the session', () => {
  const s = mk();
  const log = record(s);
  const ws = ready(s);
  ws.recv({ id: 1, type: 'result', success: false, error: { code: 'start_stream_failed', message: 'nope' } });
  assert.deepEqual(log, [['fail', { code: 'start_stream_failed', message: 'nope' }], ['close']]);
});

test('a webrtc error event fails the session', () => {
  const s = mk();
  const log = record(s);
  const ws = ready(s);
  ws.recv({ id: 1, type: 'event', event: { type: 'error', code: 'webrtc_offer_failed', message: 'ring said no' } });
  assert.deepEqual(log, [['fail', { code: 'webrtc_offer_failed', message: 'ring said no' }], ['close']]);
});

test('a rejected candidate is not fatal', () => {
  const s = mk();
  const log = record(s);
  const ws = ready(s);
  ws.recv({ id: 1, type: 'event', event: { type: 'session', session_id: 'S1' } });
  s.addCandidate({ candidate: 'a' });
  ws.recv({ id: 2, type: 'result', success: false, error: { code: 'x', message: 'y' } });
  assert.equal(s.closed, false);
  assert.deepEqual(log, [['session', 'S1']]);
  s.close();
});

test('HA closing the socket fails and closes once; close() is idempotent', () => {
  const s = mk();
  const log = record(s);
  const ws = ready(s);
  ws.close();
  s.close();
  s.close();
  assert.deepEqual(log, [['fail', { code: 'ws_closed', message: 'HA websocket closed' }], ['close']]);
});

test('a local close() emits close without fail', () => {
  const s = mk();
  const log = record(s);
  ready(s);
  s.close();
  assert.deepEqual(log, [['close']]);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/webrtc-session.test.js`
Expected: FAIL with `Cannot find module '../lib/webrtc-session'`

- [ ] **Step 3: Implement `lib/webrtc-session.js`**

```js
'use strict';

const { EventEmitter } = require('events');

const AUTH_TIMEOUT_MS = 15000;

/**
 * One Home Assistant websocket carrying one `camera/webrtc/offer`
 * subscription. HA relays the offer to the camera (for Ring, to Ring's cloud)
 * and streams back events on the subscription id:
 *   {type:"session", session_id}  {type:"answer", answer}
 *   {type:"candidate", candidate} {type:"error", code, message}
 * Closing the websocket ends the subscription, and HA then closes the camera
 * session.
 *
 * Emits: session(id) answer(sdp) candidate(obj) fail({code,message}) close()
 * `fail`, not `error`: an unhandled EventEmitter `error` would crash the server.
 */
class HaWebrtcSession extends EventEmitter {
  constructor({ baseUrl, token, entity, offer, WebSocketImpl = globalThis.WebSocket }) {
    super();
    this.entity = entity;
    this.haSessionId = null;
    this.closed = false;
    this._token = token;
    this._offer = offer;
    this._pending = [];
    this._nextId = 1;
    this._offerId = null;
    this._ws = null;

    if (typeof WebSocketImpl !== 'function') {
      queueMicrotask(() => this._fail('ws_unavailable', 'global WebSocket unavailable (need Node >= 22)'));
      return;
    }
    this._ws = new WebSocketImpl(String(baseUrl).replace(/^http/i, 'ws') + '/api/websocket');
    this._authTimer = setTimeout(() => this._fail('timeout', 'HA websocket auth timeout'), AUTH_TIMEOUT_MS);
    if (this._authTimer.unref) this._authTimer.unref();
    this._ws.addEventListener('message', (ev) => this._onMessage(ev));
    this._ws.addEventListener('error', () => this._fail('ws_error', 'HA websocket error'));
    this._ws.addEventListener('close', () => this._fail('ws_closed', 'HA websocket closed'));
  }

  addCandidate(candidate) {
    if (this.closed) return;
    if (!this.haSessionId) {
      this._pending.push(candidate);
      return;
    }
    this._send({
      type: 'camera/webrtc/candidate',
      entity_id: this.entity,
      session_id: this.haSessionId,
      candidate,
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this._authTimer);
    this._pending = [];
    if (this._ws) {
      try { this._ws.close(); } catch (_) { /* ignore */ }
    }
    this.emit('close');
  }

  _fail(code, message) {
    if (this.closed) return;
    this.emit('fail', { code, message });
    this.close();
  }

  _send(msg) {
    if (this.closed || !this._ws) return null;
    const out = msg.type === 'auth' ? msg : { id: this._nextId++, ...msg };
    try { this._ws.send(JSON.stringify(out)); } catch (_) { /* the close handler reports it */ }
    return out.id || null;
  }

  _onMessage(ev) {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_) { return; }

    if (m.type === 'auth_required') {
      this._send({ type: 'auth', access_token: this._token });
    } else if (m.type === 'auth_invalid') {
      this._fail('auth_invalid', 'HA rejected the token');
    } else if (m.type === 'auth_ok') {
      clearTimeout(this._authTimer);
      this._offerId = this._send({ type: 'camera/webrtc/offer', entity_id: this.entity, offer: this._offer });
    } else if (m.type === 'result') {
      // Only the offer's own failure is fatal; a rejected candidate is not.
      if (m.id === this._offerId && !m.success) {
        const e = m.error || {};
        this._fail(e.code || 'offer_failed', e.message || 'HA rejected the offer');
      }
    } else if (m.type === 'event' && m.id === this._offerId && m.event) {
      const e = m.event;
      if (e.type === 'session') {
        this.haSessionId = e.session_id;
        this.emit('session', e.session_id);
        this._pending.splice(0).forEach((c) => this.addCandidate(c));
      } else if (e.type === 'answer') {
        this.emit('answer', e.answer);
      } else if (e.type === 'candidate') {
        this.emit('candidate', e.candidate);
      } else if (e.type === 'error') {
        this._fail(e.code || 'webrtc_error', e.message || 'WebRTC session failed');
      }
    }
  }
}

module.exports = { HaWebrtcSession };
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/webrtc-session.test.js`
Expected: 9 passing

- [ ] **Step 5: Commit**

```bash
git add lib/webrtc-session.js test/webrtc-session.test.js
git commit -m "webrtc: HaWebrtcSession wraps one HA camera/webrtc/offer subscription"
```

---

### Task 2: Validation and session registry

**Files:**
- Create: `lib/webrtc.js`
- Test: `test/webrtc.test.js`

**Interfaces:**
- Consumes: the `HaWebrtcSession` event and method surface (Task 1). The registry takes a `createSession(opts)` factory, so tests pass a fake.
- Produces:
  - `validOffer(body) → boolean`, `normalizeCandidate(body) → {candidate, sdpMid, sdpMLineIndex} | null`
  - `createRegistry({ createSession, timers, maxSessions, abandonMs, capMs, randomId }) → { start(camId, haOpts) → id, has(id, camId) → bool, attach(id, camId, sse) → bool, addCandidate(id, camId, cand) → bool, end(id, reason), size() }`
  - SSE sink interface: `{ send(event, data), end(reason) }`
  - Constants `ABANDON_MS = 10000`, `CAP_MS = 5 * 60 * 1000 + 10000`, `MAX_SESSIONS = 2`

- [ ] **Step 1: Write the failing tests** (new file `test/webrtc.test.js`)

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const webrtc = require('../lib/webrtc');

class FakeSession extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.closed = false;
    this.cands = [];
  }
  addCandidate(c) { this.cands.push(c); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

function fakeTimers() {
  let n = 0;
  const map = new Map();
  return {
    setTimeout(fn, ms) { const id = ++n; map.set(id, { fn, ms }); return id; },
    clearTimeout(id) { map.delete(id); },
    fire(ms) {
      for (const [id, t] of [...map]) {
        if (t.ms === ms) { map.delete(id); t.fn(); }
      }
    },
    pending() { return [...map.values()].map((t) => t.ms).sort((a, b) => a - b); },
  };
}

function fakeSse() {
  return {
    sent: [],
    ended: null,
    send(event, data) { this.sent.push([event, data]); },
    end(reason) { this.ended = reason; },
  };
}

function mkRegistry(extra = {}) {
  const sessions = [];
  const timers = fakeTimers();
  let n = 0;
  const reg = webrtc.createRegistry({
    createSession: (opts) => { const s = new FakeSession(opts); sessions.push(s); return s; },
    timers,
    randomId: () => String(++n).padStart(32, '0'),
    ...extra,
  });
  return { reg, sessions, timers };
}

const HA = { baseUrl: 'http://ha', token: 'T', entity: 'camera.front', offer: 'v=0' };

test('validOffer accepts SDP strings only', () => {
  assert.equal(webrtc.validOffer({ offer: 'v=0\r\no=-' }), true);
  assert.equal(webrtc.validOffer({ offer: 'hello' }), false);
  assert.equal(webrtc.validOffer({ offer: 42 }), false);
  assert.equal(webrtc.validOffer({ offer: 'v=0' + 'x'.repeat(32 * 1024) }), false);
  assert.equal(webrtc.validOffer(null), false);
});

test('normalizeCandidate checks types and fills nulls', () => {
  assert.deepEqual(webrtc.normalizeCandidate({ candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } }),
    { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 });
  assert.deepEqual(webrtc.normalizeCandidate({ candidate: { candidate: 'c' } }),
    { candidate: 'c', sdpMid: null, sdpMLineIndex: null });
  assert.equal(webrtc.normalizeCandidate({ candidate: { candidate: 5 } }), null);
  assert.equal(webrtc.normalizeCandidate({ candidate: { candidate: 'c', sdpMLineIndex: 1.5 } }), null);
  assert.equal(webrtc.normalizeCandidate({ candidate: { candidate: 'c', sdpMid: 3 } }), null);
  assert.equal(webrtc.normalizeCandidate({ candidate: { candidate: 'x'.repeat(1025) } }), null);
  assert.equal(webrtc.normalizeCandidate({}), null);
});

test('start creates a session with the HA options and returns a 32-hex id', () => {
  const reg = webrtc.createRegistry({ createSession: (o) => new FakeSession(o), timers: fakeTimers() });
  const id = reg.start('front', HA);
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(reg.has(id, 'front'), true);
  assert.equal(reg.has(id, 'driveway'), false);
  reg.end(id, 'test');
});

test('a session nobody attaches to is closed after the abandon timeout', () => {
  const { reg, sessions, timers } = mkRegistry();
  reg.start('front', HA);
  timers.fire(webrtc.ABANDON_MS);
  assert.equal(sessions[0].closed, true);
  assert.equal(reg.size(), 0);
});

test('attaching clears the abandon timer and replays buffered events in order', () => {
  const { reg, sessions, timers } = mkRegistry();
  const id = reg.start('front', HA);
  sessions[0].emit('answer', 'v=0 answer');
  sessions[0].emit('candidate', { candidate: 'c1' });
  const sse = fakeSse();
  assert.equal(reg.attach(id, 'front', sse), true);
  assert.deepEqual(timers.pending(), [webrtc.CAP_MS]);
  sessions[0].emit('candidate', { candidate: 'c2' });
  assert.deepEqual(sse.sent, [
    ['answer', { answer: 'v=0 answer' }],
    ['candidate', { candidate: { candidate: 'c1' } }],
    ['candidate', { candidate: { candidate: 'c2' } }],
  ]);
  reg.end(id, 'test');
});

test('attach refuses a wrong camera or a second stream', () => {
  const { reg } = mkRegistry();
  const id = reg.start('front', HA);
  assert.equal(reg.attach(id, 'driveway', fakeSse()), false);
  assert.equal(reg.attach(id, 'front', fakeSse()), true);
  assert.equal(reg.attach(id, 'front', fakeSse()), false);
  reg.end(id, 'test');
});

test('the hard cap closes the session and ends the stream', () => {
  const { reg, sessions, timers } = mkRegistry();
  const id = reg.start('front', HA);
  const sse = fakeSse();
  reg.attach(id, 'front', sse);
  timers.fire(webrtc.CAP_MS);
  assert.equal(sessions[0].closed, true);
  assert.equal(sse.ended, 'cap');
  assert.equal(reg.size(), 0);
});

test('a third session closes the oldest', () => {
  const { reg, sessions } = mkRegistry();
  const a = reg.start('front', HA);
  reg.start('driveway', HA);
  reg.start('backyard', HA);
  assert.equal(sessions[0].closed, true);
  assert.equal(reg.has(a, 'front'), false);
  assert.equal(reg.size(), 2);
});

test('an HA failure is forwarded as an error event, then the stream ends', () => {
  const { reg, sessions } = mkRegistry();
  const id = reg.start('front', HA);
  const sse = fakeSse();
  reg.attach(id, 'front', sse);
  sessions[0].emit('fail', { code: 'auth_invalid', message: 'HA rejected the token' });
  sessions[0].close();
  assert.deepEqual(sse.sent, [['error', { code: 'auth_invalid', message: 'HA rejected the token' }]]);
  assert.equal(sse.ended, 'closed');
  assert.equal(reg.size(), 0);
});

test('addCandidate forwards to the right session only', () => {
  const { reg, sessions } = mkRegistry();
  const id = reg.start('front', HA);
  assert.equal(reg.addCandidate(id, 'front', { candidate: 'c' }), true);
  assert.equal(reg.addCandidate(id, 'driveway', { candidate: 'x' }), false);
  assert.equal(reg.addCandidate('0'.repeat(32), 'front', { candidate: 'x' }), false);
  assert.deepEqual(sessions[0].cands, [{ candidate: 'c' }]);
  reg.end(id, 'test');
});

test('end() closes the HA session and ends the stream exactly once', () => {
  const { reg, sessions } = mkRegistry();
  const id = reg.start('front', HA);
  const sse = fakeSse();
  reg.attach(id, 'front', sse);
  reg.end(id, 'client_closed');
  reg.end(id, 'again');
  assert.equal(sessions[0].closed, true);
  assert.equal(sse.ended, 'client_closed');
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/webrtc.test.js`
Expected: FAIL with `Cannot find module '../lib/webrtc'`

- [ ] **Step 3: Implement the first part of `lib/webrtc.js`**

```js
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/webrtc.test.js`
Expected: 11 passing

- [ ] **Step 5: Commit**

```bash
git add lib/webrtc.js test/webrtc.test.js
git commit -m "webrtc: session registry with abandon/cap timers, 2-session limit, event buffering"
```

---

### Task 3: HA lookups, routes, and server wiring

**Files:**
- Create: `lib/http-util.js`
- Modify: `lib/webrtc.js` (append lookups and routes, extend exports)
- Modify: `lib/camera.js` (export `findCamera`)
- Modify: `server.js` (import http-util, wire routes, `/api/cameras` adds `live`)
- Test: `test/webrtc.test.js` (append)

**Interfaces:**
- Consumes: `createRegistry`, `validOffer`, `normalizeCandidate` (Task 2); `camera.haConfig(config) → {baseUrl, token, cameras, enabled}`, `camera.findCamera(config, id) → {id, name, entity} | null`, `camera.listCameras(config) → [{id, name}]`.
- Produces:
  - `lib/http-util.js`: `sendJson(res, body, status = 200)`, `readJsonBody(req, maxBytes = 1e6) → Promise<object>` (rejects `Error('body too large')` or `Error('invalid json')`)
  - `haCall(baseUrl, token, msg, { WebSocketImpl, timeoutMs }) → Promise<result>`
  - `createLookups({ call, now }) → { liveMode(baseUrl, token, entity) → Promise<'webrtc'|'hls'|'none'>, clientConfig(baseUrl, token, entity) → Promise<{iceServers, dataChannel?, getCandidatesUpfront?}> }`
  - `listCamerasWithLive(config, lookups) → Promise<[{id, name, live}]>`
  - `createWebrtcRoutes({ registry, lookups }) → async handle(req, res, url, config) → boolean` (true when it handled the request)

- [ ] **Step 1: Create `lib/http-util.js`** by moving `sendJson` and `readJsonBody` out of `server.js`. One behaviour fix: on an oversized body the old code called `req.destroy()`, which kills the socket before any `413` can be written. Instead, keep draining the rest of the body without storing it and reject once:

```js
'use strict';

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
    let tooBig = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Drain without storing, so the caller can still answer 413.
        if (!tooBig) {
          tooBig = true;
          chunks.length = 0;
          reject(new Error('body too large'));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return;
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

module.exports = { sendJson, readJsonBody };
```

In `server.js`, delete the two function definitions and add after the `require('./lib/state')` line:

```js
const { sendJson, readJsonBody } = require('./lib/http-util');
```

Run: `node --test` → the existing tests still pass.

- [ ] **Step 2: Export `findCamera` from `lib/camera.js`**

Change the last line to:

```js
module.exports = { haConfig, listCameras, findCamera, proxy, proxyHls };
```

- [ ] **Step 3: Append the failing route and lookup tests to `test/webrtc.test.js`**

```js
const http = require('http');

const CONFIG = {
  homeAssistant: {
    baseUrl: 'http://ha',
    token: 'T',
    cameras: [{ id: 'front', name: 'Front Door', entity: 'camera.front' }],
  },
};

async function withServer(handle, fn) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!(await handle(req, res, url, CONFIG))) res.writeHead(418).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

function fakeLookups() {
  return {
    calls: [],
    async clientConfig(baseUrl, token, entity) {
      this.calls.push(['clientConfig', entity]);
      return { iceServers: [{ urls: ['stun:x'] }] };
    },
    async liveMode(baseUrl, token, entity) { return entity === 'camera.front' ? 'webrtc' : 'none'; },
  };
}

function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('createLookups maps capabilities and caches them', async () => {
  const calls = [];
  const lookups = webrtc.createLookups({
    call: async (b, t, msg) => {
      calls.push(msg.type);
      return { frontend_stream_types: ['web_rtc'] };
    },
    now: () => 1000,
  });
  assert.equal(await lookups.liveMode('http://ha', 'T', 'camera.front'), 'webrtc');
  assert.equal(await lookups.liveMode('http://ha', 'T', 'camera.front'), 'webrtc');
  assert.deepEqual(calls, ['camera/capabilities']);
});

test('liveMode prefers web_rtc, then hls, and falls back to hls on error without caching', async () => {
  let reply = { frontend_stream_types: ['hls'] };
  let fail = false;
  const lookups = webrtc.createLookups({
    call: async () => { if (fail) throw new Error('down'); return reply; },
    now: () => 0,
  });
  assert.equal(await lookups.liveMode('b', 't', 'camera.a'), 'hls');
  reply = { frontend_stream_types: [] };
  assert.equal(await lookups.liveMode('b', 't', 'camera.b'), 'none');
  fail = true;
  assert.equal(await lookups.liveMode('b', 't', 'camera.c'), 'hls');
  fail = false;
  reply = { frontend_stream_types: ['web_rtc', 'hls'] };
  assert.equal(await lookups.liveMode('b', 't', 'camera.c'), 'webrtc');
});

test('clientConfig passes iceServers and optional fields through', async () => {
  const lookups = webrtc.createLookups({
    call: async () => ({ configuration: { iceServers: [{ urls: ['stun:a'] }] }, dataChannel: 'dc' }),
    now: () => 0,
  });
  assert.deepEqual(await lookups.clientConfig('b', 't', 'camera.a'),
    { iceServers: [{ urls: ['stun:a'] }], dataChannel: 'dc' });
});

test('listCamerasWithLive adds the live mode per camera', async () => {
  const cams = await webrtc.listCamerasWithLive(CONFIG, fakeLookups());
  assert.deepEqual(cams, [{ id: 'front', name: 'Front Door', live: 'webrtc' }]);
});

test('GET config returns the client config; unknown camera is 404', async () => {
  const lookups = fakeLookups();
  const handle = webrtc.createWebrtcRoutes({ registry: mkRegistry().reg, lookups });
  await withServer(handle, async (base) => {
    const r = await fetch(`${base}/api/cam/front/webrtc/config`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { iceServers: [{ urls: ['stun:x'] }] });
    assert.equal((await fetch(`${base}/api/cam/nope/webrtc/config`)).status, 404);
    assert.equal((await fetch(`${base}/api/elsewhere`)).status, 418);
  });
});

test('POST offer validates, then starts a session', async () => {
  const { reg, sessions } = mkRegistry();
  const handle = webrtc.createWebrtcRoutes({ registry: reg, lookups: fakeLookups() });
  await withServer(handle, async (base) => {
    assert.equal((await post(`${base}/api/cam/front/webrtc`, { offer: 'nope' })).status, 400);
    assert.equal((await post(`${base}/api/cam/front/webrtc`, { offer: 'v=0' + 'x'.repeat(70 * 1024) })).status, 413);
    const r = await post(`${base}/api/cam/front/webrtc`, { offer: 'v=0\r\n' });
    assert.equal(r.status, 201);
    const { session } = await r.json();
    assert.match(session, /^[a-f0-9]{32}$/);
    assert.deepEqual(sessions[0].opts, { baseUrl: 'http://ha', token: 'T', entity: 'camera.front', offer: 'v=0\r\n' });
    reg.end(session, 'test');
  });
});

test('POST candidate validates and forwards; unknown session is 404', async () => {
  const { reg, sessions } = mkRegistry();
  const handle = webrtc.createWebrtcRoutes({ registry: reg, lookups: fakeLookups() });
  const id = reg.start('front', HA);
  await withServer(handle, async (base) => {
    assert.equal((await post(`${base}/api/cam/front/webrtc/${id}/candidate`, { candidate: { candidate: 5 } })).status, 400);
    assert.equal((await post(`${base}/api/cam/front/webrtc/${'f'.repeat(32)}/candidate`, { candidate: { candidate: 'c' } })).status, 404);
    const r = await post(`${base}/api/cam/front/webrtc/${id}/candidate`, { candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } });
    assert.equal(r.status, 204);
    assert.deepEqual(sessions[0].cands, [{ candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 }]);
  });
  reg.end(id, 'test');
});

test('SSE stream delivers session events and closing it ends the session', async () => {
  const { reg, sessions } = mkRegistry();
  const handle = webrtc.createWebrtcRoutes({ registry: reg, lookups: fakeLookups() });
  const id = reg.start('front', HA);
  sessions[0].emit('answer', 'v=0 answer');
  await withServer(handle, async (base) => {
    assert.equal((await fetch(`${base}/api/cam/front/webrtc/${'f'.repeat(32)}/events`)).status, 404);
    const ctrl = new AbortController();
    const r = await fetch(`${base}/api/cam/front/webrtc/${id}/events`, { signal: ctrl.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const reader = r.body.getReader();
    let text = '';
    while (!text.includes('event: answer')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /event: answer\ndata: {"answer":"v=0 answer"}\n\n/);
    ctrl.abort();
    for (let i = 0; i < 50 && reg.size() > 0; i++) await new Promise((r2) => setTimeout(r2, 10));
    assert.equal(reg.size(), 0);
    assert.equal(sessions[0].closed, true);
  });
});

test('routes answer 503 when HA is not configured', async () => {
  const handle = webrtc.createWebrtcRoutes({ registry: mkRegistry().reg, lookups: fakeLookups() });
  const server = http.createServer(async (req, res) => {
    await handle(req, res, new URL(req.url, 'http://localhost'), { homeAssistant: {} });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/cam/front/webrtc/config`);
    assert.equal(r.status, 503);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
```

- [ ] **Step 4: Run the tests and confirm the new ones fail**

Run: `node --test test/webrtc.test.js`
Expected: the new tests FAIL with `webrtc.createLookups is not a function` (and similar); the earlier 11 still pass.

- [ ] **Step 5: Append the lookups and routes to `lib/webrtc.js`** (above `module.exports`) and add the requires at the top

At the top, next to the existing requires:

```js
const camera = require('./camera');
const { sendJson, readJsonBody } = require('./http-util');
```

Above `module.exports`:

```js
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
```

Replace `module.exports` with:

```js
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
```

- [ ] **Step 6: Wire `server.js`**

After `const camera = require('./lib/camera');`:

```js
const webrtc = require('./lib/webrtc');
```

After `const PUBLIC_DIR = ...`:

```js
const webrtcLookups = webrtc.createLookups();
const handleWebrtc = webrtc.createWebrtcRoutes({
  registry: webrtc.createRegistry(),
  lookups: webrtcLookups,
});
```

Replace the `/api/cameras` handler:

```js
    if (url.pathname === '/api/cameras') {
      return sendJson(res, { cameras: await webrtc.listCamerasWithLive(config, webrtcLookups) });
    }
    if (await handleWebrtc(req, res, url, config)) return;
```

- [ ] **Step 7: Run the whole suite and confirm it passes**

Run: `node --test`
Expected: every test passes (state, calendar-pure, webrtc-session, webrtc).

- [ ] **Step 8: Commit**

```bash
git add lib/http-util.js lib/webrtc.js lib/camera.js server.js test/webrtc.test.js
git commit -m "webrtc: HA lookups, SSE+POST signalling routes, /api/cameras live mode"
```

---

### Task 4: Browser client and tap-for-live UI

**Files:**
- Create: `public/webrtc-client.js`
- Modify: `public/index.html` (script tag)
- Modify: `public/app.js` (camera section)

**Interfaces:**
- Consumes: the routes from Task 3; `/api/cameras` items `{id, name, live}`.
- Produces: `window.startWebrtc(id, videoEl, { onPlaying, onFail }) → { close() }`

- [ ] **Step 1: Create `public/webrtc-client.js`**

```js
/* WebRTC live view through the wall-display server's signalling relay.
 * The token never reaches this page: offer/candidates are POSTed to
 * /api/cam/:id/webrtc..., the answer/candidates/errors arrive on an SSE
 * stream, and closing that stream ends the camera session server-side.
 * ES5 style to match app.js. */
(function () {
  'use strict';

  var DISCONNECT_GRACE_MS = 5000;

  function postJSON(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.status === 204 ? null : r.json();
    });
  }

  function candidateJSON(c) {
    if (c.toJSON) return c.toJSON();
    return { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };
  }

  function startWebrtc(id, videoEl, opts) {
    var onPlaying = (opts && opts.onPlaying) || function () {};
    var onFail = (opts && opts.onFail) || function () {};
    var base = '/api/cam/' + encodeURIComponent(id) + '/webrtc';
    var pc = null;
    var es = null;
    var session = null;
    var closed = false;
    var remoteSet = false;
    var remoteQueue = [];
    var localQueue = [];
    var discTimer = null;

    var handle = {
      close: function () {
        if (closed) return;
        closed = true;
        clearTimeout(discTimer);
        if (es) { try { es.close(); } catch (e) { /* ignore */ } }
        if (pc) { try { pc.close(); } catch (e) { /* ignore */ } }
        videoEl.onplaying = null;
        try { videoEl.pause(); } catch (e) { /* ignore */ }
        videoEl.srcObject = null;
      }
    };

    function fail(reason) {
      if (closed) return;
      handle.close();
      onFail(reason);
    }

    function sendLocal(c) {
      if (!session) { localQueue.push(c); return; }
      postJSON(base + '/' + session + '/candidate', { candidate: c }).catch(function () {});
    }

    function addRemote(c) {
      if (!remoteSet) { remoteQueue.push(c); return; }
      pc.addIceCandidate(c).catch(function () {});
    }

    if (!window.RTCPeerConnection || !window.EventSource) {
      setTimeout(function () { fail('unsupported'); }, 0);
      return handle;
    }

    fetch(base + '/config', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('config HTTP ' + r.status);
        return r.json();
      })
      .then(function (cfg) {
        if (closed) return null;
        pc = new RTCPeerConnection({ iceServers: cfg.iceServers || [] });
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
        if (cfg.dataChannel) pc.createDataChannel(cfg.dataChannel);

        pc.onicecandidate = function (e) {
          if (e.candidate) sendLocal(candidateJSON(e.candidate));
        };
        pc.ontrack = function (e) {
          var stream = e.streams && e.streams[0];
          if (!stream) {
            stream = videoEl.srcObject || new MediaStream();
            stream.addTrack(e.track);
          }
          if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
          videoEl.muted = true;
          var p = videoEl.play();
          if (p && p.catch) p.catch(function () {});
        };
        pc.onconnectionstatechange = function () {
          var st = pc.connectionState;
          clearTimeout(discTimer);
          if (st === 'failed' || st === 'closed') {
            fail('connection ' + st);
          } else if (st === 'disconnected') {
            discTimer = setTimeout(function () { fail('disconnected'); }, DISCONNECT_GRACE_MS);
          }
        };
        videoEl.onplaying = function () {
          videoEl.onplaying = null;
          if (!closed) onPlaying();
        };
        return pc.createOffer();
      })
      .then(function (offer) {
        if (closed || !offer) return null;
        return pc.setLocalDescription(offer).then(function () {
          return postJSON(base, { offer: pc.localDescription.sdp });
        });
      })
      .then(function (res) {
        if (closed || !res) return;
        session = res.session;
        localQueue.splice(0).forEach(sendLocal);

        es = new EventSource(base + '/' + session + '/events');
        es.addEventListener('answer', function (e) {
          var d = JSON.parse(e.data);
          pc.setRemoteDescription({ type: 'answer', sdp: d.answer })
            .then(function () {
              remoteSet = true;
              remoteQueue.splice(0).forEach(addRemote);
            })
            .catch(function () { fail('bad answer'); });
        });
        es.addEventListener('candidate', function (e) {
          addRemote(JSON.parse(e.data).candidate);
        });
        // Fires both for the server's `error` events and for a dropped stream.
        es.addEventListener('error', function () { fail('stream error'); });
        es.addEventListener('end', function () { fail('stream ended'); });
      })
      .catch(function (err) { fail(String((err && err.message) || err)); });

    return handle;
  }

  window.startWebrtc = startWebrtc;
})();
```

- [ ] **Step 2: Load it in `public/index.html`**, between the `hls.min.js` and `app.js` tags:

```html
<script src="/hls.min.js"></script>
<script src="/webrtc-client.js"></script>
<script src="/app.js"></script>
```

- [ ] **Step 3: Update the camera constants and state in `public/app.js`**

Replace the constants block and `cam` declaration with:

```js
var CAM_AUTO_CLOSE_MS = 90 * 1000; // don't leave the overlay burning the LCD
var CAM_POLL_MS = 2000;            // snapshot cadence
var CAM_LIVE_START_MS = 25000;     // give a live stream this long to show a frame
var CAM_LIVE_MAX_MS = 5 * 60 * 1000; // live view cap, then back to the grid

var MSG_TAP_LIVE = 'Last event \u00b7 tap for live';
var MSG_LIVE_FAILED = 'Live view unavailable \u2014 showing last event';

var cam = {
  list: [],
  open: false,
  soloId: null,
  closeTimer: null,
  tiles: {}, // id -> { video, img, msgEl, hls, rtc, mode, liveTimer, maxTimer, pollTimer }
};

function camInfo(id) {
  for (var i = 0; i < cam.list.length; i++) if (cam.list[i].id === id) return cam.list[i];
  return null;
}
```

- [ ] **Step 4: In `openCam()`**, change the tile state and the start call:

```js
    cam.tiles[c.id] = {
      video: video, img: img, msgEl: msg,
      hls: null, rtc: null, mode: null, liveTimer: null, maxTimer: null, pollTimer: null,
    };
    startTileSnapshot(c.id);
```

(This replaces `startTileLive(c.id);`, so nothing goes live when the grid opens.)

- [ ] **Step 5: Replace `startTileLive`, `startTileSnapshot`, `toggleCamSolo`, `bumpCamAutoClose`, and `closeCam`** (keep `destroyTileHls` and `stopTilePoll` as they are):

```js
function stopTileLive(t) {
  if (!t) return;
  clearTimeout(t.liveTimer);
  t.liveTimer = null;
  clearTimeout(t.maxTimer);
  t.maxTimer = null;
  if (t.rtc) {
    t.rtc.close();
    t.rtc = null;
  }
  destroyTileHls(t);
  try { t.video.pause(); } catch (e) { /* ignore */ }
  t.video.onplaying = null;
  t.video.onerror = null;
  t.video.srcObject = null;
  t.video.removeAttribute('src');
  if (t.video.load) t.video.load(); // fully drop the stream
}

// Live view for one tile: WebRTC or HLS, whichever HA offers for this camera.
function startTileLive(id) {
  var t = cam.tiles[id];
  if (!t) return;
  var info = camInfo(id);
  var mode = (info && info.live) || 'hls'; // older servers didn't send `live`
  if (mode === 'none') return;

  stopTilePoll(t);
  stopTileLive(t);
  t.mode = 'live';
  clearTimeout(cam.closeTimer); // no auto-close while watching live
  cam.closeTimer = null;

  t.img.hidden = true;
  t.video.hidden = false;
  t.msgEl.textContent = 'Starting live view\u2026';
  t.msgEl.hidden = false;

  function playing() {
    clearTimeout(t.liveTimer);
    t.msgEl.hidden = true;
  }
  function fallback(why) {
    if (t.mode !== 'live') return;
    console.warn('camera "' + id + '" live view failed (' + why + '); using last snapshot');
    startTileSnapshot(id, MSG_LIVE_FAILED);
    bumpCamAutoClose();
  }

  // Ring live view is slow to spin up; give it a while, then show the snapshot.
  t.liveTimer = setTimeout(function () { fallback('slow to start'); }, CAM_LIVE_START_MS);
  t.maxTimer = setTimeout(function () { exitCamSolo(); }, CAM_LIVE_MAX_MS);

  if (mode === 'webrtc') {
    t.rtc = window.startWebrtc(id, t.video, { onPlaying: playing, onFail: fallback });
    return;
  }

  var src = '/api/cam/' + encodeURIComponent(id) + '/hls?t=' + Date.now();
  t.video.onplaying = playing;
  if (window.Hls && window.Hls.isSupported()) {
    var hls = new window.Hls({
      liveSyncDurationCount: 3,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 3,
      levelLoadingTimeOut: 20000,
      fragLoadingTimeOut: 30000,
      backBufferLength: 15,
    });
    t.hls = hls;
    hls.on(window.Hls.Events.ERROR, function (evt, data) {
      if (!data || !data.fatal) return;
      fallback('hls ' + data.type + ' ' + data.details);
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
      var p = t.video.play();
      if (p && p.catch) p.catch(function () {});
    });
    hls.loadSource(src);
    hls.attachMedia(t.video);
  } else if (t.video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari / iOS WebView -- native HLS
    t.video.onerror = function () { fallback('native hls error'); };
    t.video.src = src;
    var p2 = t.video.play();
    if (p2 && p2.catch) p2.catch(function () {});
  } else {
    fallback('no hls support');
  }
}

// Snapshot poll (for Ring, the last event's frame). `note` is the tile caption.
function startTileSnapshot(id, note) {
  var t = cam.tiles[id];
  if (!t) return;
  stopTileLive(t);
  t.mode = 'snapshot';

  t.video.hidden = true;
  t.img.hidden = false;
  t.msgEl.textContent = note || MSG_TAP_LIVE;
  t.msgEl.hidden = false;
  t.img.onload = null;
  t.img.onerror = function () {
    t.msgEl.textContent = 'Camera unavailable';
    t.msgEl.hidden = false;
  };

  function tick() {
    t.img.src = '/api/cam/' + encodeURIComponent(id) + '/snapshot?t=' + Date.now();
  }
  tick();
  clearInterval(t.pollTimer);
  t.pollTimer = setInterval(tick, CAM_POLL_MS);
}

function toggleCamSolo(id) {
  if (cam.soloId === id) exitCamSolo();
  else enterCamSolo(id);
}

function enterCamSolo(id) {
  if (cam.soloId) exitCamSolo();
  var grid = $('camGrid');
  grid.classList.add('solo');
  var el = grid.querySelector('.cam-tile[data-cam="' + id + '"]');
  if (el) el.classList.add('solo');
  cam.soloId = id;
  // Hidden tiles stop polling while one is solo.
  Object.keys(cam.tiles).forEach(function (k) { if (k !== id) stopTilePoll(cam.tiles[k]); });
  startTileLive(id);
  bumpCamAutoClose(); // no-op while live; arms it for a camera with no live mode
}

function exitCamSolo() {
  if (!cam.open) return;
  var grid = $('camGrid');
  var tiles = grid.querySelectorAll('.cam-tile');
  for (var i = 0; i < tiles.length; i++) tiles[i].classList.remove('solo');
  grid.classList.remove('solo');
  cam.soloId = null;
  Object.keys(cam.tiles).forEach(function (k) { startTileSnapshot(k); });
  bumpCamAutoClose();
}

function camIsLive() {
  var t = cam.soloId && cam.tiles[cam.soloId];
  return !!(t && t.mode === 'live');
}

function bumpCamAutoClose() {
  if (!cam.open) return;
  clearTimeout(cam.closeTimer);
  cam.closeTimer = null;
  if (camIsLive()) return; // paused while watching live
  cam.closeTimer = setTimeout(closeCam, CAM_AUTO_CLOSE_MS);
}

function closeCam() {
  cam.open = false;
  cam.soloId = null;
  clearTimeout(cam.closeTimer);
  cam.closeTimer = null;
  Object.keys(cam.tiles).forEach(function (id) {
    var t = cam.tiles[id];
    stopTilePoll(t);
    stopTileLive(t);
    t.img.onerror = null;
    t.img.onload = null;
    t.img.removeAttribute('src');
  });
  cam.tiles = {};
  var grid = $('camGrid');
  grid.classList.remove('solo');
  grid.innerHTML = '';
  $('camOverlay').hidden = true;
}
```

- [ ] **Step 6: Syntax-check the frontend files**

Run: `node --check public/webrtc-client.js && node --check public/app.js`
Expected: no output (both parse).

- [ ] **Step 7: Commit**

```bash
git add public/webrtc-client.js public/index.html public/app.js
git commit -m "cameras: snapshot grid with tap-for-live over WebRTC (HLS kept for non-WebRTC cameras)"
```

---

### Task 5: End-to-end verification, docs, PR

**Files:**
- Modify: `README.md` (camera section)

- [ ] **Step 1: Run the branch in a throwaway container on a spare port**, using the live stack's `.env`:

```bash
cd /a/Project/wall-display-webrtc
docker build -t wall-display:webrtc-test .
docker run -d --rm --name wall-display-webrtc-test -p 8081:8080 --env-file ../wall-display/.env \
  -e HA_CAMERAS_JSON='[{"id":"front","name":"Front Door","entity":"camera.front_door_live_view"},{"id":"driveway","name":"Driveway","entity":"camera.driveway_live_view"},{"id":"backyard","name":"Back Yard","entity":"camera.backyard_live_view"}]' \
  wall-display:webrtc-test
curl -s http://localhost:8081/api/cameras
```

Expected: three cameras, each with `"live":"webrtc"`.

- [ ] **Step 2: Drive it in the browser pane.** Open `http://localhost:8081/`, click **Cameras**, and confirm all three tiles show snapshots captioned `Last event · tap for live`. Click **Front Door**. Expected: `Starting live view…`, then live video within about 10 s, with the caption hidden. Container logs (`docker logs wall-display-webrtc-test`) show `camera "front" webrtc session started`. Click the tile again. Expected: back to the snapshot grid, and the logs show `webrtc stream closed by client`. Take a screenshot while live as proof.

- [ ] **Step 3: Stop the test container**

```bash
docker stop wall-display-webrtc-test
```

- [ ] **Step 4: Update `README.md`'s camera section.** Describe the new behaviour: the grid shows each camera's last event, and tapping a tile goes live over WebRTC (HLS for cameras that don't offer WebRTC) for up to 5 minutes. The token stays server-side; signalling runs through `/api/cam/:id/webrtc`.

- [ ] **Step 5: Commit, push, and open the PR**

```bash
git add README.md docs/superpowers/plans/2026-09-23-webrtc-live-view.md
git commit -m "docs: WebRTC live view in README; implementation plan"
git push -u origin feature/webrtc-live-view
gh pr create --repo MTNHMMR/family-screen --base main --head feature/webrtc-live-view \
  --title "Cameras: WebRTC live view (Ring is WebRTC-only on current HA)" --body-file <prepared body>
```

- [ ] **Step 6: After merge: deploy.** In `A:\Project\wall-display`: `git checkout .gitignore` (the same line is now on `main`), `git pull`, then `docker compose up -d --build`. Justin checks the Fire.
