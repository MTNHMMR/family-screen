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
