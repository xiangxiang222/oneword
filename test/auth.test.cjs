'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../server/node_modules/better-sqlite3');
const { createApp } = require('../server');
const core = require('../shared/core');
const vocabulary = require('../data/vocabulary');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneword-accounts-'));
const dbPath = path.join(dir, 'accounts.sqlite');
const password = 'a-secure-test-password';
let app, server, origin, cookie, nativeToken, user, firstSnapshot;
async function start() {
  app = createApp({ dbPath });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}
async function stop() {
  await new Promise(resolve => server.close(resolve));
  app.locals.closeStore();
}
async function request(route, body, credentials = {}) {
  const headers = { ...credentials };
  const options = { headers };
  if (body !== undefined) { options.method = 'POST'; headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
  const response = await fetch(origin + '/oneword/api' + route, options);
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
}
const bearer = () => ({ Authorization: 'Bearer ' + nativeToken });
before(start);
after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });

test('web registration creates a hashed password and HttpOnly session without exposing a token', async () => {
  const { response, data } = await request('/auth/register', { username: 'Learner.Test', password });
  assert.equal(response.status, 201);
  assert.equal(data.user.username, 'learner.test');
  assert.equal(data.token, undefined);
  user = data.user;
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\/oneword\/api/);
  cookie = setCookie.split(';')[0];
  const session = await request('/auth/session', undefined, { Cookie: cookie });
  assert.equal(session.response.status, 200);
  assert.deepEqual(session.data.user, user);
  const db = new Database(dbPath, { readonly: true });
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(user.id);
  assert.equal(account.password_hash.length, 128);
  assert.notEqual(account.password_hash, password);
  assert.equal(account.salt.length, 32);
  const stored = db.prepare('SELECT token_hash FROM sessions WHERE user_id=?').get(user.id);
  assert.notEqual(stored.token_hash, cookie.split('=')[1]);
  assert.equal(stored.token_hash.length, 64);
  db.close();
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
});

test('credentials validate length, normalize usernames and reject wrong passwords safely', async () => {
  for (const username of ['ab', '../bad', '词友', 'a'.repeat(33)]) {
    assert.equal((await request('/auth/register', { username, password })).response.status, 400);
  }
  assert.equal((await request('/auth/register', { username: 'newuser', password: 'short' })).response.status, 400);
  assert.equal((await request('/auth/register', { username: 'LEARNER.TEST', password })).response.status, 409);
  const wrong = await request('/auth/login', { username: 'learner.test', password: 'wrong-password' });
  const missing = await request('/auth/login', { username: 'missing-user', password: 'wrong-password' });
  assert.equal(wrong.response.status, 401);
  assert.deepEqual(wrong.data, missing.data);
  assert.equal((await request('/auth/session')).response.status, 401);
});

