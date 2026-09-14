'use strict';

const IcalExpander = require('ical-expander');
const { makeCache } = require('./cache');

const cache = makeCache();

async function fetchCalendar(cal, start, end) {
  const res = await fetch(cal.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const ics = await res.text();

  const expander = new IcalExpander({ ics, maxIterations: 5000 });
  const { events, occurrences } = expander.between(start, end);

  const out = [];
  for (const ev of events) {
    out.push(normalize(ev, ev.startDate, ev.endDate, cal));
  }
  for (const oc of occurrences) {
    out.push(normalize(oc.item, oc.startDate, oc.endDate, cal));
  }
  return out;
}

function normalize(ev, start, end, cal) {
  const allDay = !!start.isDate;
  return {
    uid: ev.uid || `${cal.name}:${start.toString()}:${ev.summary || ''}`,
    title: (ev.summary || '(no title)').trim(),
    location: (ev.location || '').trim(),
    allDay,
    // All-day: keep the plain YYYY-MM-DD so the browser groups it by local
    // calendar date without any timezone shifting. Timed: emit a real instant.
    start: allDay ? start.toString() : start.toJSDate().toISOString(),
    end: allDay ? end.toString() : end.toJSDate().toISOString(),
    calendar: cal.name || 'Calendar',
    color: cal.color || '#4aa3ff',
  };
}

function filterHidden(data, hidden) {
  const hiddenSet = new Set(hidden || []);
  if (hiddenSet.size === 0) return data;
  return {
    ...data,
    calendars: data.calendars.filter((c) => !hiddenSet.has(c.name)),
    events: data.events.filter((e) => !hiddenSet.has(e.calendar)),
  };
}

function pickNextOccurrence(events, calendarName, uid, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  const matches = events
    .filter((e) => e.calendar === calendarName && e.uid === uid)
    .filter((e) => new Date(e.start).getTime() >= now)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return matches[0] || null;
}

function dedupeToSeries(events) {
  const seen = new Map();
  for (const e of events) {
    const key = `${e.calendar}::${e.uid}`;
    const existing = seen.get(key);
    if (!existing || e.start < existing.start) seen.set(key, e);
  }
  return Array.from(seen.values()).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

function computeCountdown(startIso, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  const ms = Math.max(0, new Date(startIso).getTime() - now);
  return {
    daysLeft: Math.floor(ms / 86400000),
    hoursLeft: Math.floor((ms % 86400000) / 3600000),
  };
}

async function getCalendar(config) {
  const cals = Array.isArray(config.calendars) ? config.calendars : [];
  const days = config.calendarDays || 10;
  const ttl = (config.refresh && config.refresh.calendarMs) || 5 * 60 * 1000;

  return cache.get('calendar', ttl, async () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);

    const results = await Promise.allSettled(
      cals.map((c) => fetchCalendar(c, start, end))
    );

    const events = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        events.push(...r.value);
      } else {
        const msg = (r.reason && r.reason.message) || String(r.reason);
        console.warn(`calendar "${cals[i].name || i}" failed: ${msg}`);
        errors.push({ calendar: cals[i].name || String(i), error: msg });
      }
    });

    events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    return {
      updated: new Date().toISOString(),
      days,
      calendars: cals.map((c) => ({ name: c.name, color: c.color })),
      events,
      errors,
    };
  });
}

module.exports = { getCalendar, filterHidden, pickNextOccurrence, dedupeToSeries, computeCountdown };
