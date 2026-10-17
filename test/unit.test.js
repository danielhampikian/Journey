'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStats, addDays } = require('../server/stats');
const { goalsNeedingReview } = require('../server/goals');
const { normalizeSummary, OpenAIClient } = require('../server/ai');

const conv = (type, date, extra = {}) => ({ type, date, startedAt: `${date}T08:00:00Z`, endedAt: `${date}T08:10:00Z`, ...extra });

test('addDays handles month boundaries', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('computeStats calculates completion, streaks and trends', () => {
  const conversations = [
    conv('morning', '2026-10-15', { goals: ['a', 'b'] }),
    conv('evening', '2026-10-15', { outcomes: [{ goal: 'a', status: 'done' }, { goal: 'b', status: 'done' }], struggles: ['Distractions'] }),
    conv('morning', '2026-10-16', { goals: ['a', 'b'] }),
    conv('evening', '2026-10-16', { outcomes: [{ goal: 'a', status: 'partial' }, { goal: 'b', status: 'missed' }], struggles: ['distractions', 'low energy'] }),
    conv('morning', '2026-10-12', { goals: ['x'] }),
    { ...conv('morning', '2026-10-17'), endedAt: null },
  ];
  const stats = computeStats(conversations, '2026-10-17');
  assert.equal(stats.daily.length, 14);
  assert.equal(stats.daily.at(-1).date, '2026-10-17');
  assert.equal(stats.currentStreak, 2); // today not yet completed, so streak counts through yesterday
  assert.equal(stats.longestStreak, 2);
  assert.equal(stats.overallCompletion, 0.63);
  assert.equal(stats.totals.goalsSet, 5);
  assert.equal(stats.totals.done, 2);
  assert.deepEqual(stats.topStruggles[0], { text: 'distractions', count: 2 });
});

test('goalsNeedingReview flags missing and stale goals', () => {
  const now = new Date('2026-10-17T00:00:00Z');
  const goals = {
    life: { text: 'Live well', updatedAt: '2026-09-01T00:00:00Z' },
    yearly: { text: '', updatedAt: null },
    monthly: { text: 'Read', updatedAt: '2026-10-10T00:00:00Z' },
    weekly: { text: 'Gym', updatedAt: '2026-10-01T00:00:00Z' },
  };
  assert.deepEqual(goalsNeedingReview(goals, now), [
    { level: 'yearly', reason: 'missing' },
    { level: 'weekly', reason: 'stale', ageDays: 16 },
  ]);
});

test('normalizeSummary drops malformed model output', () => {
  const result = normalizeSummary('evening', {
    summary: ' ok ',
    outcomes: [{ goal: 'a', status: 'done' }, { goal: 'b', status: 'unknown' }, null],
    wins: ['w', 3],
    goalUpdates: { weekly: ' new ', bogus: 'x' },
  });
  assert.equal(result.summary, 'ok');
  assert.deepEqual(result.outcomes, [{ goal: 'a', status: 'done' }]);
  assert.deepEqual(result.wins, ['w']);
  assert.deepEqual(result.goalUpdates, { weekly: 'new' });
  assert.deepEqual(normalizeSummary('morning', null).goals, []);
});

test('OpenAIClient sends authenticated chat requests', async () => {
  let captured;
  const client = new OpenAIClient({
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"summary":"hi"}' } }] }) };
    },
  });
  const result = await client.chat([{ role: 'user', content: 'x' }], { json: true });
  assert.deepEqual(result, { summary: 'hi' });
  assert.match(captured.url, /\/chat\/completions$/);
  assert.equal(captured.init.headers.Authorization, 'Bearer ' + 'test-key');
  assert.equal(JSON.parse(captured.init.body).response_format.type, 'json_object');
});
