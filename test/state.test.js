'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withTempStatePath(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-display-state-'));
  const file = path.join(dir, 'state.json');
  const prev = process.env.STATE_PATH;
  process.env.STATE_PATH = file;
  try {
    return fn(file);
  } finally {
    if (prev === undefined) delete process.env.STATE_PATH;
    else process.env.STATE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const state = require('../lib/state');

test('loadState returns defaults when the file does not exist', () => {
  withTempStatePath(() => {
    assert.deepEqual(state.loadState(), { hiddenCalendars: [], countdowns: [] });
  });
});

test('saveState then loadState round-trips hiddenCalendars and countdowns', () => {
  withTempStatePath(() => {
    state.saveState({
      hiddenCalendars: ['Scouts'],
      countdowns: [
        { calendarName: 'Family', uid: 'abc123', title: 'Trivia Night' },
        { calendarName: 'Elizabeth', uid: 'def456', title: 'Softball Round Robin' },
      ],
    });
    assert.deepEqual(state.loadState(), {
      hiddenCalendars: ['Scouts'],
      countdowns: [
        { calendarName: 'Family', uid: 'abc123', title: 'Trivia Night' },
        { calendarName: 'Elizabeth', uid: 'def456', title: 'Softball Round Robin' },
      ],
    });
  });
});

test('loadState returns defaults when the file has invalid JSON', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not valid json');
    assert.deepEqual(state.loadState(), { hiddenCalendars: [], countdowns: [] });
  });
});

test('loadState normalizes a malformed hiddenCalendars field to an empty array', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hiddenCalendars: 'not-an-array', countdowns: [] }));
    assert.deepEqual(state.loadState().hiddenCalendars, []);
  });
});

test('loadState migrates a legacy singular countdown object into a one-item countdowns array', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      hiddenCalendars: [],
      countdown: { calendarName: 'Family', uid: 'abc123', title: 'Trivia Night' },
    }));
    assert.deepEqual(state.loadState().countdowns, [
      { calendarName: 'Family', uid: 'abc123', title: 'Trivia Night' },
    ]);
  });
});

test('loadState migrates a legacy null countdown into an empty countdowns array', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hiddenCalendars: [], countdown: null }));
    assert.deepEqual(state.loadState().countdowns, []);
  });
});

test('loadState prefers a present countdowns array over a legacy countdown field', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      hiddenCalendars: [],
      countdown: { calendarName: 'Old', uid: 'old-uid', title: 'Old Selection' },
      countdowns: [{ calendarName: 'New', uid: 'new-uid', title: 'New Selection' }],
    }));
    assert.deepEqual(state.loadState().countdowns, [
      { calendarName: 'New', uid: 'new-uid', title: 'New Selection' },
    ]);
  });
});
