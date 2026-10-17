'use strict';

const { GOAL_LEVELS } = require('./store');

const LEVEL_LABELS = {
  life: 'Life goals',
  yearly: 'Yearly goals',
  monthly: 'Monthly goals',
  weekly: 'Weekly goals',
};

function formatGoals(goals) {
  return GOAL_LEVELS.map((level) => `${LEVEL_LABELS[level]}: ${goals[level] && goals[level].text ? goals[level].text : '(not defined yet)'}`).join('\n');
}

function formatStats(stats) {
  if (!stats) return 'No statistics yet.';
  const pct = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}%`);
  return [
    `Current check-in streak: ${stats.currentStreak} day(s)`,
    `Goal completion (last 7 days): ${pct(stats.last7Completion)}`,
    `Goal completion (all time): ${pct(stats.overallCompletion)}`,
    stats.topStruggles.length ? `Recurring struggles: ${stats.topStruggles.map((s) => `${s.text} (${s.count}x)`).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Builds the system prompt for a morning or evening check-in.
 */
function buildSystemPrompt({ type, date, goals, review = [], morning = null, stats = null }) {
  const lines = [
    'You are Journey, a warm, encouraging and practical personal goal coach having a spoken conversation with the user.',
    'Keep every reply short (1-3 sentences) and conversational because it will be read aloud. Ask one question at a time.',
    `Today is ${date}.`,
    '',
    "The user's goal hierarchy:",
    formatGoals(goals),
    '',
    'Recent progress:',
    formatStats(stats),
    '',
  ];

  if (type === 'morning') {
    lines.push(
      'This is the MORNING check-in. Help the user decide on 1-5 concrete, achievable goals for today that move them toward their weekly, monthly, yearly and life goals.',
      'Encourage specific, measurable goals and gently challenge vague or overloaded plans. When the plan is clear, recap the goals and wish them a great day.'
    );
  } else {
    lines.push('This is the EVENING check-in. Review the day with the user: what they accomplished, what they struggled with, and what they learned.');
    if (morning && morning.goals && morning.goals.length) {
      lines.push(`This morning the user set these goals:\n${morning.goals.map((g) => `- ${g}`).join('\n')}`);
      lines.push('Go through these goals and find out whether each was done, partially done or missed, and why.');
    } else {
      lines.push('The user did not complete a morning check-in today, so ask what they set out to do.');
    }
    lines.push('Celebrate wins, normalise setbacks, and end with one small suggestion for tomorrow.');
  }

  if (review.length) {
    const first = review[0];
    const label = LEVEL_LABELS[first.level].toLowerCase();
    lines.push(
      '',
      first.reason === 'missing'
        ? `The user has not defined their ${label}. At a natural point in this conversation, briefly invite them to define them so daily goals can serve a bigger purpose.`
        : `The user's ${label} have not been reviewed in ${first.ageDays} days. At a natural point, briefly ask whether they still fit or need refining.`,
      'Only bring up this one goal level, and do not let it take over the conversation.'
    );
  }

  return lines.join('\n');
}

function buildSummaryPrompt(type, morning) {
  const shared =
    '"summary": a 2-4 sentence summary of the conversation written in the second person ("You ..."), ' +
    '"goalUpdates": an object with any of the keys "life", "yearly", "monthly", "weekly" ONLY if the user explicitly defined or refined that level of goals during the conversation (value is the full new text for that level), otherwise {}';
  if (type === 'morning') {
    return `Summarise the morning check-in above. Respond with JSON with keys: ${shared}, "goals": an array of short strings, one per concrete goal the user committed to for today.`;
  }
  const goalList = morning && morning.goals && morning.goals.length ? ` The goals set this morning were: ${JSON.stringify(morning.goals)}.` : '';
  return (
    `Summarise the evening check-in above.${goalList} Respond with JSON with keys: ${shared}, ` +
    '"outcomes": an array of {"goal": string, "status": "done" | "partial" | "missed"} for each of today\'s goals, ' +
    '"wins": an array of short strings describing accomplishments, ' +
    '"struggles": an array of short (2-5 word) labels for obstacles or struggles, reusing common phrasing such as "procrastination", "low energy", "distractions", "time management" where they fit.'
  );
}

function toStringArray(value, max = 10) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .slice(0, max);
}

