'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/core');
const { books } = require('../data/vocabulary');
const now = new Date(2026, 10, 8, 12).getTime();
const first = books.find(book => book.id === 'cet4').wordIds[0];
const second = books.find(book => book.id === 'cet4').wordIds[1];

test('fresh state has no manufactured progress and honours daily new-word limit', () => {
  const state = core.createState(now);
  assert.equal(core.getStats(state, now).todayAnswers, 0);
  assert.equal(core.getStats(state, now).totalLearned, 0);
  assert.equal(core.makeSession(state, { now }).length, 20);
  const smaller = core.updateSettings(state, { dailyGoal: 3 });
  assert.equal(core.makeSession(smaller, { now }).length, 3);
  assert.equal(state.settings.dailyGoal, 20);
});

test('unknown and unsure schedule short retrievals; known remains scheduled', () => {
  const initial = core.createState(now);
  for (const [rating, delay] of [['unknown', 5 * core.MINUTE], ['unsure', 15 * core.MINUTE], ['known', core.DAY]]) {
    const state = core.rateWord(initial, first, rating, now);
    assert.equal(state.words[first].dueAt, now + delay);
    assert.equal(state.words[first].status, rating);
    assert.equal(core.getStats(state, now).masteredCount, 0);
    assert.deepEqual(core.makeSession(state, { mode: 'review', now: now + delay - 1 }), []);
    assert.equal(core.makeSession(state, { mode: 'review', now: now + delay })[0].id, first);
  }
  assert.deepEqual(initial.words, {});
});

test('successful retrieval expands intervals and forgetting resets the schedule', () => {
  let state = core.createState(now);
  let at = now;
  for (const days of [1, 2, 4, 7, 15, 30, 60, 90, 90]) {
    state = core.rateWord(state, first, 'known', at);
    assert.equal(state.words[first].interval, days * core.DAY);
    at = state.words[first].dueAt;
  }
  assert.equal(core.getStats(state, at).masteredCount, 1);
  state = core.rateWord(state, first, 'unknown', at);
  assert.equal(state.words[first].interval, 5 * core.MINUTE);
  assert.equal(state.words[first].repetitions, 0);
  assert.equal(state.words[first].lapses, 1);
  assert.equal(core.getStats(state, at).masteredCount, 0);
  state = core.rateWord(state, first, 'known', at + 5 * core.MINUTE);
  assert.equal(state.words[first].interval, core.DAY);
});

test('due review has priority over fresh words', () => {
  const state = core.rateWord(core.createState(now), second, 'unknown', now);
  const session = core.makeSession(state, { now: now + 5 * core.MINUTE });
  assert.equal(session[0].id, second);
  assert.equal(session[1].id, first);
});

test('same-day repetition does not consume the daily new-word quota again', () => {
  let state = core.rateWord(core.createState(now), first, 'unknown', now);
  state = core.rateWord(state, first, 'known', now + 5 * core.MINUTE);
  const stats = core.getStats(state, now + 5 * core.MINUTE);
  assert.equal(stats.todayNew, 1);
  assert.equal(stats.todayReviews, 1);
  assert.equal(stats.todayAnswers, 2);
  assert.equal(stats.remainingNew, 19);
});

test('double tap and stale events are idempotent', () => {
  const state = core.rateWord(core.createState(now), first, 'known', now);
  assert.strictEqual(core.rateWord(state, first, 'unknown', now + 100), state);
  assert.strictEqual(core.rateWord(state, first, 'unknown', now - 1000), state);
  assert.equal(core.getStats(state, now).todayAnswers, 1);
});

test('early collection practice cannot promote a word to stable long-term recall', () => {
  let state = core.rateWord(core.createState(now), first, 'known', now);
  for (let i = 1; i <= 10; i += 1) state = core.rateWord(state, first, 'known', now + i * 1000);
  assert.equal(state.words[first].repetitions, 1);
  assert.equal(state.words[first].interval, core.DAY);
  assert.equal(core.getStats(state, now + 10000).masteredCount, 0);
  state = core.rateWord(state, first, 'known', state.words[first].dueAt);
  assert.equal(state.words[first].repetitions, 2);
  assert.equal(state.words[first].interval, 2 * core.DAY);
});

test('undo restores word state, exact due date and daily counters', () => {
  const initial = core.createState(now);
  const state = core.rateWord(initial, first, 'unknown', now);
  const repeated = core.rateWord(state, first, 'known', now + 5 * core.MINUTE);
  assert.deepEqual(core.undo(repeated), state);
  assert.deepEqual(core.undo(state), initial);
  assert.strictEqual(core.undo(initial), initial);
});

test('changing books retains shared words and undo does not change the current book', () => {
  const state = core.rateWord(core.createState(now), first, 'known', now);
  const switched = core.setBook(state, 'cet6');
  assert.deepEqual(switched.words[first], state.words[first]);
  assert.equal(core.getStats(switched, now).totalLearned, 1);
  assert.equal(core.undo(switched).bookId, 'cet6');
  assert.equal(core.getCollection(switched, 'known')[0].id, first);
});

