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
