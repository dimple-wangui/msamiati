// Learner model: FSRS-4.5 spaced repetition (default parameters).
// Each card has a memory state: stability S (days until recall drops to 90%)
// and difficulty D (1-10). After each review we update S and D from the rating.

const W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474,
  0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
];
const DECAY = -0.5;
const FACTOR = 19 / 81;
export const TARGET_RETENTION = 0.9;
const MAX_INTERVAL = 365;
const DAY_MS = 86400000;

export const RATINGS = { again: 1, hard: 2, good: 3, easy: 4 };

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Probability of recall t days after the last review.
export function retrievability(elapsedDays, stability) {
  if (!stability) return 0;
  return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY);
}

function nextInterval(stability) {
  const days = (stability / FACTOR) * (Math.pow(TARGET_RETENTION, 1 / DECAY) - 1);
  return clamp(Math.round(days), 1, MAX_INTERVAL);
}

const initStability = (g) => Math.max(W[g - 1], 0.1);
const initDifficulty = (g) => clamp(W[4] - (g - 3) * W[5], 1, 10);

function nextDifficulty(d, g) {
  const next = d - W[6] * (g - 3);
  return clamp(W[7] * initDifficulty(3) + (1 - W[7]) * next, 1, 10);
}

function recallStability(d, s, r, g) {
  const hard = g === 2 ? W[15] : 1;
  const easy = g === 4 ? W[16] : 1;
  return (
    s *
    (1 +
      Math.exp(W[8]) *
        (11 - d) *
        Math.pow(s, -W[9]) *
        (Math.exp(W[10] * (1 - r)) - 1) *
        hard *
        easy)
  );
}

function forgetStability(d, s, r) {
  const sf =
    W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
  return Math.min(sf, s);
}

// state: null for a new card, otherwise {stability, difficulty, last_review, reps, lapses}
export function elapsedDays(state, now = Date.now()) {
  if (!state || !state.last_review) return 0;
  return (now - new Date(state.last_review).getTime()) / DAY_MS;
}

export function currentRecall(state, now = Date.now()) {
  if (!state || !state.stability) return null;
  return retrievability(elapsedDays(state, now), state.stability);
}

// Returns the new state plus what to log.
export function review(state, grade, now = Date.now()) {
  const isNew = !state || !state.stability;
  const elapsed = elapsedDays(state, now);
  const r = isNew ? null : retrievability(elapsed, state.stability);
  let s, d;
  if (isNew) {
    s = initStability(grade);
    d = initDifficulty(grade);
  } else {
    d = nextDifficulty(state.difficulty, grade);
    s = grade === 1
      ? forgetStability(state.difficulty, state.stability, r)
      : recallStability(state.difficulty, state.stability, r, grade);
  }
  // "Again" brings the card back in this session (in 1 minute); otherwise schedule in days.
  const dueMs = grade === 1 ? now + 60 * 1000 : now + nextInterval(s) * DAY_MS;
  const scheduledDays = grade === 1 ? 0 : nextInterval(s);
  return {
    state: {
      stability: s,
      difficulty: d,
      due: new Date(dueMs).toISOString(),
      last_review: new Date(now).toISOString(),
      reps: (state?.reps || 0) + 1,
      lapses: (state?.lapses || 0) + (grade === 1 && !isNew ? 1 : 0),
    },
    log: {
      rating: grade,
      elapsed_days: Number(elapsed.toFixed(4)),
      scheduled_days: scheduledDays,
      predicted_recall: r === null ? null : Number(r.toFixed(4)),
      was_new: isNew,
    },
  };
}

// Human label for the button preview ("1m", "3d", "2mo").
export function previewLabel(state, grade, now = Date.now()) {
  const { log } = review(state, grade, now);
  const d = log.scheduled_days;
  if (d === 0) return "1m";
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}