/** Validates and normalises the JSON summary returned by the model. */
function normalizeSummary(type, raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const goalUpdates = {};
  if (data.goalUpdates && typeof data.goalUpdates === 'object') {
    for (const level of GOAL_LEVELS) {
      if (typeof data.goalUpdates[level] === 'string' && data.goalUpdates[level].trim()) {
        goalUpdates[level] = data.goalUpdates[level].trim();
      }
    }
  }
  const result = {
    summary: typeof data.summary === 'string' ? data.summary.trim() : '',
    goalUpdates,
    goals: [],
    outcomes: [],
    wins: [],
    struggles: [],
  };
  if (type === 'morning') {
    result.goals = toStringArray(data.goals);
  } else {
    result.outcomes = (Array.isArray(data.outcomes) ? data.outcomes : [])
      .filter((o) => o && typeof o.goal === 'string' && ['done', 'partial', 'missed'].includes(o.status))
      .map((o) => ({ goal: o.goal.trim(), status: o.status }))
      .slice(0, 10);
    result.wins = toStringArray(data.wins);
    result.struggles = toStringArray(data.struggles);
  }
  return result;
}

function buildInsightsMessages({ goals, stats, conversations }) {
  const recent = conversations
    .filter((c) => c.endedAt && c.summary)
    .slice(0, 14)
    .map((c) => `${c.date} ${c.type}: ${c.summary}`)
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'You are Journey, an insightful personal goal coach. Based on the data provided, give the user 3-5 specific, actionable suggestions ' +
        'to improve how they SET goals and how they ACCOMPLISH them, and point out how well their daily goals align with their larger goals. ' +
        'If any level of their goal hierarchy is missing or vague, suggest how to define or refine it. Be encouraging and concise. ' +
        'Use plain text with a short intro line followed by a numbered list.',
    },
    {
      role: 'user',
      content: `Goals:\n${formatGoals(goals)}\n\nStatistics:\n${formatStats(stats)}\n\nRecent check-ins (newest first):\n${recent || '(none yet)'}`,
    },
  ];
}

/**
 * Thin OpenAI REST client (uses global fetch). The API key never leaves the server.
 */
class OpenAIClient {
  constructor({ apiKey = process.env.OPENAI_API_KEY, fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.transcribeModel = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
    this.ttsModel = process.env.OPENAI_TTS_MODEL || 'tts-1';
    this.ttsVoice = process.env.OPENAI_TTS_VOICE || 'alloy';
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async request(endpoint, init) {
    if (!this.apiKey) {
      const err = new Error('OPENAI_API_KEY is not configured on the server.');
      err.status = 503;
      throw err;
    }
    const res = await this.fetch(`${this.baseUrl}${endpoint}`, {
      ...init,
      headers: { Authorization: 'Bearer ' + this.apiKey, ...(init.headers || {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`OpenAI request failed (${res.status}): ${body.slice(0, 300)}`);
      err.status = 502;
      throw err;
    }
    return res;
  }

  async chat(messages, { json = false } = {}) {
    const res = await this.request('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    if (!json) return (content || '').trim();
    try {
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  async transcribe(buffer, mimeType = 'audio/webm') {
    const ext = (mimeType.split('/')[1] || 'webm').split(';')[0];
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), `speech.${ext}`);
    form.append('model', this.transcribeModel);
    const res = await this.request('/audio/transcriptions', { method: 'POST', body: form });
    const data = await res.json();
    return (data.text || '').trim();
  }

  async speak(text) {
    const res = await this.request('/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.ttsModel, voice: this.ttsVoice, input: text, response_format: 'mp3' }),
    });
    return Buffer.from(await res.arrayBuffer());
  }
}

module.exports = {
  OpenAIClient,
  buildSystemPrompt,
  buildSummaryPrompt,
  buildInsightsMessages,
  normalizeSummary,
  formatGoals,
};