test('new-word quota resets at local midnight while review history remains', () => {
  const late = new Date(2026, 10, 8, 23, 59).getTime();
  const nextDay = new Date(2026, 10, 9, 0, 1).getTime();
  const state = core.rateWord(core.createState(late), first, 'unknown', late);
  assert.equal(core.getStats(state, late).remainingNew, 19);
  assert.equal(core.getStats(state, nextDay).remainingNew, 20);
  assert.equal(core.getStats(state, nextDay).streak, 1);
  assert.equal(state.words[first].dueAt, late + 5 * core.MINUTE);
});

test('streak and seven-day chart derive only from actual dated answers', () => {
  const d1 = new Date(2026, 10, 6, 12).getTime();
  const d2 = new Date(2026, 10, 7, 12).getTime();
  let state = core.rateWord(core.createState(d1), first, 'known', d1);
  state = core.rateWord(state, second, 'known', d2);
  const stats = core.getStats(state, now);
  assert.equal(stats.streak, 2);
  assert.equal(stats.last7Days.length, 7);
  assert.equal(stats.last7Days.reduce((sum, day) => sum + day.total, 0), 2);
  assert.equal(stats.last7Days.at(-1).total, 0);
  assert.equal(core.getStats(state, now + core.DAY).streak, 0);
});

test('collections partition all learned words by latest judgment', () => {
  let state = core.rateWord(core.createState(now), first, 'known', now);
  state = core.rateWord(state, second, 'unsure', now + 1000);
  assert.equal(core.getCollection(state, 'known').length, 1);
  assert.equal(core.getCollection(state, 'unknown').length, 0);
  assert.equal(core.getCollection(state, 'unsure').length, 1);
  assert.equal(core.getCollection(state, 'all').length, 2);
  state = core.rateWord(state, first, 'unknown', now + 5 * core.MINUTE);
  assert.equal(core.getCollection(state, 'known').length, 0);
  assert.equal(core.getCollection(state, 'unknown').length, 1);
});

test('history is bounded and state survives a validated JSON export/import', () => {
  let state = core.createState(now);
  for (let i = 0; i < 30; i += 1) state = core.rateWord(state, first, 'known', now + i * core.DAY);
  assert.equal(state.history.length, 20);
  const restored = core.restoreState(JSON.stringify(state), now);
  assert.deepEqual(restored.words, state.words);
  assert.deepEqual(restored.daily, state.daily);
  assert.deepEqual(restored.settings, state.settings);
  assert.deepEqual(restored.history, []);
  assert.deepEqual(core.getStats(restored, now), core.getStats(state, now));
});

test('invalid judgments, word ids, books, times and settings fail clearly', () => {
  const state = core.createState(now);
  assert.throws(() => core.rateWord(state, '__proto__', 'known', now), /单词/);
  assert.throws(() => core.rateWord(state, 'constructor', 'known', now), /单词/);
  assert.throws(() => core.rateWord(state, first, 'easy', now), /请选择/);
  assert.throws(() => core.rateWord(state, first, 'known', NaN), /时间/);
  assert.throws(() => core.setBook(state, 'sat'), /不可用/);
  for (const dailyGoal of [-1, 0, 201, 2.5, '20']) assert.throws(() => core.updateSettings(state, { dailyGoal }), /1–200/);
  assert.throws(() => core.updateSettings(state, { recallFirst: 'yes' }), /无效/);
  assert.equal(core.updateSettings(state, { accent: 'uk' }).settings.accent, 'uk');
  assert.throws(() => core.updateSettings(state, { accent: 'anything' }), /英式/);
});

test('import rejects malformed JSON, unsupported versions and dangerous state', () => {
  assert.throws(() => core.restoreState('{'), /JSON/);
  assert.throws(() => core.restoreState({ version: 2 }), /版本/);
  const state = core.rateWord(core.createState(now), first, 'known', now);
  const clone = () => JSON.parse(JSON.stringify(state));
  let bad = clone(); bad.words[first].dueAt = -1;
  assert.throws(() => core.restoreState(bad), /单词记录/);
  bad = clone(); bad.words[first].interval = 20;
  assert.throws(() => core.restoreState(bad), /单词记录/);
  bad = clone(); bad.words.notaword = bad.words[first];
  assert.throws(() => core.restoreState(bad), /单词记录/);
  bad = clone(); bad.daily['2026-99-99'] = Object.values(bad.daily)[0];
  assert.throws(() => core.restoreState(bad), /每日记录/);
  bad = clone(); bad.daily[core.dateKey(now)].newWordIds.push(first);
  assert.throws(() => core.restoreState(bad), /每日记录/);
  bad = clone(); bad.settings.dailyGoal = 100000;
  assert.throws(() => core.restoreState(bad), /1–200/);
  assert.throws(() => core.restoreState(' '.repeat(5 * 1024 * 1024 + 1)), /5 MB/);
});
