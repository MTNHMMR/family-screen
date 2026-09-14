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
