'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { filterHidden, pickNextOccurrence, dedupeToSeries, computeCountdown } = require('../lib/calendar');

test('filterHidden removes events and legend entries for hidden calendar names', () => {
  const data = {
    updated: '2026-09-13T00:00:00.000Z',
    days: 3,
    calendars: [
      { name: 'Family', color: '#111' },
      { name: 'Scouts', color: '#222' },
    ],
    events: [
      { uid: '1', title: 'Dinner', calendar: 'Family', start: '2026-09-14T00:00:00.000Z' },
      { uid: '2', title: 'Meeting', calendar: 'Scouts', start: '2026-09-14T01:00:00.000Z' },
    ],
    errors: [],
  };
  const result = filterHidden(data, ['Scouts']);
  assert.deepEqual(result.calendars, [{ name: 'Family', color: '#111' }]);
  assert.deepEqual(result.events.map((e) => e.uid), ['1']);
});

test('filterHidden does not mutate its input data object', () => {
  const data = {
    updated: '2026-09-13T00:00:00.000Z',
    days: 3,
    calendars: [
      { name: 'Family', color: '#111' },
      { name: 'Scouts', color: '#222' },
    ],
    events: [
      { uid: '1', title: 'Dinner', calendar: 'Family', start: '2026-09-14T00:00:00.000Z' },
      { uid: '2', title: 'Meeting', calendar: 'Scouts', start: '2026-09-14T01:00:00.000Z' },
    ],
    errors: [],
  };
  const originalClone = JSON.parse(JSON.stringify(data));
  filterHidden(data, ['Scouts']);
  assert.deepEqual(data, originalClone);
});

test('filterHidden returns an equivalent object when nothing is hidden', () => {
  const data = { calendars: [{ name: 'Family' }], events: [{ uid: '1', calendar: 'Family' }] };
  assert.deepEqual(filterHidden(data, []), data);
});

test('pickNextOccurrence returns the earliest future match for the given series', () => {
  const now = new Date('2026-09-13T00:00:00.000Z').getTime();
  const events = [
    { uid: 'trivia', calendar: 'Scouts', start: '2025-11-14T19:00:00.000Z', title: 'Trivia Night (past)' },
    { uid: 'trivia', calendar: 'Scouts', start: '2026-11-14T19:00:00.000Z', title: 'Trivia Night' },
    { uid: 'other', calendar: 'Scouts', start: '2026-10-01T00:00:00.000Z', title: 'Other event' },
  ];
  const result = pickNextOccurrence(events, 'Scouts', 'trivia', now);
  assert.equal(result.start, '2026-11-14T19:00:00.000Z');
});

test('pickNextOccurrence returns null when there is no future match', () => {
  const now = new Date('2026-09-13T00:00:00.000Z').getTime();
  const events = [{ uid: 'trivia', calendar: 'Scouts', start: '2025-11-14T19:00:00.000Z' }];
  assert.equal(pickNextOccurrence(events, 'Scouts', 'trivia', now), null);
});

test('pickNextOccurrence treats a bare YYYY-MM-DD start as local midnight, not UTC midnight', () => {
  // An all-day event on 2026-11-14 parsed as UTC would be 2026-11-13 18:00 in America/Chicago (UTC-6).
  // At a "now" of 2026-11-13T19:00:00-06:00 (i.e. after that wrong UTC-interpreted instant but
  // before the correct local midnight), the event must still count as upcoming.
  const wrongInterpretation = new Date('2026-11-14T00:00:00.000Z').getTime(); // what UTC parsing would give
  const now = wrongInterpretation + 60 * 60 * 1000; // one hour after the wrong (too-early) instant
  const events = [{ uid: 'campout', calendar: 'Scouts', start: '2026-11-14', title: 'Fall Campout' }];
  const result = pickNextOccurrence(events, 'Scouts', 'campout', now);
  assert.equal(result, events[0]);
});

test('dedupeToSeries keeps one earliest row per calendar+uid pair, sorted by start', () => {
  const events = [
    { uid: 'weekly', calendar: 'Scouts', start: '2026-09-22T00:00:00.000Z', title: 'Troop Meeting' },
    { uid: 'weekly', calendar: 'Scouts', start: '2026-09-15T00:00:00.000Z', title: 'Troop Meeting' },
    { uid: 'trivia', calendar: 'Scouts', start: '2026-11-14T19:00:00.000Z', title: 'Trivia Night' },
  ];
  const result = dedupeToSeries(events);
  assert.equal(result.length, 2);
  assert.equal(result[0].start, '2026-09-15T00:00:00.000Z');
  assert.equal(result[1].title, 'Trivia Night');
});

test('computeCountdown returns whole days and remaining hours until start', () => {
  const now = new Date('2026-09-13T00:00:00.000Z').getTime();
  const start = new Date('2026-09-15T03:00:00.000Z').toISOString();
  assert.deepEqual(computeCountdown(start, now), { daysLeft: 2, hoursLeft: 3 });
});

test('computeCountdown clamps a past start to zero', () => {
  const now = new Date('2026-09-13T00:00:00.000Z').getTime();
  const start = new Date('2026-09-01T00:00:00.000Z').toISOString();
  assert.deepEqual(computeCountdown(start, now), { daysLeft: 0, hoursLeft: 0 });
});

test('computeCountdown treats a bare YYYY-MM-DD start as local midnight, not UTC midnight', () => {
  const wrongInterpretation = new Date('2026-11-14T00:00:00.000Z').getTime();
  const now = wrongInterpretation + 60 * 60 * 1000;
  const result = computeCountdown('2026-11-14', now);
  // Local midnight is later than the UTC-midnight instant, so there must still be time left,
  // not { daysLeft: 0, hoursLeft: 0 } (which is what the UTC-parsing bug would produce here).
  assert.ok(result.daysLeft > 0 || result.hoursLeft > 0);
});
