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
