'use strict';

const path = require('path');
const express = require('express');
const { GOAL_LEVELS } = require('./store');
const { goalsNeedingReview } = require('./goals');
const { computeStats } = require('./stats');
const { buildSystemPrompt, buildSummaryPrompt, buildInsightsMessages, normalizeSummary } = require('./ai');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = ['morning', 'evening'];
const MAX_MESSAGE_LENGTH = 4000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function localDate(now = new Date()) {
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

/** Validates a client supplied YYYY-MM-DD date, falling back to the server's local date. */
function resolveDate(value) {
  if (value === undefined || value === null || value === '') return localDate();
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw httpError(400, 'date must be in YYYY-MM-DD format');
  }
  return value;
}

/**
 * Creates the Express application.
 * @param {{store: import('./store').Store, ai: import('./ai').OpenAIClient, now?: () => Date}} deps
 */
function createApp({ store, ai, now = () => new Date() }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const requireConversation = (req) => {
    const conversation = store.getConversation(req.params.id);
    if (!conversation) throw httpError(404, 'Conversation not found');
    return conversation;
  };

  const contextFor = (conversation) => {
    const goals = store.getGoals();
    return {
      type: conversation.type,
      date: conversation.date,
      goals,
      review: goalsNeedingReview(goals, now()),
      morning: conversation.type === 'evening' ? store.getMorningFor(conversation.date) : null,
      stats: computeStats(store.listConversations(), conversation.date),
    };
  };

  const chatMessages = (conversation) => [
    { role: 'system', content: buildSystemPrompt(contextFor(conversation)) },
    ...conversation.messages.map(({ role, content }) => ({ role, content })),
  ];

  app.get('/api/status', (req, res) => {
    res.json({ aiConfigured: ai.configured });
  });

  // ---- Goals -------------------------------------------------------------
  app.get('/api/goals', (req, res) => {
    const goals = store.getGoals();
    res.json({ goals, review: goalsNeedingReview(goals, now()) });
  });

  app.put('/api/goals', (req, res) => {
    const body = req.body || {};
    const updates = {};
    for (const level of GOAL_LEVELS) {
      if (body[level] === undefined) continue;
      if (typeof body[level] !== 'string' || body[level].length > MAX_MESSAGE_LENGTH) {
        throw httpError(400, `${level} must be a string of at most ${MAX_MESSAGE_LENGTH} characters`);
      }
      updates[level] = body[level];
    }
    const goals = store.updateGoals(updates, now());
    res.json({ goals, review: goalsNeedingReview(goals, now()) });
  });

  // ---- Conversations -----------------------------------------------------
  app.get('/api/conversations', (req, res) => {
    res.json(store.listConversations());
  });

  app.get('/api/conversations/:id', (req, res) => {
    res.json(requireConversation(req));
  });

  app.post('/api/conversations', async (req, res) => {
    const body = req.body || {};
    if (!TYPES.includes(body.type)) throw httpError(400, 'type must be "morning" or "evening"');
    const date = resolveDate(body.date);
    if (!ai.configured) throw httpError(503, 'OPENAI_API_KEY is not configured on the server.');

    const conversation = store.createConversation({ type: body.type, date }, now());
    try {
      const opening = await ai.chat([
        ...chatMessages(conversation),
        { role: 'user', content: `(The user just opened their ${body.type} check-in. Greet them and start the conversation.)` },
      ]);
      store.addMessage(conversation.id, 'assistant', opening, now());
    } catch (err) {
      store.deleteConversation(conversation.id);
      throw err;
    }
    res.status(201).json(store.getConversation(conversation.id));
  });

  app.post('/api/conversations/:id/messages', async (req, res) => {
    const conversation = requireConversation(req);
    if (conversation.endedAt) throw httpError(409, 'Conversation has already ended');
    const text = typeof (req.body || {}).text === 'string' ? req.body.text.trim() : '';
    if (!text) throw httpError(400, 'text is required');
    if (text.length > MAX_MESSAGE_LENGTH) throw httpError(400, `text must be at most ${MAX_MESSAGE_LENGTH} characters`);

    store.addMessage(conversation.id, 'user', text, now());
    const reply = await ai.chat(chatMessages(conversation));
    store.addMessage(conversation.id, 'assistant', reply, now());
    res.json({ reply, conversation: store.getConversation(conversation.id) });
  });

  app.post('/api/conversations/:id/end', async (req, res) => {
    const conversation = requireConversation(req);
    if (conversation.endedAt) throw httpError(409, 'Conversation has already ended');
    if (!conversation.messages.some((m) => m.role === 'user')) {
      throw httpError(400, 'Say something before ending the conversation');
    }
    const morning = conversation.type === 'evening' ? store.getMorningFor(conversation.date) : null;
    const raw = await ai.chat(
      [...chatMessages(conversation), { role: 'user', content: buildSummaryPrompt(conversation.type, morning) }],
      { json: true }
    );
    const { goalUpdates, ...summary } = normalizeSummary(conversation.type, raw);
    if (Object.keys(goalUpdates).length) store.updateGoals(goalUpdates, now());
    const updated = store.updateConversation(conversation.id, {
      ...summary,
      goalUpdates,
      endedAt: now().toISOString(),
    });
    res.json(updated);
  });

  app.delete('/api/conversations/:id', (req, res) => {
    requireConversation(req);
    store.deleteConversation(req.params.id);
    res.status(204).end();
  });

  // ---- Stats & insights --------------------------------------------------
  app.get('/api/stats', (req, res) => {
    const today = resolveDate(req.query.today);
    const goals = store.getGoals();
    res.json({
      ...computeStats(store.listConversations(), today),
      review: goalsNeedingReview(goals, now()),
    });
  });

  app.get('/api/insights', (req, res) => {
    res.json(store.getInsights());
  });

  app.post('/api/insights', async (req, res) => {
    const today = resolveDate((req.body || {}).today);
    const conversations = store.listConversations();
    const text = await ai.chat(
      buildInsightsMessages({ goals: store.getGoals(), stats: computeStats(conversations, today), conversations })
    );
    res.json(store.setInsights(text, now()));
  });

  // ---- Audio (speech-to-text & text-to-speech) ----------------------------
  app.post('/api/transcribe', express.raw({ type: ['audio/*', 'video/webm'], limit: '25mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, 'Audio body is required');
    const text = await ai.transcribe(req.body, req.get('content-type'));
    res.json({ text });
  });

  app.post('/api/speech', async (req, res) => {
    const text = typeof (req.body || {}).text === 'string' ? req.body.text.trim() : '';
    if (!text) throw httpError(400, 'text is required');
    if (text.length > MAX_MESSAGE_LENGTH) throw httpError(400, `text must be at most ${MAX_MESSAGE_LENGTH} characters`);
    const audio = await ai.speak(text);
    res.type('audio/mpeg').send(audio);
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (!err.status && !err.statusCode) console.error(err);
    res.status(status).json({ error: status >= 500 && !err.status ? 'Internal server error' : err.message });
  });

  return app;
}

module.exports = { createApp, localDate };
