'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../shared/core');
const vocabulary = require('../data/vocabulary');
const full = require('../data/full-books/cet4.json');
const now = new Date(2026, 10, 8, 12).getTime();

test('all full books have source-level coverage, accurate metadata and valid compact payloads', () => {
  let bytes = 0;
  for (const filename of fs.readdirSync(path.join(__dirname, '../data/full-books'))) {
    const p = path.join(__dirname, '../data/full-books', filename);
    bytes += fs.statSync(p).size;
    const payload = JSON.parse(fs.readFileSync(p, 'utf8'));
    const result = core.validateBook(payload);
    assert.equal(result.words.length, payload.book.fullCount);
    assert.equal(result.book.count, result.words.length);
    assert.equal(result.book.edition, 'full');
    assert.equal(result.book.isComplete, false);
    assert(payload.license.includes('MIT License'));
    assert(payload.license.includes('Copyright (c) 2025 Linwei'));
    assert.equal(result.license, payload.license);
  }
  assert(bytes < 10 * 1024 * 1024);
  assert.equal(vocabulary.books.find(book => book.id === 'cet4').count, 180);
  assert.equal(vocabulary.words.length, 805, 'validation alone must never mutate vocabulary');
});

test('invalid book packages fail atomically before any shared vocabulary mutation', () => {
  const snapshots = {
    count: vocabulary.words.length,
    book: JSON.stringify(vocabulary.books.find(book => book.id === 'cet4')),
    word: JSON.stringify(vocabulary.wordMap.focus)
  };
  const copy = () => JSON.parse(JSON.stringify(full));
  let invalid = copy(); invalid.words.at(-1).coreMeaning = 'bad';
  assert.throws(() => core.installBook(invalid), /核心义/);
  invalid = copy(); invalid.words[1].id = invalid.words[0].id;
  assert.throws(() => core.installBook(invalid), /重复/);
  invalid = copy(); invalid.book.id = 'sat';
  assert.throws(() => core.installBook(invalid), /不可用/);
  invalid = copy(); invalid.book.count += 1;
  assert.throws(() => core.installBook(invalid), /数量/);
  invalid = copy(); invalid.words[0].id = 'constructor'; invalid.book.wordIds[0] = 'constructor';
  assert.throws(() => core.installBook(invalid), /编号/);
  invalid = copy(); invalid.words[0].example = { en: 'example' };
  assert.throws(() => core.installBook(invalid), /中文例句/);
  invalid = copy(); invalid.words = Array.from({ length: 15001 }, () => invalid.words[0]); invalid.book.count = 15001;
  assert.throws(() => core.installBook(invalid), /15000/);
  assert.equal(vocabulary.words.length, snapshots.count);
  assert.equal(JSON.stringify(vocabulary.books.find(book => book.id === 'cet4')), snapshots.book);
  assert.equal(JSON.stringify(vocabulary.wordMap.focus), snapshots.word);
});

test('installation preserves exported references and supports full-book progress across reload', () => {
  const wordsRef = vocabulary.words;
  const booksRef = vocabulary.books;
  const mapRef = vocabulary.wordMap;
  const bookRef = booksRef.find(book => book.id === 'cet4');
  const extraId = full.words.find(word => !mapRef[word.id]).id;
  const state = core.createState(now);
  assert.throws(() => core.rateWord(state, extraId, 'known', now), /单词/);
  const installed = core.installBook(full);
  assert.strictEqual(installed, bookRef);
  assert.strictEqual(vocabulary.words, wordsRef);
  assert.strictEqual(vocabulary.books, booksRef);
  assert.strictEqual(vocabulary.wordMap, mapRef);
  assert.equal(installed.count, full.words.length);
  assert.equal(installed.selectedCount, 180);
  assert.equal(core.getStats(state, now).bookTotal, full.words.length);
  const learned = core.rateWord(state, extraId, 'known', now);
  const restored = core.restoreState(JSON.stringify(learned), now);
  assert.equal(restored.words[extraId].status, 'known');
  const count = wordsRef.length;
  core.installBook(full);
  assert.equal(wordsRef.length, count, 'repeated cache hydration must be idempotent');
  const session = core.makeSession(restored, { now });
  assert(session.every(word => word && word.id));
});

test('installing overlapping books preserves prior collection state and book membership', () => {
  const state = core.rateWord(core.createState(now), 'focus', 'unknown', now);
  core.installBook(require('../data/full-books/cet6.json'));
  assert(vocabulary.wordMap.focus.bookIds.includes('cet4'));
  assert(vocabulary.wordMap.focus.bookIds.includes('cet6'));
  const switched = core.setBook(state, 'cet6');
  assert.equal(core.getCollection(switched, 'unknown')[0].id, 'focus');
  assert.equal(core.getStats(switched, now + 5 * core.MINUTE).dueCount, 1);
});
