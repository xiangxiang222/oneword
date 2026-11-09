'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/core');
const sync = require('../shared/sync');
const { books } = require('../data/vocabulary');
const now = new Date(2026, 10, 9, 12).getTime();
const ids = books.find(book => book.id === 'cet4').wordIds;
const first = ids[0];
const second = ids[1];
const day = core.dateKey(now);
const clone = value => JSON.parse(JSON.stringify(value));

function validate(state) {
  assert.deepEqual(core.restoreState(state, now), state);
}

test('unchanged devices preserve state without importing undo history', () => {
  const base = core.rateWord(core.createState(now), first, 'known', now);
  const result = sync.mergeStates(base, base, base);
  assert.equal(sync.sameState(result, base), true);
  assert.deepEqual(result.history, []);
  assert.notEqual(result.words[first], base.words[first]);
  validate(result);
});

test('three-way merge adds independent device answers and preserves both words', () => {
  const base = core.createState(now);
  const local = core.rateWord(base, first, 'known', now);
  const remote = core.rateWord(base, second, 'unknown', now + 1000);
  const result = sync.mergeStates(base, local, remote);
  assert.equal(result.words[first].status, 'known');
  assert.equal(result.words[second].status, 'unknown');
  assert.equal(result.daily[day].answerCount, 2);
  assert.equal(result.daily[day].known, 1);
  assert.equal(result.daily[day].unknown, 1);
  assert.deepEqual(new Set(result.daily[day].newWordIds), new Set([first, second]));
  validate(result);
});

test('daily delta adds to the common base once and keeps independent reviews', () => {
  const base = core.rateWord(core.createState(now), first, 'unknown', now);
  const local = core.rateWord(base, first, 'known', now + 5 * core.MINUTE);
  const remote = core.rateWord(base, second, 'unsure', now + 1000);
  const result = sync.mergeStates(base, local, remote);
  assert.equal(result.daily[day].answerCount, 3);
  assert.equal(result.daily[day].unknown, 1);
  assert.equal(result.daily[day].known, 1);
  assert.equal(result.daily[day].unsure, 1);
  assert.deepEqual(result.daily[day].reviewedWordIds, [first]);
  validate(result);
});

test('a same-word collision keeps the latest actual review and its whole schedule', () => {
  const base = core.rateWord(core.createState(now), first, 'unknown', now);
  const local = core.rateWord(base, first, 'known', now + 1000);
  const remote = core.rateWord(base, first, 'unsure', now + 2000);
  const result = sync.mergeStates(base, local, remote);
  assert.deepEqual(result.words[first], remote.words[first]);
  assert.equal(result.daily[day].answerCount, 3);
  validate(result);
});

test('equal-time collisions are deterministic regardless of merge direction', () => {
  const base = core.createState(now);
  const local = core.rateWord(base, first, 'known', now);
  const remote = core.rateWord(base, first, 'unknown', now);
  assert.equal(sync.sameState(sync.mergeStates(base, local, remote), sync.mergeStates(base, remote, local)), true);
});

test('undo deletes a word and its daily count when the other device is unchanged', () => {
  const base = core.rateWord(core.createState(now), first, 'known', now);
  const local = core.undo(base);
  const result = sync.mergeStates(base, local, base);
  assert.deepEqual(result.words, {});
  assert.deepEqual(result.daily, {});
  validate(result);
});

test('an undo never deletes a concurrently updated word on another phone', () => {
  const base = core.rateWord(core.createState(now), first, 'known', now);
  const local = core.undo(base);
  const remote = core.rateWord(base, first, 'unknown', now + 1000);
  const result = sync.mergeStates(base, local, remote);
  assert.deepEqual(result.words[first], remote.words[first]);
  assert.equal(result.daily[day].answerCount, 1);
  assert.equal(result.daily[day].unknown, 1);
  assert.deepEqual(result.daily[day].newWordIds, [first]);
  validate(result);
});

test('concurrent undos cannot produce negative daily counters', () => {
  const base = core.rateWord(core.createState(now), first, 'known', now);
  const local = core.undo(base);
  const remote = core.undo(base);
  const result = sync.mergeStates(base, local, remote);
  assert.deepEqual(result.words, {});
  assert.deepEqual(result.daily, {});
  validate(result);
});

