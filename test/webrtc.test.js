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
