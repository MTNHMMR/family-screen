'use strict';

function $(id) { return document.getElementById(id); }

function parseEventStart(startStr) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startStr);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(startStr);
}

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

var adminState = { hiddenCalendars: [], countdowns: [], calendars: [] };

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
  return adminState.countdowns.some(function (c) {
    return c.calendarName === ev.calendar && c.uid === ev.uid;
  });
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
      var row = document.createElement('label');
      row.className = 'ev-row' + (isSelected(ev) ? ' selected' : '');

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isSelected(ev);
      cb.addEventListener('change', function () { toggleCountdown(ev, cb.checked); });

      var title = document.createElement('span');
      title.className = 'ev-title';
      title.textContent = ev.title;

      var date = document.createElement('span');
      date.className = 'ev-date';
      date.textContent = parseEventStart(ev.start).toLocaleDateString([], {
        month: 'short', day: 'numeric', year: 'numeric',
      });

      row.appendChild(cb);
      row.appendChild(title);
      row.appendChild(date);
      group.appendChild(row);
    });

    host.appendChild(group);
  });
}

function toggleCountdown(ev, selected) {
  var items = adminState.countdowns.filter(function (c) {
    return !(c.calendarName === ev.calendar && c.uid === ev.uid);
  });
  if (selected) {
    items.push({ calendarName: ev.calendar, uid: ev.uid, title: ev.title });
  }
  return fetchJSON('/api/admin/countdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: items }),
  }).then(function (data) {
    adminState.countdowns = data.countdowns;
    flash(selected ? 'Countdown added' : 'Countdown removed');
    loadEvents();
  }).catch(function (err) {
    console.error('save countdown failed', err);
    flash('Save failed');
    loadEvents(); // revert the checkbox to the last known-good state
  });
}

function clearCountdown() {
  return fetchJSON('/api/admin/countdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clear: true }),
  }).then(function (data) {
    adminState.countdowns = data.countdowns;
    flash('All countdowns cleared');
    loadEvents();
  }).catch(function (err) {
    console.error('clear countdowns failed', err);
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
      adminState.countdowns = data.countdowns || [];
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
