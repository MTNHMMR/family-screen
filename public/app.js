'use strict';

var WEATHER_MS = 10 * 60 * 1000;
var CAL_MS = 5 * 60 * 1000;
var FETCH_TIMEOUT_MS = 20000;
var RELOAD_HOUR = 3; // full page reload window, local time
var RELOAD_MIN = 30;
var COUNTDOWN_ROTATE_MS = 10000;
var COUNTDOWN_FADE_MS = 300;

var state = {
  weather: null,
  weatherAt: 0,
  weatherFail: 0,
  calendar: null,
  calendarAt: 0,
  calendarFail: 0,
  countdown: null,
  countdownIdx: 0,
  countdownTimer: null,
  bootAt: Date.now(),
};

/* ------------------------------------------------------------------ utils */

function $(id) { return document.getElementById(id); }

function parseEventStart(startStr) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startStr);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(startStr);
}

function fetchJSON(url) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal, cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .finally(function () { clearTimeout(t); });
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function localDayKey(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function parseDayKey(key) {
  var p = key.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtHour(d) {
  return d.toLocaleTimeString([], { hour: 'numeric' }).replace(/\s/, '');
}

/* ------------------------------------------------------------------ clock */

function tickClock() {
  var now = new Date();
  $('clock').textContent = now
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('date').textContent = now.toLocaleDateString([], {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  if (now.getHours() === RELOAD_HOUR && now.getMinutes() === RELOAD_MIN) {
    location.reload();
  }
  if (Date.now() - state.bootAt > 26 * 60 * 60 * 1000) {
    location.reload();
  }
}

/* ------------------------------------------------------------------ weather */

function renderWeather() {
  var w = state.weather;
  if (!w) return;
  var c = w.current || {};
  $('wxIcon').textContent = c.icon || (w.daily[0] && w.daily[0].icon) || '·';
  $('wxTemp').textContent = (c.temp != null ? c.temp : '--') + '°';
  var desc = c.description || (w.daily[0] && w.daily[0].shortForecast) || '';
  $('wxDesc').textContent = desc;

  var bits = [];
  if (c.feelsLike != null && c.temp != null && Math.abs(c.feelsLike - c.temp) >= 3) {
    bits.push('Feels ' + c.feelsLike + '°');
  }
  if (w.daily[0] && w.daily[0].high != null) {
    bits.push('H ' + w.daily[0].high + '°');
  }
  var lowToday = w.daily[0] && w.daily[0].low;
  if (lowToday != null) bits.push('L ' + lowToday + '°');
  if (c.humidity != null) bits.push(c.humidity + '% RH');
  if (c.windMph != null) {
    bits.push(c.windMph + (c.windDir ? ' mph ' + c.windDir : ' mph'));
  }
  $('wxExtra').textContent = bits.join('   ');

  // hourly
  var hEl = $('hourly');
  hEl.innerHTML = '';
  (w.hourly || []).slice(0, 7).forEach(function (h) {
    var row = document.createElement('div');
    row.className = 'hour';
    var precip = h.precip != null && h.precip >= 15 ? h.precip + '%' : '';
    row.innerHTML =
      '<span class="h-time">' + fmtHour(new Date(h.time)) + '</span>' +
      '<span class="h-icon">' + h.icon + '</span>' +
      '<span class="h-temp">' + h.temp + '°</span>' +
      '<span class="h-precip">' + precip + '</span>';
    hEl.appendChild(row);
  });

  // forecast
  var fEl = $('forecast');
  fEl.innerHTML = '';
  (w.daily || []).slice(0, 4).forEach(function (d) {
    var row = document.createElement('div');
    row.className = 'fc';
    var precip = d.precip == null ? '–' : '💧' + d.precip + '%';
    row.innerHTML =
      '<span class="f-name">' + shortDayName(d) + '</span>' +
      '<span class="f-icon">' + d.icon + '</span>' +
      '<span class="f-precip">' + precip + '</span>' +
      '<span class="f-hi">' + (d.high != null ? d.high + '°' : '–') + '</span>' +
      '<span class="f-lo">' + (d.low != null ? d.low + '°' : '') + '</span>';
    fEl.appendChild(row);
  });
}

function shortDayName(d) {
  if (d.name && /night/i.test(d.name) && d.high == null) return d.name;
  var dt = parseDayKey(d.date);
  var todayKey = localDayKey(new Date());
  if (d.date === todayKey) return 'Today';
  return dt.toLocaleDateString([], { weekday: 'short' });
}

/* ------------------------------------------------------------------ calendar */

function expandEventDays(ev) {
  // returns array of {dayKey, sortTs} this event should appear under
  if (ev.allDay) {
    var start = parseDayKey(ev.start.slice(0, 10));
    var end = parseDayKey(ev.end.slice(0, 10)); // exclusive
    if (end <= start) end = new Date(start.getTime() + 86400000);
    var out = [];
    for (var d = new Date(start); d < end; d = new Date(d.getTime() + 86400000)) {
      out.push({ dayKey: localDayKey(d), sortTs: -1 });
    }
    return out;
  }
  var s = new Date(ev.start);
  return [{ dayKey: localDayKey(s), sortTs: s.getTime() }];
}

function renderCalendar() {
  var data = state.calendar;
  var host = $('agenda');
  if (!data) return;

  // legend
  var legend = $('calLegend');
  legend.innerHTML = '';
  (data.calendars || []).forEach(function (c) {
    var s = document.createElement('span');
    s.className = 'lg';
    s.innerHTML = '<span class="dot" style="background:' + (c.color || '#5aa9ff') +
      '"></span>' + (c.name || '');
    legend.appendChild(s);
  });

  // bucket events by day
  var buckets = {};
  (data.events || []).forEach(function (ev) {
    expandEventDays(ev).forEach(function (slot) {
      (buckets[slot.dayKey] = buckets[slot.dayKey] || []).push({ ev: ev, sortTs: slot.sortTs });
    });
  });

  // Show only Today and Tomorrow (always both, even when empty).
  var now = new Date();
  var todayKey = localDayKey(now);
  var tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  var dayKeys = [todayKey, localDayKey(tomorrow)];

  var shownEvents = 0;
  var maxEvents = 40;
  host.innerHTML = '';

  for (var i = 0; i < dayKeys.length; i++) {
    var key = dayKeys[i];
    var list = (buckets[key] || []).slice().sort(function (a, b) { return a.sortTs - b.sortTs; });

    var day = document.createElement('div');
    day.className = 'day' + (key === todayKey ? ' is-today' : '');

    var dt = parseDayKey(key);
    var label = dayLabel(key, todayKey, dt);
    var head = document.createElement('div');
    head.className = 'day-head';
    head.innerHTML = '<span class="d-label">' + label + '</span>' +
      '<span class="d-date">' + dt.toLocaleDateString([], { month: 'short', day: 'numeric' }) + '</span>';
    day.appendChild(head);

    if (list.length === 0) {
      var e = document.createElement('div');
      e.className = 'empty-day';
      e.textContent = 'Nothing scheduled';
      day.appendChild(e);
    }

    for (var j = 0; j < list.length; j++) {
      if (shownEvents >= maxEvents) {
        var more = document.createElement('div');
        more.className = 'more';
        more.textContent = '+ ' + (countRemaining(dayKeys, i, buckets, j)) + ' more';
        day.appendChild(more);
        break;
      }
      day.appendChild(renderEvent(list[j].ev));
      shownEvents++;
    }

    host.appendChild(day);
  }
}

function countRemaining(dayKeys, fromDayIdx, buckets, fromEventIdx) {
  var n = 0;
  for (var i = fromDayIdx; i < dayKeys.length; i++) {
    var list = buckets[dayKeys[i]] || [];
    n += i === fromDayIdx ? Math.max(0, list.length - fromEventIdx) : list.length;
  }
  return n;
}

function dayLabel(key, todayKey, dt) {
  if (key === todayKey) return 'Today';
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (key === localDayKey(tomorrow)) return 'Tomorrow';
  return dt.toLocaleDateString([], { weekday: 'long' });
}

function renderEvent(ev) {
  var row = document.createElement('div');
  row.className = 'event' + (ev.allDay ? ' all-day' : '');
  row.style.borderLeftColor = ev.color || '#5aa9ff';

  var timeText;
  if (ev.allDay) {
    timeText = 'ALL DAY';
  } else {
    timeText = fmtTime(new Date(ev.start));
  }

  var loc = ev.location
    ? '<div class="e-loc">' + escapeHtml(ev.location) + '</div>'
    : '';
  row.innerHTML =
    '<div class="e-time">' + timeText + '</div>' +
    '<div><div class="e-title">' + escapeHtml(ev.title) + '</div>' + loc + '</div>';
  return row;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
  });
}

/* ------------------------------------------------------------------ countdown */

function stopCountdownRotation() {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
}

function renderCountdownItem(item) {
  var big = item.daysLeft > 0 ? item.daysLeft : item.hoursLeft;
  var unit;
  if (item.daysLeft > 0) {
    unit = item.daysLeft === 1 ? 'day' : 'days';
  } else {
    unit = item.hoursLeft === 1 ? 'hour' : 'hours';
  }
  var targetDate = parseEventStart(item.start);

  var titleEl = $('countdownTitle');
  titleEl.textContent = item.title || 'Countdown';
  titleEl.style.color = item.color || '';

  $('countdown').innerHTML =
    '<div class="cd-num">' + big + '</div>' +
    '<div class="cd-unit">' + unit + '</div>' +
    '<div class="cd-date">' +
    targetDate.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) +
    '</div>';
}

function advanceCountdown() {
  var items = (state.countdown && state.countdown.items) || [];
  if (items.length === 0) return;
  var el = $('countdown');
  el.classList.add('fade-out');
  setTimeout(function () {
    state.countdownIdx = (state.countdownIdx + 1) % items.length;
    renderCountdownItem(items[state.countdownIdx]);
    el.classList.remove('fade-out');
  }, COUNTDOWN_FADE_MS);
}

function renderCountdown() {
  var c = state.countdown;
  var hourlyCard = $('hourlyCard');
  var countdownCard = $('countdownCard');
  var items = (c && c.items) || [];
  if (!c || !c.active || items.length === 0) {
    hourlyCard.hidden = false;
    countdownCard.hidden = true;
    stopCountdownRotation();
    return;
  }
  hourlyCard.hidden = true;
  countdownCard.hidden = false;

  stopCountdownRotation();
  state.countdownIdx = 0;
  renderCountdownItem(items[0]);
  if (items.length > 1) {
    state.countdownTimer = setInterval(advanceCountdown, COUNTDOWN_ROTATE_MS);
  }
}

function loadCountdown() {
  return fetchJSON('/api/countdown')
    .then(function (data) {
      state.countdown = data;
      renderCountdown();
    })
    .catch(function (err) {
      console.warn('countdown fetch failed', err);
      state.countdown = { active: false };
      renderCountdown();
    });
}

/* ------------------------------------------------------------------ cameras */

var CAM_AUTO_CLOSE_MS = 90 * 1000;   // don't leave the overlay burning the LCD
var CAM_POLL_MS = 2000;              // snapshot cadence
var CAM_LIVE_START_MS = 25000;       // give a live stream this long to show a frame
var CAM_LIVE_MAX_MS = 5 * 60 * 1000; // live view cap, then back to the grid

var MSG_TAP_LIVE = 'Last event · tap for live';
var MSG_LIVE_FAILED = 'Live view unavailable — showing last event';

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

function loadCameras() {
  return fetchJSON('/api/cameras')
    .then(function (data) {
      cam.list = (data && data.cameras) || [];
      $('camBtn').hidden = cam.list.length === 0;
    })
    .catch(function (err) { console.warn('cameras fetch failed', err); });
}

function camColsFor(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

function openCam() {
  if (!cam.list.length || cam.open) return;
  cam.open = true;

  var grid = $('camGrid');
  grid.className = '';
  grid.style.setProperty('--cam-cols', camColsFor(cam.list.length));
  grid.innerHTML = '';
  cam.tiles = {};

  cam.list.forEach(function (c) {
    var tile = document.createElement('div');
    tile.className = 'cam-tile';
    tile.setAttribute('data-cam', c.id);

    var video = document.createElement('video');
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
    video.hidden = true;

    var img = document.createElement('img');
    img.alt = ''; // the .cam-tile-label carries the name; keep the broken-img glyph out
    img.hidden = true;

    var label = document.createElement('div');
    label.className = 'cam-tile-label';
    label.textContent = c.name;

    var msg = document.createElement('div');
    msg.className = 'cam-tile-msg';
    msg.hidden = true;

    tile.appendChild(video);
    tile.appendChild(img);
    tile.appendChild(label);
    tile.appendChild(msg);
    tile.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleCamSolo(c.id);
    });
    grid.appendChild(tile);

    cam.tiles[c.id] = {
      video: video, img: img, msgEl: msg,
      hls: null, rtc: null, mode: null, liveTimer: null, maxTimer: null, pollTimer: null,
    };
    startTileSnapshot(c.id);
  });

  $('camOverlay').hidden = false;
  bumpCamAutoClose();
}

