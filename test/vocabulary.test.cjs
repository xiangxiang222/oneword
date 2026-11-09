'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { words, books, wordMap } = require('../data/vocabulary');
const provenance = require('../data/provenance.json');

test('word books advertise actual selected sizes and never fake SAT availability', () => {
  assert.equal(books.length, 10);
  for (const book of books) {
    assert.equal(book.count, book.wordIds.length);
    assert.equal(book.selectedCount, book.count);
    assert.equal(new Set(book.wordIds).size, book.count);
    assert.equal(book.available, book.count > 0);
    assert.equal(book.isComplete, false);
    assert(book.fullCount >= book.count);
    book.wordIds.forEach(id => assert(wordMap[id], 'missing word: ' + id));
    const offline = require('../data/books/' + book.id + '.json');
    assert.equal(offline.words.length, book.count);
    assert.deepEqual(offline.words.map(word => word.id), book.wordIds);
  }
  assert.equal(books.find(book => book.id === 'sat').available, false);
});

test('core meanings are one Chinese sense and optional examples are fully translated', () => {
  assert.equal(new Set(words.map(word => word.id)).size, words.length);
  for (const word of words) {
    assert.match(word.coreMeaning, /[\u4e00-\u9fff]/);
    assert(!/[,，;；\n]/.test(word.coreMeaning), word.word + ' has multiple visible meanings');
    assert(word.meanings.length > 0);
    assert.equal(word.meanings[0].meaning, word.coreMeaning);
    assert.equal(word.meanings[0].pos, word.pos);
    if (word.example) assert(word.example.en && word.example.zh);
    assert(word.bookIds.length > 0);
  }
});

test('upstream license, hash, byte counts and small native payload are traceable', () => {
  const license = fs.readFileSync(path.join(__dirname, '../data/ECDICT-LICENSE.txt'), 'utf8');
  assert(license.includes('MIT License'));
  assert(license.includes('Copyright (c) 2025 Linwei'));
  assert.equal(provenance.upstreamBlobSha1, '0e527e22e0e0d22f012b0ed251a8dddd5891773b');
  assert.equal(provenance.selectedUniqueWords, words.length);
  const size = fs.statSync(path.join(__dirname, '../data/vocabulary.js')).size;
  assert(size < 1.5 * 1024 * 1024);
  assert.equal(size, provenance.vocabularyBytes);
});

test('frequent polysemes teach useful common meanings instead of obscure first dictionary entries', () => {
  for (const [id, meaning] of [['a', '一（个）'], ['about', '关于'], ['can', '能够'], ['give', '给'], ['natural', '自然的'], ['still', '仍然'], ['settle', '定居']]) {
    assert.equal(wordMap[id].coreMeaning, meaning);
  }
  assert(!wordMap.natural.meanings.some(item => item.meaning === '白痴'));
});
