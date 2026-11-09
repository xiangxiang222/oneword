'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, normalizeBasePath } = require('../server/index.js');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'oneword-server-'));
fs.mkdirSync(path.join(fixture, 'assets'));
fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><title>一词 fixture</title>');
fs.writeFileSync(path.join(fixture, 'assets', 'entry.js'), 'window.oneword=true;');
const fullBooksDir = path.join(fixture, 'complete-books');
fs.mkdirSync(fullBooksDir);
fs.writeFileSync(path.join(fixture, 'outside-secret.json'), JSON.stringify({ secret: 'must-never-be-returned' }));
fs.writeFileSync(path.join(fullBooksDir, 'cet4.json'), JSON.stringify({
  source: { name: 'ECDICT', license: 'MIT' },
  book: { id: 'cet4', title: '大学四级', count: 999, wordIds: ['outdated-metadata'] },
  words: [{ id: 'w1', word: 'focus', coreMeaning: '专注' }, { id: 'w2', word: 'grow', coreMeaning: '成长' }]
}));
fs.writeFileSync(path.join(fullBooksDir, 'invalid.json'), JSON.stringify({ book: { id: 'invalid' }, words: [{ id: 'duplicate' }, { id: 'duplicate' }] }));
const catalog = {
  books: [
    { id: 'cet4', title: '大学四级', wordIds: ['w1'], available: true, count: 1 },
    { id: 'sat', title: 'SAT', wordIds: [], available: false, count: 0 },
    { id: 'missing', title: '未提供完整版', wordIds: [], available: true, count: 0, fullCount: 200, fullAvailable: true },
    { id: 'invalid', title: '损坏的完整包', wordIds: [], available: true, count: 0 },
    { id: '../outside-secret', title: '不安全的词书ID', wordIds: [], available: true, count: 0 }
  ],
  words: [{ id: 'w1', word: 'focus', coreMeaning: '专注' }]
};
let server;
let origin;
before(async () => {
  server = createApp({ basePath: '/oneword', distDir: fixture, fullBooksDir, catalog }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('base path validation rejects ambiguous and external paths', () => {
  assert.equal(normalizeBasePath('/oneword/'), '/oneword');
  assert.equal(normalizeBasePath('/'), '');
  for (const value of ['https://host', '/foo//bar', '/foo/../bar', '/foo?x=1']) assert.throws(() => normalizeBasePath(value));
});
test('health reports cloud and local storage with security headers without Express fingerprint', async () => {
  const response = await fetch(`${origin}/oneword/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).storage, 'cloud+local');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('catalog exposes real counts and selected words', async () => {
  const response = await fetch(`${origin}/oneword/api/books`);
  const data = await response.json();
  assert.equal(data.books[0].count, 1);
  assert.equal(data.books[0].wordIds, undefined);
  assert.equal(data.books[0].selectedCount, 1);
  assert.equal(data.books[0].fullCount, 2);
  assert.equal(data.books[0].fullAvailable, true);
  assert.equal(data.books.find(book => book.id === 'sat').fullAvailable, false);
  assert.equal(data.books.find(book => book.id === 'missing').fullAvailable, false);
  assert.equal(data.books.find(book => book.id === 'invalid').fullAvailable, false);
  const result = await fetch(`${origin}/oneword/api/books/cet4/words`).then(response => response.json());
  assert.deepEqual(result.words.map(word => word.word), ['focus']);
  assert.equal(result.book.count, result.words.length);
  const missing = await fetch(`${origin}/oneword/api/books/notfound/words`);
  assert.equal(missing.status, 404);
  const unavailable = await fetch(`${origin}/oneword/api/books/sat/words`);
  assert.equal(unavailable.status, 409);
});
test('complete edition returns the actual package while selected stays backward compatible', async () => {
  const response = await fetch(`${origin}/oneword/api/books/cet4/words?edition=full`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.words.map(word => word.id), ['w1', 'w2']);
  assert.deepEqual(payload.book.wordIds, ['w1', 'w2']);
  assert.equal(payload.book.count, 2);
  assert.equal(payload.book.fullCount, 2);
  assert.equal(payload.book.selectedCount, 1);
  assert.equal(payload.book.edition, 'full');
  assert.equal(payload.source.license, 'MIT');
  assert.deepEqual(await fetch(`${origin}/oneword/api/books/cet4/full`).then(result => result.json()), payload);
  const selected = await fetch(`${origin}/oneword/api/books/cet4/words?edition=selected`).then(result => result.json());
  assert.equal(selected.words.length, 1);
  assert.equal(selected.book.count, 1);
  assert.equal(selected.book.edition, 'selected');
});
test('missing complete packages and invalid editions never silently fall back to a sample', async () => {
  for (const id of ['sat', 'missing']) {
    const response = await fetch(`${origin}/oneword/api/books/${id}/words?edition=full`);
    assert.equal(response.status, 404);
    const data = await response.json();
    assert.equal(data.error, 'full_book_unavailable');
    assert.equal(data.words, undefined);
  }
  const bad = await fetch(`${origin}/oneword/api/books/invalid/words?edition=full`);
  assert.equal(bad.status, 500);
  assert.equal((await bad.json()).error, 'full_book_invalid');
  for (const query of ['edition=unknown', 'edition=../../outside-secret', 'edition=full&edition=selected']) {
    const response = await fetch(`${origin}/oneword/api/books/cet4/words?${query}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_edition');
  }
});
test('complete-book routes cannot read arbitrary files through paths or query parameters', async () => {
  for (const route of [
    '/api/books/%2e%2e%2foutside-secret/words?edition=full',
    '/api/books/%252e%252e%252foutside-secret/full',
    '/api/books/outside-secret/full?path=../outside-secret.json',
    '/api/books/constructor/full',
    '/data/full-books/cet4.json'
  ]) {
    const response = await fetch(`${origin}/oneword${route}`);
    assert.equal(response.status, 404, route);
    assert.doesNotMatch(await response.text(), /must-never-be-returned/);
  }
  const response = await fetch(`${origin}/oneword/api/books/cet4/full?file=../outside-secret.json`);
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /must-never-be-returned/);
});
test('SPA fallback serves approved pages while files and API errors stay errors', async () => {
  const redirect = await fetch(`${origin}/oneword`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  for (const route of ['/', '/today', '/study', '/settings']) {
    const response = await fetch(`${origin}/oneword${route}`, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /一词 fixture/);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
  for (const route of ['/api/missing', '/api', '/assets/missing.js', '/server/index.js', '/.env', '/package.json', '/source', '/../.env', '/%2eenv']) {
    const response = await fetch(`${origin}/oneword${route}`, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 404, route);
    assert.match(response.headers.get('content-type'), /application\/json/);
  }
  const post = await fetch(`${origin}/oneword/study`, { method: 'POST' });
  assert.equal(post.status, 404);
});
test('built assets cache immutably and invalid encoding does not crash service', async () => {
  const asset = await fetch(`${origin}/oneword/assets/entry.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  const bad = await fetch(`${origin}/oneword/%ZZ`);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_path');
});
test('mount at / is supported for standalone hosting', async () => {
  const rootServer = createApp({ basePath: '/', distDir: fixture, catalog }).listen(0, '127.0.0.1');
  await new Promise(resolve => rootServer.once('listening', resolve));
  try {
    const result = await fetch(`http://127.0.0.1:${rootServer.address().port}/api/health`);
    assert.equal(result.status, 200);
  } finally { await new Promise(resolve => rootServer.close(resolve)); }
});
