'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/core');
const vocabulary = require('../data/vocabulary');
const now = new Date(2026, 10, 9, 12).getTime();
const book = vocabulary.books.find(item => item.id === 'cet4');
const ids = book.wordIds;
const list = (state, options = {}) => core.makeSession(state, { now, ...options }).map(word => word.id);
const setOrder = (order, goal = 20) => core.updateSettings(core.createState(now - core.DAY), { learningOrder: order, dailyGoal: goal });
function progress(status, dueAt, interval, lapses = 0) {
  return { status, dueAt, interval, lapses, repetitions: status === 'known' ? 1 : 0, lastReviewedAt: dueAt - interval, firstReviewedAt: dueAt - interval, totalReviews: 1 };
}

// These expectations express learner-facing behavior; they do not depend on a
// particular hash or PRNG, so future algorithms can improve without test churn.
test('learning-order choices are persisted, strictly validated, and migrate old backups', () => {
  assert.deepEqual(core.LEARNING_ORDERS.map(item => item.id), ['adaptive', 'alphabetical', 'random']);
  assert.equal(core.createState(now).settings.learningOrder, 'adaptive');
  const legacy = core.createState(now);
  delete legacy.settings.learningOrder;
  assert.equal(core.restoreState(legacy, now).settings.learningOrder, 'adaptive');
  for (const mode of core.LEARNING_ORDERS) {
    assert.ok(mode.label && mode.description);
    const state = setOrder(mode.id);
    assert.equal(core.restoreState(JSON.stringify(state), now).settings.learningOrder, mode.id);
  }
  for (const value of ['', 'sequential', null, true, 4, {}]) {
    assert.throws(() => core.updateSettings(core.createState(now), { learningOrder: value }), /字母顺序/);
    const bad = core.createState(now); bad.settings.learningOrder = value;
    assert.throws(() => core.restoreState(bad, now), /字母顺序/);
    assert.throws(() => list(core.createState(now), { learningOrder: value }), /字母顺序/);
  }
});

test('alphabetical mode sorts the full unseen pool before applying the daily quota', () => {
  const state = setOrder('alphabetical', 3);
  const expected = ids.slice().sort().slice(0, 3);
  assert.deepEqual(list(state), expected);
  assert.notDeepEqual(expected, ids.slice(0, 3).sort());
  const learned = core.rateWord(state, expected[0], 'known', now);
  assert.deepEqual(list(learned), expected.slice(1));
});

test('random mode samples across the full book and remains stable after ratings, reload and settings changes', () => {
  const state = setOrder('random');
  const firstSession = list(state);
  assert.equal(firstSession.length, 20);
  assert.equal(new Set(firstSession).size, firstSession.length);
  assert.ok(firstSession.some(id => !ids.slice(0, 20).includes(id)));
  assert.notDeepEqual(firstSession, firstSession.slice().sort());
  assert.deepEqual(list(state, { now: now + 3600000 }), firstSession);
  assert.deepEqual(list(core.restoreState(JSON.stringify(state), now)), firstSession);
  const learned = core.rateWord(state, firstSession[0], 'known', now);
  assert.deepEqual(list(learned), firstSession.slice(1));
  const changed = core.updateSettings(learned, { learningOrder: 'alphabetical' });
  assert.deepEqual(list(changed, { learningOrder: 'random' }), firstSession.slice(1));
  assert.equal(changed.settings.learningOrder, 'alphabetical');
});

test('random mode changes on the next local day and separates different learners', () => {
  const state = setOrder('random');
  const tomorrow = new Date(2026, 10, 10, 12).getTime();
  assert.notDeepEqual(list(state, { now: tomorrow }), list(state));
  const other = { ...state, createdAt: state.createdAt + 1234567 };
  assert.notDeepEqual(list(other), list(state));
});

