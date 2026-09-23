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
