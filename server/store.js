'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GOAL_LEVELS = ['life', 'yearly', 'monthly', 'weekly'];

function emptyData() {
  const goals = {};
  for (const level of GOAL_LEVELS) goals[level] = { text: '', updatedAt: null };
  return { goals, conversations: [], insights: null };
}

/**
 * Very small JSON-file backed store. All data lives in memory and is
 * persisted atomically (write to temp file + rename) on every change.
 * Pass `file: null` for a purely in-memory store (used by tests).
 */
class Store {
  constructor({ file } = {}) {
    this.file = file || null;
    this.data = emptyData();
    if (this.file && fs.existsSync(this.file)) {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...emptyData(), ...loaded, goals: { ...emptyData().goals, ...(loaded.goals || {}) } };
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // ---- Goals -------------------------------------------------------------
  getGoals() {
    return this.data.goals;
  }

  updateGoals(updates, now = new Date()) {
    for (const level of GOAL_LEVELS) {
      if (typeof updates[level] === 'string' && updates[level] !== this.data.goals[level].text) {
        this.data.goals[level] = { text: updates[level].trim(), updatedAt: now.toISOString() };
      }
    }
    this.save();
    return this.data.goals;
  }

  // ---- Conversations -----------------------------------------------------
  listConversations() {
    return [...this.data.conversations].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getConversation(id) {
    return this.data.conversations.find((c) => c.id === id) || null;
  }

  createConversation({ type, date }, now = new Date()) {
    const conversation = {
      id: crypto.randomUUID(),
      type,
      date,
      startedAt: now.toISOString(),
      endedAt: null,
      messages: [],
      summary: null,
      goals: [],
      outcomes: [],
      wins: [],
      struggles: [],
    };
    this.data.conversations.push(conversation);
    this.save();
    return conversation;
  }

  addMessage(id, role, content, now = new Date()) {
    const conversation = this.getConversation(id);
    if (!conversation) return null;
    conversation.messages.push({ role, content, at: now.toISOString() });
    this.save();
    return conversation;
  }

  updateConversation(id, fields) {
    const conversation = this.getConversation(id);
    if (!conversation) return null;
    Object.assign(conversation, fields);
    this.save();
    return conversation;
  }

  deleteConversation(id) {
    const before = this.data.conversations.length;
    this.data.conversations = this.data.conversations.filter((c) => c.id !== id);
    const removed = this.data.conversations.length !== before;
    if (removed) this.save();
    return removed;
  }

  /** Most recent completed morning conversation for the given day. */
  getMorningFor(date) {
    return (
      this.listConversations().find((c) => c.type === 'morning' && c.date === date && c.endedAt) || null
    );
  }

  // ---- Insights ----------------------------------------------------------
  getInsights() {
    return this.data.insights;
  }

  setInsights(text, now = new Date()) {
    this.data.insights = { text, generatedAt: now.toISOString() };
    this.save();
    return this.data.insights;
  }
}

module.exports = { Store, GOAL_LEVELS };