test('all learning orders keep due reviews ahead of fresh words and honour the global daily quota', () => {
  for (const mode of core.LEARNING_ORDERS) {
    let state = setOrder(mode.id, 3);
    state = core.rateWord(state, ids[0], 'unknown', now - 6 * core.MINUTE);
    state = core.rateWord(state, ids[1], 'unsure', now - 16 * core.MINUTE);
    const queue = list(state);
    assert.equal(queue.length, 3);
    assert.deepEqual(new Set(queue.slice(0, 2)), new Set(ids.slice(0, 2)));
    assert.equal(state.words[queue[2]], undefined);
    assert.equal(list(state, { limit: 1 }).length, 1);
    assert.ok(state.words[list(state, { limit: 1 })[0]]);
    assert.equal(list(state, { mode: 'new' }).length, 1);
    assert.equal(list(state, { mode: 'review' }).length, 2);
  }
});

test('adaptive reviews prioritise relative overdue time, then weak judgments and repeated lapses', () => {
  const state = setOrder('adaptive');
  state.words[ids[0]] = progress('known', now - 6 * 3600000, core.DAY);
  state.words[ids[1]] = progress('unknown', now - 3 * core.MINUTE, 5 * core.MINUTE);
  assert.deepEqual(list(state, { mode: 'review' }), [ids[1], ids[0]]);
  state.words[ids[0]] = progress('known', now, core.DAY);
  state.words[ids[1]] = progress('unknown', now, 5 * core.MINUTE, 1);
  state.words[ids[2]] = progress('unsure', now, 15 * core.MINUTE);
  state.words[ids[3]] = progress('unknown', now, 5 * core.MINUTE, 3);
  assert.deepEqual(list(state, { mode: 'review' }), [ids[3], ids[1], ids[2], ids[0]]);
  assert.deepEqual(list(setOrder('adaptive', 4)), ids.slice(0, 4));
});

test('alphabetical and random modes also order review and collection practice without making future words due', () => {
  const state = setOrder('alphabetical');
  for (const id of ids.slice(0, 6)) state.words[id] = progress('known', now + core.DAY, core.DAY);
  assert.deepEqual(list(state, { mode: 'review' }), []);
  assert.deepEqual(list(state, { mode: 'known' }), ids.slice(0, 6).sort());
  assert.deepEqual(list(state, { mode: 'all' }), ids.slice(0, 6).sort());
  const random = core.updateSettings(state, { learningOrder: 'random' });
  const known = list(random, { mode: 'known' });
  assert.deepEqual(new Set(known), new Set(ids.slice(0, 6)));
  assert.deepEqual(list(random, { mode: 'known' }), known);
  assert.deepEqual(list(random, { mode: 'review' }), []);
  for (const mode of ['unknown', 'unsure']) {
    const practice = { ...state, words: Object.fromEntries(ids.slice(0, 6).map(id => [id, progress(mode, now - 1, 5 * core.MINUTE)])) };
    assert.deepEqual(list(practice, { mode }), ids.slice(0, 6).sort());
  }
  for (const entry of Object.values(state.words)) entry.dueAt = now;
  assert.deepEqual(list(state, { mode: 'review' }), ids.slice(0, 6).sort());
});

test('ordering never mutates source books, word records, settings, or the existing session', () => {
  for (const mode of core.LEARNING_ORDERS) {
    let state = setOrder(mode.id);
    state = core.rateWord(state, ids[1], 'unknown', now - 10 * core.MINUTE);
    const snapshot = JSON.stringify(state);
    const source = JSON.stringify(vocabulary.books);
    const words = JSON.stringify(vocabulary.words);
    const session = core.makeSession(state, { now });
    const savedIds = session.map(word => word.id);
    core.makeSession(core.updateSettings(state, { learningOrder: 'alphabetical' }), { now });
    assert.deepEqual(session.map(word => word.id), savedIds);
    assert.equal(JSON.stringify(state), snapshot);
    assert.equal(JSON.stringify(vocabulary.books), source);
    assert.equal(JSON.stringify(vocabulary.words), words);
  }
});
