'use strict';

function $(id) { return document.getElementById(id); }

function fetchJSON(url, opts) {
  return fetch(url, opts).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function flash(msg) {
  var el = $('flash');
  el.textContent = msg;
  setTimeout(function () {
    if (el.textContent === msg) el.textContent = '';
  }, 2000);
}

var adminState = { hiddenCalendars: [], countdown: null, calendars: [] };

function renderCalendars() {
  var host = $('calendarList');
  host.innerHTML = '';
  adminState.calendars.forEach(function (c) {
    var row = document.createElement('label');
    row.className = 'cal-row';

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = adminState.hiddenCalendars.indexOf(c.name) === -1;
    cb.addEventListener('change', function () { toggleCalendar(c.name, cb.checked); });

    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = c.color || '#5aa9ff';

    var label = document.createElement('span');
    label.textContent = c.name;

    row.appendChild(cb);
    row.appendChild(dot);
    row.appendChild(label);
    host.appendChild(row);
  });
}

function toggleCalendar(name, shown) {
  var hidden = adminState.hiddenCalendars.filter(function (n) { return n !== name; });
  if (!shown) hidden.push(name);
  return fetchJSON('/api/admin/calendars', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden: hidden }),
  }).then(function (data) {
    adminState.hiddenCalendars = data.hiddenCalendars;
    flash('Saved');
  }).catch(function (err) {
    console.error('save calendars failed', err);
    flash('Save failed');
    renderCalendars(); // revert the checkbox to the last known-good state
  });
}

function isSelected(ev) {
  var c = adminState.countdown;
  return !!c && c.calendarName === ev.calendar && c.uid === ev.uid;
}

function renderEvents(series) {
  var host = $('eventList');
  host.innerHTML = '';
  if (!series.length) {
    host.textContent = 'No upcoming events found.';
    return;
  }
  var groups = {};
  var order = [];
  series.forEach(function (ev) {
    if (!groups[ev.calendar]) {
      groups[ev.calendar] = [];
      order.push(ev.calendar);
    }
    groups[ev.calendar].push(ev);
  });
  order.forEach(function (calName) {
    var group = document.createElement('div');
    group.className = 'ev-group';

    var h3 = document.createElement('h3');
    h3.textContent = calName;
    group.appendChild(h3);

    groups[calName].forEach(function (ev) {
      var row = document.createElement('div');
      row.className = 'ev-row' + (isSelected(ev) ? ' selected' : '');

      var title = document.createElement('span');
      title.className = 'ev-title';
      title.textContent = ev.title;

      var date = document.createElement('span');
      date.className = 'ev-date';
      date.textContent = new Date(ev.start).toLocaleDateString([], {
        month: 'short', day: 'numeric', year: 'numeric',
      });

      row.appendChild(title);
      row.appendChild(date);
      row.addEventListener('click', function () { selectCountdown(ev); });
      group.appendChild(row);
    });

    host.appendChild(group);
  });
}

function selectCountdown(ev) {
  return fetchJSON('/api/admin/countdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendarName: ev.calendar, uid: ev.uid, title: ev.title }),
  }).then(function (data) {
    adminState.countdown = data.countdown;
    flash('Countdown set');
    loadEvents();
  }).catch(function (err) {
    console.error('set countdown failed', err);
    flash('Save failed');
  });
}

function clearCountdown() {
  return fetchJSON('/api/admin/countdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clear: true }),
  }).then(function (data) {
    adminState.countdown = data.countdown;
    flash('Countdown cleared');
    loadEvents();
  }).catch(function (err) {
    console.error('clear countdown failed', err);
    flash('Save failed');
  });
}

function loadEvents() {
  return fetchJSON('/api/admin/events?days=365')
    .then(function (data) { renderEvents(data.series || []); })
    .catch(function (err) {
      console.error('events fetch failed', err);
      $('eventList').textContent = 'Failed to load events.';
    });
}

function start() {
  fetchJSON('/api/admin/state')
    .then(function (data) {
      adminState.hiddenCalendars = data.hiddenCalendars || [];
      adminState.countdown = data.countdown || null;
      adminState.calendars = data.calendars || [];
      renderCalendars();
      return loadEvents();
    })
    .catch(function (err) {
      console.error('admin state fetch failed', err);
      $('calendarList').textContent = 'Failed to load.';
    });

  $('clearBtn').addEventListener('click', clearCountdown);
}

start();