function destroyTileHls(t) {
  if (t && t.hls) {
    try { t.hls.destroy(); } catch (e) { /* ignore */ }
    t.hls = null;
  }
}

function stopTilePoll(t) {
  if (!t) return;
  clearInterval(t.pollTimer);
  t.pollTimer = null;
}

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
  t.msgEl.textContent = 'Starting live view…';
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

function wireCameras() {
  $('camBtn').addEventListener('click', openCam);
  $('camClose').addEventListener('click', function (e) { e.stopPropagation(); closeCam(); });
  $('camOverlay').addEventListener('click', function (e) {
    if (e.target === $('camOverlay') || e.target === $('camGrid')) closeCam();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && cam.open) closeCam();
  });
}

/* ------------------------------------------------------------------ status */

function renderStatus() {
  var el = $('status');
  var parts = [];
  var stale = false;

  if (state.weatherAt) {
    var wMin = Math.round((Date.now() - state.weatherAt) / 60000);
    parts.push('wx ' + wMin + 'm');
    if (wMin > 40 || state.weatherFail > 2) stale = true;
  } else {
    parts.push('wx —');
    stale = true;
  }
  if (state.weather && state.weather.currentSource === 'semo') {
    parts.push('SEMO Weather Network');
  }
  if (state.calendarAt) {
    var cMin = Math.round((Date.now() - state.calendarAt) / 60000);
    parts.push('cal ' + cMin + 'm');
    if (cMin > 20 || state.calendarFail > 2) stale = true;
  } else {
    parts.push('cal —');
    stale = true;
  }
  if (state.calendar && state.calendar.errors && state.calendar.errors.length) {
    parts.push(state.calendar.errors.length + ' cal error(s)');
    stale = true;
  }

  el.textContent = parts.join('   ');
  el.className = stale ? 'stale' : 'dim';
}

