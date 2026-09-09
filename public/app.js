'use strict';

var WEATHER_MS = 10 * 60 * 1000;
var CAL_MS = 5 * 60 * 1000;
var FETCH_TIMEOUT_MS = 20000;
var RELOAD_HOUR = 3; // full page reload window, local time
var RELOAD_MIN = 30;

var state = {
  weather: null,
  weatherAt: 0,
  weatherFail: 0,
  calendar: null,
  calendarAt: 0,
  calendarFail: 0,
  bootAt: Date.now(),
};

/* ------------------------------------------------------------------ utils */

function $(id) { return document.getElementById(id); }

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

/* ------------------------------------------------------------------ cameras */

var CAM_AUTO_CLOSE_MS = 90 * 1000; // don't leave live feeds burning the LCD / Ring quota
var CAM_POLL_MS = 2000;            // snapshot-fallback cadence
var CAM_LIVE_START_MS = 25000;     // give the HLS stream this long to show a frame

var cam = {
  list: [],
  open: false,
  closeTimer: null,
  tiles: {}, // id -> { video, img, msgEl, hls, mode, liveTimer, pollTimer }
};

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
      hls: null, mode: null, liveTimer: null, pollTimer: null,
    };
    startTileLive(c.id);
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

// Live view: the real HLS stream, same one HA's own UI uses.
function startTileLive(id) {
  var t = cam.tiles[id];
  if (!t) return;
  t.mode = 'live';
  stopTilePoll(t);
  destroyTileHls(t);

  t.img.hidden = true;
  t.video.hidden = false;
  t.msgEl.textContent = 'Starting live view…';
  t.msgEl.hidden = false;

  var src = '/api/cam/' + encodeURIComponent(id) + '/hls?t=' + Date.now();

  // Ring live view is slow to spin up; give it a while, then show the snapshot.
  clearTimeout(t.liveTimer);
  t.liveTimer = setTimeout(function () {
    console.warn('camera "' + id + '" live view slow to start; using last snapshot');
    startTileSnapshot(id);
  }, CAM_LIVE_START_MS);

  t.video.onplaying = function () {
    clearTimeout(t.liveTimer);
    t.msgEl.hidden = true;
  };

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
      console.warn('camera "' + id + '" hls fatal:', data.type, data.details);
      startTileSnapshot(id);
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
      var p = t.video.play();
      if (p && p.catch) p.catch(function () {});
    });
    hls.loadSource(src);
    hls.attachMedia(t.video);
  } else if (t.video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari / iOS WebView -- native HLS
    t.video.onerror = function () { startTileSnapshot(id); };
    t.video.src = src;
    var p2 = t.video.play();
    if (p2 && p2.catch) p2.catch(function () {});
  } else {
    startTileSnapshot(id); // no HLS support at all
  }
}

// Fallback: poll the still image (for Ring, the last event's frame).
function startTileSnapshot(id) {
  var t = cam.tiles[id];
  if (!t) return;
  t.mode = 'snapshot';
  clearTimeout(t.liveTimer);
  destroyTileHls(t);

  try { t.video.pause(); } catch (e) { /* ignore */ }
  t.video.onplaying = null;
  t.video.onerror = null;
  t.video.removeAttribute('src');
  t.video.hidden = true;
  t.img.hidden = false;

  t.msgEl.textContent = 'Live view unavailable — showing last event';
  t.msgEl.hidden = false;
  t.img.onload = function () { t.msgEl.hidden = true; };
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
  var grid = $('camGrid');
  var current = grid.querySelector('.cam-tile.solo');
  var alreadySolo = current && current.getAttribute('data-cam') === id;
  var tiles = grid.querySelectorAll('.cam-tile');
  for (var i = 0; i < tiles.length; i++) tiles[i].classList.remove('solo');
  if (alreadySolo) {
    grid.classList.remove('solo');
  } else {
    grid.classList.add('solo');
    var el = grid.querySelector('.cam-tile[data-cam="' + id + '"]');
    if (el) el.classList.add('solo');
  }
  bumpCamAutoClose();
}

function bumpCamAutoClose() {
  if (!cam.open) return;
  clearTimeout(cam.closeTimer);
  cam.closeTimer = setTimeout(closeCam, CAM_AUTO_CLOSE_MS);
}

function closeCam() {
  cam.open = false;
  clearTimeout(cam.closeTimer);
  cam.closeTimer = null;
  Object.keys(cam.tiles).forEach(function (id) {
    var t = cam.tiles[id];
    clearTimeout(t.liveTimer);
    stopTilePoll(t);
    destroyTileHls(t);
    try { t.video.pause(); } catch (e) { /* ignore */ }
    t.video.onplaying = null;
    t.video.onerror = null;
    t.video.removeAttribute('src');
    if (t.video.load) t.video.load(); // fully drop the stream
    t.img.onerror = null;
    t.img.onload = null;
    t.img.removeAttribute('src');
  });
  cam.tiles = {};
  $('camGrid').innerHTML = '';
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
  setInterval(loadWeather, WEATHER_MS);
  setInterval(loadCalendar, CAL_MS);
  setInterval(renderStatus, 30000);
  setInterval(renderCalendar, 60000); // keep "Today/Tomorrow" honest across midnight

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { loadWeather(); loadCalendar(); }
  });
}

start();
