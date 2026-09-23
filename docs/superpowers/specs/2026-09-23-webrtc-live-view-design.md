# WebRTC live view for Ring cameras

Date: 2026-09-23

## Goal

Bring back live camera video in the Cameras view. The Home Assistant install was rebuilt on 2026-09-23 as a Home Assistant OS VM, and its current Ring integration implements **native WebRTC**. Home Assistant treats such a camera as WebRTC-only and never offers HLS. The existing live path (websocket `camera/stream` with `format: "hls"`, proxied `.m3u8`/`.ts`, `hls.js`) now fails with:

```
start_stream_failed: camera.front_door_live_view does not support play stream service
```

and every tile falls back to the snapshot poll, which for Ring is the last event's frame, not a live view.

This design adds a WebRTC live path. The Home Assistant token still never leaves the server, and the existing snapshot and HLS paths stay.

## Out of scope

- Audio playback and two-way talk. The video element stays muted.
- PTZ, recording, and motion or doorbell alerts that pop the view open automatically.
- Replacing HLS. It stays for any camera that reports HLS rather than WebRTC.
- Direct browser-to-HA signalling (rejected: it would put the token on the tablet).

## Behaviour changes (decided 2026-09-23)

1. **The grid opens with snapshots on every tile.** Nothing goes live automatically. The tile message reads **"Last event · tap for live"**. (Previously every tile tried to go live at once. With WebRTC that means N concurrent Ring sessions and N live decodes on a Fire HD 8, so it was rejected.)
2. **Tapping a tile** enters solo view and starts live video for that camera only. **Tapping again** ends the live session and returns to the snapshot grid.
3. **A live view runs at most 5 minutes**, then returns to the snapshot grid. The overlay's 90-second auto-close is **paused while a tile is live** and re-armed when live ends.
4. While a tile is live, the other (hidden) tiles stop polling snapshots.

## Signalling transport (decided 2026-09-23)

The browser sends the offer as a POST and its ICE candidates as further POSTs. The server sends the answer, its candidates, and errors back over **Server-Sent Events**. The SSE connection's lifetime **is** the session: when it closes, the server closes the HA websocket, HA unsubscribes, and HA calls `close_webrtc_session` on the Ring camera.

Rejected alternatives:

- **Browser↔server websocket relay.** Node 22 has a global `WebSocket` *client* but no server, so this would need the `ws` package (a third dependency) or hand-rolled RFC 6455 framing. It gains nothing over SSE+POST.
- **Non-trickle single request** (browser waits for full ICE gathering, server returns the answer plus the candidates collected in the first few seconds). This drops late Ring candidates, and the server still has to hold the HA websocket open with no clean signal for when to close it.

## Home Assistant protocol (as used here)

All messages go over `ws(s)://<HA>/api/websocket` after the normal `auth_required` → `auth` → `auth_ok` handshake with the long-lived token.

| Direction | Message | Purpose |
|---|---|---|
| → HA | `{id, type: "camera/capabilities", entity_id}` | result `frontend_stream_types` contains `"web_rtc"` and/or `"hls"` |
| → HA | `{id, type: "camera/webrtc/get_client_config", entity_id}` | result `configuration` (`iceServers`, …) and possibly `dataChannel` / `getCandidatesUpfront` |
| → HA | `{id, type: "camera/webrtc/offer", entity_id, offer: <sdp>}` | **subscription**; HA replies `result` then `event` messages |
| ← HA | `event: {type: "session", session_id}` | HA's session id for this offer |
| ← HA | `event: {type: "answer", answer: <sdp>}` | the SDP answer |
| ← HA | `event: {type: "candidate", candidate: {candidate, sdpMid, sdpMLineIndex}}` | trickled remote candidate |
| ← HA | `event: {type: "error", code, message}` | the session failed |
| → HA | `{id, type: "camera/webrtc/candidate", entity_id, session_id, candidate}` | trickled local candidate |

**Verify before building (implementation step 1):** a throwaway script runs one real offer against `camera.front_door_live_view` and records the actual shapes of the client-config result and the event payloads. That includes whether Ring requires a data channel and whether candidates carry `sdpMid`, `sdpMLineIndex`, or both. The code follows whatever HA returns. Where the real shapes differ from the table above, the table is corrected before coding. The script is not committed, and it logs message *types and keys*, never SDP bodies or the token.