/* ------------------------------------------------------------------ loops */

function loadWeather() {
  return fetchJSON('/api/weather')
    .then(function (w) {
      state.weather = w;
      state.weatherAt = Date.now();
      state.weatherFail = 0;
      renderWeather();
    })
    .catch(function (err) {
      state.weatherFail++;
      console.warn('weather fetch failed', err);
    })
    .finally(renderStatus);
}

function loadCalendar() {
  return fetchJSON('/api/calendar')
    .then(function (data) {
      state.calendar = data;
      state.calendarAt = Date.now();
      state.calendarFail = 0;
      renderCalendar();
    })
    .catch(function (err) {
      state.calendarFail++;
      console.warn('calendar fetch failed', err);
      var loading = $('agendaLoading');
      if (loading && !state.calendar) loading.textContent = 'Calendar unavailable — retrying…';
    })
    .finally(renderStatus);
}

function start() {
  tickClock();
  setInterval(tickClock, 1000);

  wireCameras();
  loadCameras();

  loadWeather();
  loadCalendar();
  loadCountdown();
  setInterval(loadWeather, WEATHER_MS);
  setInterval(loadCalendar, CAL_MS);
  setInterval(loadCountdown, CAL_MS);
  setInterval(renderStatus, 30000);
  setInterval(renderCalendar, 60000); // keep "Today/Tomorrow" honest across midnight

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { loadWeather(); loadCalendar(); loadCountdown(); }
  });
}

start();
