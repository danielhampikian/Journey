'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/store');
const { createApp } = require('../server/app');

function fakeAi() {
  const calls = [];
  return {
    calls,
    configured: true,
    async chat(messages, opts = {}) {
      calls.push({ messages, opts });
      if (!opts.json) return 'Hello from the coach!';
      const type = messages[0].content.includes('MORNING') ? 'morning' : 'evening';
      return type === 'morning'
        ? { summary: 'You planned your day.', goals: ['Write report', 'Go for a run'], goalUpdates: { weekly: 'Ship the report' } }
        : {
            summary: 'You reflected on your day.',
            outcomes: [
              { goal: 'Write report', status: 'done' },
              { goal: 'Go for a run', status: 'missed' },
            ],
            wins: ['Finished the report'],
            struggles: ['Low energy'],
          };
    },
    async transcribe(buffer, type) {
      return `transcribed ${buffer.length} bytes of ${type}`;
    },
    async speak() {
      return Buffer.from('mp3');
    },
  };
}

async function withServer(fn, ai = fakeAi()) {
  const store = new Store({ file: null });
  const app = createApp({ store, ai });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), res };
  };
  try {
    await fn({ call, store, ai, base });
  } finally {
    server.close();
  }
}

test('full morning + evening flow records summaries, goals and stats', () =>
  withServer(async ({ call, store, ai }) => {
    const date = '2026-10-17';
    const started = await call('POST', '/api/conversations', { type: 'morning', date });
    assert.equal(started.status, 201);
    assert.equal(started.body.messages[0].role, 'assistant');
    const id = started.body.id;

    const reply = await call('POST', `/api/conversations/${id}/messages`, { text: 'I want to write my report and run.' });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.reply, 'Hello from the coach!');
    assert.equal(reply.body.conversation.messages.length, 3);

    const ended = await call('POST', `/api/conversations/${id}/end`);
    assert.equal(ended.status, 200);
    assert.deepEqual(ended.body.goals, ['Write report', 'Go for a run']);
    assert.ok(ended.body.endedAt);
    assert.equal(store.getGoals().weekly.text, 'Ship the report');

    const again = await call('POST', `/api/conversations/${id}/messages`, { text: 'more' });
    assert.equal(again.status, 409);

    const evening = await call('POST', '/api/conversations', { type: 'evening', date });
    const eid = evening.body.id;
    await call('POST', `/api/conversations/${eid}/messages`, { text: 'I wrote the report but skipped the run.' });
    const systemPrompt = ai.calls[ai.calls.length - 1].messages[0].content;
    assert.match(systemPrompt, /EVENING/);
    assert.match(systemPrompt, /- Write report/);
    const evEnded = await call('POST', `/api/conversations/${eid}/end`);
    assert.equal(evEnded.body.outcomes.length, 2);
    assert.deepEqual(evEnded.body.struggles, ['Low energy']);

    const stats = await call('GET', `/api/stats?today=${date}`);
    assert.equal(stats.status, 200);
    assert.equal(stats.body.currentStreak, 1);
    assert.equal(stats.body.daily.at(-1).completion, 0.5);
    assert.deepEqual(stats.body.topStruggles, [{ text: 'low energy', count: 1 }]);

    const list = await call('GET', '/api/conversations');
    assert.equal(list.body.length, 2);
  }));

test('goals can be saved and drive review prompts', () =>
  withServer(async ({ call }) => {
    const initial = await call('GET', '/api/goals');
    assert.equal(initial.body.review[0].level, 'life');
    const saved = await call('PUT', '/api/goals', { life: 'Be healthy', yearly: 'Run a marathon', monthly: 'Run 100km', weekly: 'Run 3x' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.goals.yearly.text, 'Run a marathon');
    assert.deepEqual(saved.body.review, []);
    const bad = await call('PUT', '/api/goals', { life: 42 });
    assert.equal(bad.status, 400);
  }));

test('the system prompt asks the user to define missing goals', () =>
  withServer(async ({ call, ai }) => {
    await call('POST', '/api/conversations', { type: 'morning', date: '2026-10-17' });
    assert.match(ai.calls[0].messages[0].content, /has not defined their life goals/);
  }));

test('input validation', () =>
  withServer(async ({ call }) => {
    assert.equal((await call('POST', '/api/conversations', { type: 'lunch' })).status, 400);
    assert.equal((await call('POST', '/api/conversations', { type: 'morning', date: 'yesterday' })).status, 400);
    assert.equal((await call('GET', '/api/stats?today=nope')).status, 400);
    assert.equal((await call('GET', '/api/conversations/missing')).status, 404);
    const c = await call('POST', '/api/conversations', { type: 'morning' });
    assert.equal((await call('POST', `/api/conversations/${c.body.id}/end`)).status, 400);
    assert.equal((await call('POST', `/api/conversations/${c.body.id}/messages`, { text: '  ' })).status, 400);
    assert.equal((await call('DELETE', `/api/conversations/${c.body.id}`)).status, 204);
  }));

test('returns 503 when OpenAI is not configured', () =>
  withServer(
    async ({ call }) => {
      const res = await call('POST', '/api/conversations', { type: 'morning' });
      assert.equal(res.status, 503);
      assert.equal((await call('GET', '/api/status')).body.aiConfigured, false);
    },
    { ...fakeAi(), configured: false }
  ));

test('audio endpoints proxy transcription and speech', () =>
  withServer(async ({ base, call }) => {
    const res = await fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.from('abcd') });
    assert.deepEqual(await res.json(), { text: 'transcribed 4 bytes of audio/webm' });
    const speech = await call('POST', '/api/speech', { text: 'Hi' });
    assert.equal(speech.res.headers.get('content-type'), 'audio/mpeg');
  }));

test('insights are generated and stored', () =>
  withServer(async ({ call }) => {
    assert.equal((await call('GET', '/api/insights')).body, null);
    const res = await call('POST', '/api/insights', { today: '2026-10-17' });
    assert.equal(res.body.text, 'Hello from the coach!');
    assert.equal((await call('GET', '/api/insights')).body.text, 'Hello from the coach!');
  }));
