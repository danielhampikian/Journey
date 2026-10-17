'use strict';

const { GOAL_LEVELS } = require('./store');

const DAY_MS = 24 * 60 * 60 * 1000;

// How long (in days) a goal level can go without review before the coach
// prompts the user to refine it.
const REVIEW_INTERVAL_DAYS = {
  life: 180,
  yearly: 90,
  monthly: 30,
  weekly: 7,
};

/**
 * Returns the goal levels that are missing or haven't been reviewed recently,
 * ordered from the broadest (life) to the narrowest (weekly).
 */
function goalsNeedingReview(goals, now = new Date()) {
  const result = [];
  for (const level of GOAL_LEVELS) {
    const goal = goals[level] || {};
    if (!goal.text) {
      result.push({ level, reason: 'missing' });
      continue;
    }
    const updated = goal.updatedAt ? new Date(goal.updatedAt).getTime() : 0;
    const ageDays = Math.floor((now.getTime() - updated) / DAY_MS);
    if (ageDays >= REVIEW_INTERVAL_DAYS[level]) {
      result.push({ level, reason: 'stale', ageDays });
    }
  }
  return result;
}

module.exports = { goalsNeedingReview, REVIEW_INTERVAL_DAYS };