## 1. Backend: `lib/webrtc.js` (new)

This is a separate module because `lib/camera.js` is already 328 lines. It reuses `camera.js`'s `haConfig()` and camera whitelist (`findCamera`, exported for this). Nothing caller-supplied reaches HA except the SDP and candidate strings, and the camera is always resolved from the `id` whitelist.

### `HaWebrtcSession` (an EventEmitter)

- `constructor({ baseUrl, token, entity, offer, WebSocketImpl = globalThis.WebSocket })`. `WebSocketImpl` is injectable so tests can pass a fake.
- It opens the websocket, completes auth, and sends `camera/webrtc/offer`.
- It emits `session` (HA session id), `answer` (sdp), `candidate` (object), `error` ({code, message}), and `close`.
- `addCandidate(candidate)`: if HA's session id isn't known yet, the candidate is queued and flushed when the `session` event arrives. After that it is sent immediately as `camera/webrtc/candidate`.
- `close()`: closes the websocket. This is idempotent and emits `close` once.
- Auth failure (`auth_invalid`), a `result` with `success: false`, a websocket error, or an early close each emit `error` and then `close`.

### Session registry

`Map<ourSessionId, { cam, ha, sse, createdAt, abandonTimer, capTimer }>`.

- `ourSessionId` = `crypto.randomBytes(16).toString('hex')`. The browser never sees HA's session id.
- **Abandon timer (10 s):** if the browser hasn't opened the SSE stream within 10 s of the offer, the session is closed.
- **Hard cap (5 min + 10 s grace):** the session is closed server-side even if the browser's own 5-minute timer never fires.
- **Max 2 concurrent sessions**, so switching cameras can overlap briefly. Creating a third closes the oldest.
- HA events that arrive before the SSE stream is attached are buffered and replayed when it attaches.
- Closing the session from any cause closes the HA websocket, ends the SSE stream (sending `event: end` first if it's still open), clears the timers, and deletes the map entry.

### Cached lookups

- `capabilities(entity)` → `"webrtc" | "hls" | "none"`, preferring `web_rtc`, then `hls`. It is cached for 10 minutes. On error it returns `"hls"` so the old behaviour is the fallback.
- `clientConfig(entity)`: the `get_client_config` result, cached for 5 minutes.

Both use a short-lived one-shot HA websocket, the same pattern as the existing `fetchHlsUrl()`.

## 2. Backend: routes (`server.js`)

Plain `http`, the same style as the existing routes.

| Route | Returns |
|---|---|
| `GET /api/cameras` | unchanged shape plus `live: "webrtc" \| "hls" \| "none"` per camera |
| `GET /api/cam/:id/webrtc/config` | `{ iceServers, dataChannel?, getCandidatesUpfront? }` from `clientConfig()` |
| `POST /api/cam/:id/webrtc` | body `{ offer: string }` → `201 { session }` |
| `GET /api/cam/:id/webrtc/:session/events` | `text/event-stream`, with events `answer`, `candidate`, `error`, `end`. A comment ping every 15 s keeps proxies and kiosk browsers from idling it out |
| `POST /api/cam/:id/webrtc/:session/candidate` | body `{ candidate: {candidate, sdpMid?, sdpMLineIndex?} }` → `204` |

Validation:

- POST bodies are capped at **64 KB** (`413` over).
- `offer` must be a string starting `v=0` and under 32 KB.
- `candidate.candidate` must be a string under 1 KB. `sdpMid` must be a string or null. `sdpMLineIndex` must be an integer or null.
- An unknown camera returns `404`. An unknown session, or a session belonging to a different camera, also returns `404`.
- HA not configured returns `503`.

## 3. Frontend: `public/webrtc-client.js` (new)

ES5 style (`var`, function declarations), loaded with a plain `<script>` before `app.js`, like `hls.min.js`.

`startWebrtc(id, videoEl, { onPlaying, onFail })` returns `{ close() }`:

1. If `window.RTCPeerConnection` or `window.EventSource` is missing, call `onFail('unsupported')` asynchronously.
2. `GET /api/cam/:id/webrtc/config`, then `new RTCPeerConnection({ iceServers })`.
3. `addTransceiver('video', {direction:'recvonly'})` and `addTransceiver('audio', {direction:'recvonly'})`. If config has `dataChannel`, call `createDataChannel(dataChannel)`.
4. `createOffer()`, `setLocalDescription()`, POST the offer to get `{session}`, then open an `EventSource` on `.../events`.
5. SSE `answer` → `setRemoteDescription({type:'answer', sdp})`, then flush any queued remote candidates. SSE `candidate` → queue until the remote description is set, then `addIceCandidate`. SSE `error` or `end` → `onFail`.
6. `onicecandidate` → POST each non-null candidate (fire-and-forget; errors ignored).
7. `ontrack` → `videoEl.srcObject = event.streams[0]`, `muted = true`, `play()`. The first `playing` event calls `onPlaying`.
8. `connectionState === 'failed'`, or `'disconnected'` for more than 5 s → `onFail`.
9. `close()` is idempotent. It closes the `EventSource` and the peer connection and clears `srcObject`.

`onFail` fires at most once per handle.

## 4. Frontend: `public/app.js`

- `openCam()` builds the tiles as today but calls `startTileSnapshot(id)` for every tile (no auto-live). The snapshot message becomes "Last event · tap for live".
- A tile tap calls `toggleCamSolo(id)`. Entering solo calls `startTileLive(id)`. Leaving solo stops live and restores the snapshot on every tile.
- `startTileLive(id)` dispatches on the camera's `live` value: `webrtc` → `startWebrtc`, `hls` → the existing hls.js path (unchanged), `none` → stay on the snapshot.
- Per-tile state gains `rtc` (the handle). Teardown (`stopTileLive`) closes whichever of `rtc` or `hls` is present.
- Timers: the 25 s startup grace (`CAM_LIVE_START_MS`) is unchanged and applies to WebRTC too. The new `CAM_LIVE_MAX_MS = 5 * 60 * 1000` returns to the grid when it expires. The 90 s auto-close is cleared on live start and re-armed on live end.
- While solo-live, the other tiles' `pollTimer`s are stopped and then restarted on leaving solo.
- Overlay close (✕, backdrop, Esc, auto-close) stops live on every tile.

No visual changes beyond the message wording.

## 5. Failure handling

| Failure | Result |
|---|---|
| Token rejected or HA websocket unreachable | Offer POST → `502`; the tile shows the snapshot with "Live view unavailable — showing last event" |
| Ring or HA `error` event | Sent over SSE as `error`; the tile falls back to the snapshot; the server closes the session |
| Connection fails or stays disconnected more than 5 s | The tile falls back to the snapshot; `close()` tears the session down |
| Browser reloads, sleeps, or closes the overlay | SSE closes → server closes the HA websocket → Ring stops |
| Browser vanishes silently | The 10 s abandon timer or the 5 min cap cleans up |
| Server restart | All sessions are dropped; SSE breaks; tiles fall back to snapshots |

Logging records the camera id and event type only. **SDP bodies, candidates, and the token are never logged.**

## 6. Testing

- **Step 1 is the protocol spike** described above, and it runs before any code is written.
- **Unit tests** (`node --test`, new `test/webrtc.test.js`):
  - `HaWebrtcSession` against a fake `WebSocketImpl`: the auth handshake; `session`/`answer`/`candidate`/`error` events; candidates queued until the session id arrives and then flushed in order; `auth_invalid` and `success:false` → `error` + `close`; `close()` idempotent.
  - Registry with injected timers/clock: the 10 s abandon, the 5 min cap, the 2-session cap closing the oldest, events buffered before the SSE attaches and then replayed.
  - Validation helpers: body size, offer and candidate shapes.
- **Browser test:** drive the display in a Chromium browser pane against the running container. Tap the front door and confirm video plays; tap back and confirm the server log shows the session closed.
- **Device test (Justin):** the Fire HD 8 in Fully Kiosk opens Cameras, taps the front door, and gets live video.

## 7. Rollout

- Feature branch `feature/webrtc-live-view` (worktree `A:\Project\wall-display-webrtc`), then a PR to `MTNHMMR/family-screen`.
- After merge, run `docker compose up -d --build` in `A:\Project\wall-display`. The stack is currently deployed from the command line, not Portainer.
- Docs: the README camera section; the vault's `DESIGN-Cam-Button` note (move WebRTC out of *Rejected* with the reason, and add "all tiles live at once" to *Rejected*); the `PROJECT-Kindle Wall Display` note.
