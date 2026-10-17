'use strict';

const OUTCOME_SCORES = { done: 1, partial: 0.5, missed: 0 };

function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Builds per-day records from completed conversations. A day's completion
 * rate comes from the evening conversation's goal outcomes.
 */
function buildDays(conversations) {
  const days = new Map();
  const get = (date) => {
    if (!days.has(date)) {
      days.set(date, { date, morning: false, evening: false, goalsSet: 0, done: 0, partial: 0, missed: 0, completion: null });
    }
    return days.get(date);
  };
  const completed = conversations
    .filter((c) => c.endedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const c of completed) {
    const day = get(c.date);
    if (c.type === 'morning') {
      day.morning = true;
      day.goalsSet = (c.goals || []).length;
    } else if (c.type === 'evening') {
      day.evening = true;
      // The latest evening check-in for a day wins.
      day.done = 0;
      day.partial = 0;
      day.missed = 0;
      for (const o of c.outcomes || []) {
        if (o.status in OUTCOME_SCORES) day[o.status] += 1;
      }
    }
  }
  for (const day of days.values()) {
    const total = day.done + day.partial + day.missed;
    day.completion = total ? round((day.done + 0.5 * day.partial) / total) : null;
  }
  return days;
}

function average(values) {
  const nums = values.filter((v) => typeof v === 'number');
  return nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
}

/**
 * Computes motivational statistics for the dashboard.
 * @param {Array} conversations
 * @param {string} today - local date of the user, YYYY-MM-DD
 * @param {number} windowDays - number of days to include in the daily series
 */
function computeStats(conversations, today, windowDays = 14) {
  const days = buildDays(conversations);

  const daily = [];
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const date = addDays(today, -i);
    daily.push(days.get(date) || { date, morning: false, evening: false, goalsSet: 0, done: 0, partial: 0, missed: 0, completion: null });
  }

  // Check-in streak: consecutive days with at least one completed
  // conversation, ending today (or yesterday if today has none yet).
  const checkedIn = (date) => days.has(date);
  let cursor = checkedIn(today) ? today : addDays(today, -1);
  let currentStreak = 0;
  while (checkedIn(cursor)) {
    currentStreak += 1;
    cursor = addDays(cursor, -1);
  }

  let longestStreak = 0;
  let run = 0;
  let prev = null;
  for (const date of [...days.keys()].sort()) {
    run = prev && addDays(prev, 1) === date ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    prev = date;
  }

  const totals = { morning: 0, evening: 0, goalsSet: 0, done: 0, partial: 0, missed: 0 };
  for (const day of days.values()) {
    totals.morning += day.morning ? 1 : 0;
    totals.evening += day.evening ? 1 : 0;
    totals.goalsSet += day.goalsSet;
    totals.done += day.done;
    totals.partial += day.partial;
    totals.missed += day.missed;
  }

  const last7 = daily.slice(-7).map((d) => d.completion);
  const prev7 = daily.slice(-14, -7).map((d) => d.completion);
  const last7Avg = average(last7);
  const prev7Avg = average(prev7);

  const struggleCounts = new Map();
  for (const c of conversations) {
    if (!c.endedAt) continue;
    for (const s of c.struggles || []) {
      const key = String(s).trim().toLowerCase();
      if (key) struggleCounts.set(key, (struggleCounts.get(key) || 0) + 1);
    }
  }
  const topStruggles = [...struggleCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([text, count]) => ({ text, count }));

  return {
    today,
    daily,
    totals,
    currentStreak,
    longestStreak,
    overallCompletion: average([...days.values()].map((d) => d.completion)),
    last7Completion: last7Avg,
    trend: last7Avg !== null && prev7Avg !== null ? round(last7Avg - prev7Avg) : null,
    topStruggles,
  };
}

module.exports = { computeStats, addDays };