test('per-field settings and active book merge changes from both devices', () => {
  const base = core.createState(now);
  const local = core.setBook(core.updateSettings(base, { dailyGoal: 12, learningOrder: 'random' }), 'cet6');
  const remote = core.updateSettings(base, { recallFirst: true, sound: true });
  const result = sync.mergeStates(base, local, remote);
  assert.equal(result.bookId, 'cet6');
  assert.equal(result.settings.dailyGoal, 12);
  assert.equal(result.settings.learningOrder, 'random');
  assert.equal(result.settings.recallFirst, true);
  assert.equal(result.settings.sound, true);
  validate(result);
});

test('initial guest import keeps cloud preferences and never doubles a restored backup', () => {
  const local = core.rateWord(core.updateSettings(core.createState(now), { dailyGoal: 15 }), first, 'known', now);
  const remote = core.updateSettings(clone(local), { dailyGoal: 30 });
  const result = sync.mergeStates(null, local, remote);
  assert.equal(result.daily[day].answerCount, 1);
  assert.equal(result.settings.dailyGoal, 30);
  assert.equal(sync.sameState(result, remote), true);
  validate(result);
});

test('guest import preserves different words and uses conservative aggregate counts', () => {
  const local = core.rateWord(core.createState(now), first, 'known', now);
  const remote = core.rateWord(core.createState(now + 1000), second, 'unknown', now + 1000);
  const result = sync.mergeStates(null, local, remote);
  assert.equal(Object.keys(result.words).length, 2);
  assert.equal(result.daily[day].answerCount, 2);
  assert.equal(result.createdAt, now);
  validate(result);
});

test('merging snapshots never mutates any input, including nested arrays', () => {
  const base = core.rateWord(core.createState(now), first, 'known', now);
  const local = core.updateSettings(base, { dailyGoal: 8 });
  const remote = core.rateWord(base, second, 'unsure', now + 1000);
  const before = [base, local, remote].map(clone);
  const result = sync.mergeStates(base, local, remote);
  result.words[first].status = 'unknown';
  result.daily[day].newWordIds.push('test');
  result.settings.dailyGoal = 200;
  assert.deepEqual([base, local, remote], before);
});

test('state equality ignores history, object key order and daily set insertion order', () => {
  const a = core.rateWord(core.rateWord(core.createState(now), first, 'known', now), second, 'unsure', now + 1000);
  const b = clone(a);
  b.history = [];
  b.words = Object.fromEntries(Object.entries(b.words).reverse());
  b.daily[day].newWordIds.reverse();
  b.settings = Object.fromEntries(Object.entries(b.settings).reverse());
  assert.equal(sync.sameState(a, b), true);
  b.settings.dailyGoal++;
  assert.equal(sync.sameState(a, b), false);
});

test('book manifest merge is deterministic and rejects malformed identifiers', () => {
  assert.deepEqual(sync.mergeBookIds(['cet6', 'cet4'], ['cet4', 'primary'], null), ['cet4', 'cet6', 'primary']);
  for (const bad of [['../cet4'], ['__proto__'], ['constructor'], [3], {}]) assert.throws(() => sync.mergeBookIds(bad), /无效/);
});

test('own property copying cannot invoke a prototype setter', () => {
  const state = core.createState(now);
  const odd = JSON.parse('{"__proto__":{"polluted":true}}');
  const local = { ...state, words: odd };
  const result = sync.mergeStates(state, local, state);
  assert.equal(Object.getPrototypeOf(result.words), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(result.words, '__proto__'), true);
  assert.equal(result.words.__proto__.polluted, true);
});

test('daily counter overflow fails without emitting a state core cannot restore', () => {
  const base = core.createState(now);
  const local = core.rateWord(base, first, 'known', now);
  const remote = clone(local);
  local.daily[day].known = local.daily[day].answerCount = 600000;
  remote.daily[day].known = remote.daily[day].answerCount = 600000;
  assert.throws(() => sync.mergeStates(base, local, remote), /超过可同步范围/);
});
