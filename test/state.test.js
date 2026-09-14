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
    assert.deepEqual(state.loadState(), { hiddenCalendars: [], countdown: null });
  });
});

test('saveState then loadState round-trips hiddenCalendars and countdown', () => {
  withTempStatePath(() => {
    state.saveState({
      hiddenCalendars: ['Scouts'],
      countdown: { calendarName: 'Family', uid: 'abc123', title: 'Trivia Night' },
    });
    assert.deepEqual(state.loadState(), {
      hiddenCalendars: ['Scouts'],
      countdown: { calendarName: 'Family', uid: 'abc123', title: 'Trivia Night' },
    });
  });
});

test('loadState returns defaults when the file has invalid JSON', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not valid json');
    assert.deepEqual(state.loadState(), { hiddenCalendars: [], countdown: null });
  });
});

test('loadState normalizes a malformed hiddenCalendars field to an empty array', () => {
  withTempStatePath((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hiddenCalendars: 'not-an-array', countdown: null }));
    assert.deepEqual(state.loadState().hiddenCalendars, []);
  });
});