test('a second device logs into the same account with an opaque bearer session', async () => {
  const { response, data } = await request('/auth/login', { username: 'LEARNER.TEST', password, client: 'native' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(data.user, user);
  assert.match(data.token, /^[A-Za-z0-9_-]{43}$/);
  nativeToken = data.token;
  assert.equal((await request('/auth/session', undefined, bearer())).response.status, 200);
  assert.deepEqual((await request('/sync', undefined, bearer())).data, { revision: 0, state: null, bookIds: [], updatedAt: null });
});

test('synchronization persists progress and detects stale revisions without overwriting another device', async () => {
  const state = core.rateWord(core.createState(1700000000000), 'focus', 'known', 1700000001000);
  const result = await request('/sync', { revision: 0, requestId: 'first-device-0001', state, bookIds: [] }, { Cookie: cookie });
  assert.equal(result.response.status, 200);
  firstSnapshot = result.data;
  assert.equal(firstSnapshot.revision, 1);
  assert.deepEqual(firstSnapshot.state.words, state.words);
  assert.deepEqual(firstSnapshot.state.history, []);
  assert.deepEqual((await request('/sync', undefined, bearer())).data, firstSnapshot);
  const conflict = await request('/sync', { revision: 0, requestId: 'second-device-0001', state: core.createState(), bookIds: [] }, bearer());
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.data.error, 'sync_conflict');
  assert.equal(conflict.data.revision, 1);
  assert.deepEqual(conflict.data.state, firstSnapshot.state);
});

test('idempotent retries return the committed result even after a later update', async () => {
  const nextState = core.rateWord(firstSnapshot.state, 'embrace', 'unknown', 1700000003000);
  const update = await request('/sync', { revision: 1, requestId: 'second-device-0002', state: nextState, bookIds: [] }, bearer());
  assert.equal(update.response.status, 200);
  assert.equal(update.data.revision, 2);
  const retry = await request('/sync', { revision: 0, requestId: 'first-device-0001', state: firstSnapshot.state, bookIds: [] }, bearer());
  assert.equal(retry.response.status, 200);
  assert.deepEqual(retry.data, firstSnapshot);
  const reused = await request('/sync', { revision: 1, requestId: 'first-device-0001', state: nextState, bookIds: [] }, bearer());
  assert.equal(reused.response.status, 409);
  assert.equal(reused.data.error, 'request_id_reused');
  assert.equal((await request('/sync', undefined, bearer())).data.revision, 2);
});

test('sync rejects malformed progress, unavailable manifests and unauthorized access', async () => {
  const state = core.createState();
  for (const patch of [
    { bookIds: ['sat'] }, { bookIds: ['../../secret'] }, { bookIds: {} },
    { revision: -1 }, { requestId: 'bad' }, { state: { ...state, words: { malicious: {} } } }
  ]) {
    const result = await request('/sync', { revision: 2, requestId: 'invalid-input-0001', state, bookIds: [], ...patch }, bearer());
    assert.equal(result.response.status, 400);
  }
  assert.equal((await request('/sync', { revision: 0, requestId: 'anonymous-0001', state, bookIds: [] })).response.status, 401);
  const other = await request('/auth/register', { username: 'separate-account', password, client: 'native' });
  const unrelated = await request('/sync', undefined, { Authorization: 'Bearer ' + other.data.token });
  assert.equal(unrelated.data.state, null);
  const mismatchRead = await request('/sync?accountId=' + user.id, undefined, { Authorization: 'Bearer ' + other.data.token });
  assert.equal(mismatchRead.response.status, 403);
  assert.equal(mismatchRead.data.state, undefined);
  const mismatchWrite = await request('/sync', { revision: 0, requestId: 'wrong-account-0001', state, bookIds: [], accountId: user.id }, { Authorization: 'Bearer ' + other.data.token });
  assert.equal(mismatchWrite.response.status, 403);
  assert.equal(mismatchWrite.data.state, undefined);
  for (const route of ['/auth/logout', '/auth/password', '/auth/delete']) {
    const mismatch = await request(route, { accountId: user.id, password, currentPassword: password, newPassword: 'unwanted-password' }, { Authorization: 'Bearer ' + other.data.token });
    assert.equal(mismatch.response.status, 403);
    assert.equal(mismatch.data.error, 'account_changed');
  }
  assert.equal((await request('/auth/session', undefined, { Authorization: 'Bearer ' + other.data.token })).response.status, 200);
});

test('old upload receipts stay idempotent after their large response is compacted', async () => {
  const existing = (await request('/sync', undefined, bearer())).data;
  let current = existing;
  for (let i = 0; i < 9; i += 1) {
    const result = await request('/sync', { revision: current.revision, requestId: 'compact-receipt-' + String(i).padStart(4, '0'), state: current.state, bookIds: current.bookIds }, bearer());
    assert.equal(result.response.status, 200);
    current = result.data;
  }
  const retry = await request('/sync', { revision: 0, requestId: 'first-device-0001', state: firstSnapshot.state, bookIds: [] }, bearer());
  assert.equal(retry.response.status, 200);
  assert.deepEqual(retry.data, current);
  const db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare('SELECT response FROM sync_receipts WHERE user_id=? AND request_id=?').get(user.id, 'first-device-0001').response, '');
  assert.ok(db.prepare("SELECT count(*) count FROM sync_receipts WHERE user_id=? AND response<>''").get(user.id).count <= 8);
  db.close();
});

test('full-book progress restores with its manifest while selected API remains unchanged', async () => {
  const selectedBefore = await request('/books/cet4/words');
  const selectedIds = new Set(vocabulary.words.map(word => word.id));
  const complete = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/full-books/cet4.json'), 'utf8'));
  const id = complete.words.find(word => !selectedIds.has(word.id)).id;
  core.installBook(complete);
  const current = (await request('/sync', undefined, bearer())).data;
  const state = core.rateWord(current.state, id, 'unsure', 1700000005000);
  const missingManifest = await request('/sync', { revision: current.revision, requestId: 'full-missing-0001', state, bookIds: [] }, bearer());
  assert.equal(missingManifest.response.status, 400);
  const accepted = await request('/sync', { revision: current.revision, requestId: 'full-package-0001', state, bookIds: ['cet4'] }, bearer());
  assert.equal(accepted.response.status, 200);
  assert.deepEqual(accepted.data.bookIds, ['cet4']);
  assert.equal(accepted.data.state.words[id].status, 'unsure');
  assert.equal((await request('/books/cet4/words')).data.words.length, selectedBefore.data.words.length);
});

test('cross-site, non-JSON, malformed and oversized writes are rejected', async () => {
  const body = { username: 'learner.test', password };
  assert.equal((await request('/auth/login', body, { Origin: 'https://untrusted.example' })).response.status, 403);
  assert.equal((await request('/auth/login', body, { 'Sec-Fetch-Site': 'cross-site' })).response.status, 403);
  const form = await fetch(origin + '/oneword/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: '' });
  assert.equal(form.status, 415);
  const malformed = await fetch(origin + '/oneword/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer() }, body: '{bad' });
  assert.equal(malformed.status, 400);
  const huge = await request('/sync', { data: 'a'.repeat(5 * 1024 * 1024) }, bearer());
  assert.equal(huge.response.status, 413);
  const secure = await request('/auth/login', body, { 'X-Forwarded-Proto': 'https', Origin: origin.replace('http:', 'https:') });
  assert.equal(secure.response.status, 200);
  assert.match(secure.response.headers.get('set-cookie'), /Secure/);
});

test('the SQLite database keeps sessions and progress across server restarts', async () => {
  const expected = (await request('/sync', undefined, bearer())).data;
  await stop();
  await start();
  const result = await request('/sync', undefined, bearer());
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data, expected);
});

test('logout revokes its session and password change invalidates every old device session', async () => {
  assert.equal((await request('/auth/logout', {}, { Cookie: cookie })).response.status, 204);
  assert.equal((await request('/auth/session', undefined, { Cookie: cookie })).response.status, 401);
  assert.equal((await request('/auth/session', undefined, bearer())).response.status, 200);
  const rejected = await request('/auth/password', { currentPassword: 'wrong-password', newPassword: 'replacement-password' }, bearer());
  assert.equal(rejected.response.status, 401);
  const changed = await request('/auth/password', { currentPassword: password, newPassword: 'replacement-password', client: 'native' }, bearer());
  assert.equal(changed.response.status, 200);
  assert.equal((await request('/auth/session', undefined, bearer())).response.status, 401);
  nativeToken = changed.data.token;
  assert.equal((await request('/auth/session', undefined, bearer())).response.status, 200);
  const oldPassword = await request('/auth/login', { username: 'learner.test', password, client: 'native' });
  assert.equal(oldPassword.response.status, 401);
});

test('deleting an account requires its password and removes cloud progress and all sessions', async () => {
  assert.equal((await request('/auth/delete', { password: 'wrong-password' }, bearer())).response.status, 401);
  assert.equal((await request('/auth/delete', { password: 'replacement-password' }, bearer())).response.status, 204);
  assert.equal((await request('/auth/session', undefined, bearer())).response.status, 401);
  const db = new Database(dbPath, { readonly: true });
  for (const table of ['accounts', 'sessions', 'progress', 'sync_receipts']) {
    const column = table === 'accounts' ? 'id' : 'user_id';
    assert.equal(db.prepare(`SELECT count(*) count FROM ${table} WHERE ${column}=?`).get(user.id).count, 0);
  }
  db.close();
});

test('authentication attempts have a bounded retry limit', async () => {
  const limitedApp = createApp({ authUserLimit: 2 });
  const limitedServer = limitedApp.listen(0, '127.0.0.1');
  await new Promise(resolve => limitedServer.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${limitedServer.address().port}/oneword/api/auth/login`;
    for (const expected of [401, 401, 429]) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'repeated-user', password }) });
      assert.equal(response.status, expected);
      if (expected === 429) assert.equal(response.headers.get('retry-after'), '900');
    }
  } finally { await new Promise(resolve => limitedServer.close(resolve)); limitedApp.locals.closeStore(); }
});

test('account-management attempt limits are isolated by authenticated account', async () => {
  const limitedApp = createApp({ authUserLimit: 2, authIpLimit: 50 });
  const limitedServer = limitedApp.listen(0, '127.0.0.1');
  await new Promise(resolve => limitedServer.once('listening', resolve));
  const url = `http://127.0.0.1:${limitedServer.address().port}/oneword/api`;
  async function post(route, body, token) {
    return fetch(url + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body)
    });
  }
  try {
    const first = await (await post('/auth/register', { username: 'management-first', password, client: 'native' })).json();
    const second = await (await post('/auth/register', { username: 'management-second', password, client: 'native' })).json();
    for (const expected of [401, 401, 429]) {
      assert.equal((await post('/auth/delete', { password: 'wrong-password' }, first.token)).status, expected);
    }
    // The first account's failures must not consume the second account's
    // management allowance, even though neither request includes a username.
    assert.equal((await post('/auth/delete', { password }, second.token)).status, 204);
  } finally { await new Promise(resolve => limitedServer.close(resolve)); limitedApp.locals.closeStore(); }
});
