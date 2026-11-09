'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/core');
const { createCloudClient } = require('../shared/cloud-client');
const { sameState } = require('../shared/sync');
const { books } = require('../data/vocabulary');
const now = new Date(2026, 10, 9, 12).getTime();
const ids = books.find(book => book.id === 'cet4').wordIds;
const day = core.dateKey(now);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const IDENTITY = 'oneword.cloud.identity.v1';
const META = 'oneword.cloud.meta.v1.';
const ACCOUNT = 'oneword.cloud.account.v1.';

function fakeServer() {
  const accounts = new Map();
  const tokens = new Map();
  const calls = [];
  let count = 0;
  const service = {
    accounts, calls, before: null, after: null,
    add(username, state = null) {
      const account = { user: { id: 'account-' + (++count), username }, password: 'password123', snapshot: { revision: state ? 1 : 0, state: clone(state), bookIds: [], updatedAt: state ? now : null }, receipts: new Map() };
      accounts.set(username, account);
      return account;
    },
    session(account) {
      const token = 'token-' + account.user.id + '-' + tokens.size;
      tokens.set(token, account);
      return { user: clone(account.user), token };
    },
    async request(method, path, body, token) {
      const url = new URL(path, 'https://example.test');
      const route = url.pathname;
      const call = { method, path, route, body: clone(body), token };
      calls.push(call);
      if (service.before) await service.before(call);
      let response;
      let account = tokens.get(token);
      if (route === '/auth/register' || route === '/auth/login') {
        account = accounts.get(body.username);
        if (route === '/auth/register' && account) response = { status: 409, data: { error: 'username_taken', message: '这个用户名已被使用，请换一个' } };
        else if (route === '/auth/login' && (!account || account.password !== body.password)) response = { status: 401, data: { error: 'invalid_credentials', message: '用户名或密码不正确' } };
        else {
          if (!account) account = service.add(body.username);
          response = { status: route === '/auth/register' ? 201 : 200, data: service.session(account) };
        }
      } else if (route === '/auth/logout') {
        tokens.delete(token); response = { status: 204 };
      } else if (!account) response = { status: 401, data: { error: 'login_required', message: '请登录后同步学习记录' } };
      else if (route === '/auth/session') response = { status: 200, data: { user: clone(account.user) } };
      else if (route === '/auth/delete') { accounts.delete(account.user.username); tokens.delete(token); response = { status: 204 }; }
      else if (route === '/auth/password') {
        account.password = body.newPassword;
        for (const [key, value] of tokens) if (value === account) tokens.delete(key);
        response = { status: 200, data: { user: clone(account.user) } };
      } else if (route === '/sync') {
        const expected = method === 'GET' ? url.searchParams.get('accountId') : body.accountId;
        if (expected !== account.user.id) response = { status: 403, data: { error: 'account_mismatch', message: '其他页面已切换账号，请重新登录' } };
        else if (method === 'GET') response = { status: 200, data: clone(account.snapshot) };
        else if (account.receipts.has(body.requestId)) response = { status: 200, data: clone(account.receipts.get(body.requestId)) };
        else if (body.revision !== account.snapshot.revision) response = { status: 409, data: { error: 'sync_conflict', ...clone(account.snapshot) } };
        else {
          account.snapshot = { revision: account.snapshot.revision + 1, state: clone(body.state), bookIds: clone(body.bookIds), updatedAt: now + account.snapshot.revision + 1 };
          account.receipts.set(body.requestId, clone(account.snapshot));
          response = { status: 200, data: clone(account.snapshot) };
        }
      } else throw new Error('unhandled fake route ' + route);
      if (service.after) await service.after(call, response);
      return response;
    }
  };
  return service;
}

function device(t, server, options = {}) {
  const values = options.values || new Map();
  let state = clone(options.state || core.createState(now));
  let appliedId = options.appliedId || null;
  let setCount = 0;
  const storage = {
    get: key => clone(values.get(key)),
    put(key, value) { if (options.beforePut) options.beforePut(key, value); values.set(key, clone(value)); },
    remove: key => values.delete(key)
  };
  if (options.identity) values.set(IDENTITY, clone(options.identity));
  const client = createCloudClient({ storage, request: (...args) => server.request(...args), getState: () => state,
    setState(next, marker) { state = clone(next); if (marker !== undefined) appliedId = marker; setCount++; if (options.afterSet) options.afterSet(next); },
    getAppliedId: () => appliedId,
    getBookIds: () => options.bookIds || [], prepareBooks: async ids => { if (options.prepare) await options.prepare(ids); },
    onChange: options.onChange });
  t.after(() => client.destroy());
  return { client, values, storage, state: () => state, setState: next => { state = next; }, setCount: () => setCount, appliedId: () => appliedId };
}

test('registration imports guest progress and a fresh phone restores it with cloud preferences', async t => {
  const server = fakeServer();
  const guest = core.updateSettings(core.rateWord(core.createState(now), ids[0], 'unknown', now), { learningOrder: 'random', dailyGoal: 12 });
  const first = device(t, server, { state: guest });
  await first.client.authenticate('register', { username: 'alice', password: 'password123' }, true);
  assert.equal(server.accounts.get('alice').snapshot.state.settings.dailyGoal, 12);
  const second = device(t, server);
  await second.client.authenticate('login', { username: 'alice', password: 'password123' }, true);
  assert.equal(sameState(second.state(), guest), true);
  assert.equal(second.client.getStatus().phase, 'idle');
  assert.equal(server.calls.filter(call => call.method === 'POST' && call.route === '/sync').length, 1);
});

test('registration conflicts display the Chinese server message and do not activate a malformed identity', async t => {
  const server = fakeServer(); server.add('alice');
  const local = device(t, server);
  await assert.rejects(local.client.authenticate('register', { username: 'alice', password: 'password123' }, false), /这个用户名已被使用/);
  assert.equal(local.client.getStatus().user, null);
  assert.equal(local.values.has(IDENTITY), false);
});

test('response loss retries the exact durable request without counting its answers twice', async t => {
  const server = fakeServer();
  const account = server.add('alice', core.createState(now));
  const identity = server.session(account);
  const local = device(t, server, { identity, state: account.snapshot.state });
  await local.client.sync();
  local.setState(core.rateWord(local.state(), ids[0], 'known', now));
  let lose = true;
  server.after = call => { if (lose && call.method === 'POST' && call.route === '/sync') { lose = false; throw new Error('lost response'); } };
  assert.equal(await local.client.sync(), false);
  const pending = local.values.get(META + account.user.id).pending;
  assert.ok(pending.requestId);
  assert.equal(account.snapshot.state.daily[day].answerCount, 1);
  await local.client.sync();
  assert.equal(local.state().daily[day].answerCount, 1);
  assert.equal(account.snapshot.state.daily[day].answerCount, 1);
  const posts = server.calls.filter(call => call.method === 'POST' && call.route === '/sync');
  assert.equal(posts[0].body.requestId, posts[1].body.requestId);
  assert.equal(local.values.get(META + account.user.id).pending, null);
});

test('an idempotent retry uses the original local baseline after its submitted snapshot already includes remote changes', async t => {
  const server = fakeServer();
  const base = core.createState(now);
  const account = server.add('alice', base);
  const identity = server.session(account);
  const local = device(t, server, { identity, state: base });
  await local.client.sync();
  local.setState(core.rateWord(base, ids[0], 'known', now));
  account.snapshot = { ...account.snapshot, revision: account.snapshot.revision + 1, state: core.rateWord(base, ids[1], 'unknown', now) };
  let lose = true;
  server.after = call => { if (lose && call.method === 'POST' && call.route === '/sync') { lose = false; throw new Error('lost'); } };
  await local.client.sync();
  local.setState(core.rateWord(local.state(), ids[2], 'unsure', now + 1000));
  await local.client.sync();
  assert.equal(local.state().daily[day].answerCount, 3);
  assert.equal(account.snapshot.state.daily[day].answerCount, 3);
  assert.deepEqual(Object.keys(local.state().words).sort(), [ids[0], ids[1], ids[2]].sort());
});

test('a crash after applying cloud state but before clearing pending cannot double-count the daily merge', async t => {
  const server = fakeServer();
  const base = core.createState(now);
  const account = server.add('alice', base);
  const identity = server.session(account);
  let crash = false;
  const local = device(t, server, { identity, state: base, beforePut(key, value) {
    if (crash && key === META + account.user.id && !value.pending) throw new Error('simulated storage failure');
  } });
  await local.client.sync();
  local.setState(core.rateWord(base, ids[0], 'known', now));
  account.snapshot = { ...account.snapshot, revision: 2, state: core.rateWord(base, ids[1], 'unknown', now) };
  crash = true;
  await local.client.sync();
  assert.equal(local.state().daily[day].answerCount, 2);
  assert.ok(local.values.get(META + account.user.id).pending.application);
  local.client.destroy();
  const restarted = device(t, server, { state: local.state(), values: local.values });
  await restarted.client.sync();
  assert.equal(restarted.state().daily[day].answerCount, 2);
  assert.equal(account.snapshot.state.daily[day].answerCount, 2);
});

test('learning during an in-flight request survives and is uploaded once on the next sync', async t => {
  const server = fakeServer(); const base = core.createState(now);
  const account = server.add('alice', base);
  const local = device(t, server, { identity: server.session(account), state: base });
  await local.client.sync();
  local.setState(core.rateWord(base, ids[0], 'known', now));
  let unblock, started;
  const waiting = new Promise(resolve => { started = resolve; });
  server.before = async call => { if (call.method === 'POST' && call.route === '/sync') { server.before = null; started(); await new Promise(resolve => { unblock = resolve; }); } };
  const syncing = local.client.sync();
  await waiting;
  local.setState(core.rateWord(local.state(), ids[1], 'unsure', now + 1000));
  unblock(); await syncing;
  assert.equal(local.state().daily[day].answerCount, 2);
  await local.client.sync();
  assert.equal(account.snapshot.state.daily[day].answerCount, 2);
});

test('409 compare-and-swap retries retain the original local baseline', async t => {
  const server = fakeServer(); const base = core.createState(now);
  const account = server.add('alice', base);
  const local = device(t, server, { identity: server.session(account), state: base });
  await local.client.sync();
  local.setState(core.rateWord(base, ids[0], 'known', now));
  server.before = call => {
    if (call.method === 'POST' && call.route === '/sync') {
      server.before = null;
      account.snapshot = { ...account.snapshot, revision: account.snapshot.revision + 1, state: core.rateWord(base, ids[1], 'unknown', now) };
    }
  };
  await local.client.sync();
  assert.equal(account.snapshot.state.daily[day].answerCount, 2);
  assert.equal(local.state().daily[day].answerCount, 2);
  assert.equal(server.calls.filter(call => call.method === 'POST' && call.route === '/sync').length, 2);
});

test('an idle sync preserves undo, and a settings-only merge preserves undo history', async t => {
  const server = fakeServer();
  const state = core.rateWord(core.createState(now), ids[0], 'known', now);
  const account = server.add('alice', state);
  const local = device(t, server, { identity: server.session(account), state });
  await local.client.sync();
  assert.deepEqual(local.state().history, state.history);
  assert.equal(local.setCount(), 0);
  account.snapshot = { ...account.snapshot, revision: 2, state: core.updateSettings(account.snapshot.state, { learningOrder: 'random' }) };
  await local.client.sync();
  assert.deepEqual(local.state().history, state.history);
  assert.equal(local.state().settings.learningOrder, 'random');
});

test('account switching and logout isolate each account from guest and other account progress', async t => {
  const server = fakeServer();
  const alice = server.add('alice', core.rateWord(core.createState(now), ids[0], 'known', now));
  const bob = server.add('bob', core.rateWord(core.createState(now), ids[1], 'unsure', now));
  const guest = core.rateWord(core.createState(now), ids[2], 'unknown', now);
  const local = device(t, server, { state: guest });
  await local.client.authenticate('login', { username: 'alice', password: 'password123' }, false);
  assert.deepEqual(Object.keys(local.state().words), [ids[0]]);
  await local.client.authenticate('login', { username: 'bob', password: 'password123' }, true);
  assert.deepEqual(Object.keys(local.state().words), [ids[1]]);
  assert.equal(Object.keys(bob.snapshot.state.words).length, 1);
  assert.equal(Object.keys(alice.snapshot.state.words).length, 1);
  await local.client.logout();
  assert.equal(sameState(local.state(), guest), true);
  assert.equal(local.client.getStatus().user, null);
  assert.ok(local.values.has(ACCOUNT + alice.user.id));
  assert.ok(local.values.has(ACCOUNT + bob.user.id));
});

test('a failed post-login activation pauses sync instead of uploading an old account into a new cookie session', async t => {
  const server = fakeServer();
  const alice = server.add('alice', core.createState(now)); server.add('bob');
  const local = device(t, server, { identity: server.session(alice), state: alice.snapshot.state });
  await local.client.sync();
  server.before = call => { if (call.route === '/sync' && call.method === 'GET') throw new Error('offline'); };
  await assert.rejects(local.client.authenticate('login', { username: 'bob', password: 'password123' }, false), /离线/);
  const count = server.calls.length;
  assert.equal(await local.client.sync(), false);
  assert.equal(server.calls.length, count);
  assert.equal(local.client.getStatus().phase, 'expired');
  assert.equal(local.client.getStatus().user.id, alice.user.id);
});

test('another browser tab switching the durable identity blocks stale uploads', async t => {
  const server = fakeServer();
  const alice = server.add('alice', core.createState(now)); const bob = server.add('bob');
  const local = device(t, server, { identity: server.session(alice), state: alice.snapshot.state });
  local.values.set(IDENTITY, server.session(bob));
  local.setState(core.rateWord(local.state(), ids[0], 'known', now));
  assert.equal(await local.client.sync(), false);
  local.client.schedule();
  assert.equal(server.calls.length, 0);
  assert.equal(local.client.getStatus().phase, 'expired');
  assert.match(local.client.getStatus().message, /其他页面已切换账号/);
});

test('a subscription exception never aborts synchronization', async t => {
  const server = fakeServer(); const account = server.add('alice');
  const local = device(t, server, { identity: server.session(account), onChange() { throw new Error('render failed'); } });
  assert.equal(await local.client.sync(), true);
  assert.equal(account.snapshot.revision, 1);
});

test('password changes require reauthentication while preserving offline account data', async t => {
  const server = fakeServer();
  const state = core.rateWord(core.createState(now), ids[0], 'known', now);
  const account = server.add('alice', state);
  const local = device(t, server, { identity: server.session(account), state });
  await local.client.changePassword('password123', 'newpassword123');
  assert.equal(local.client.getStatus().phase, 'expired');
  assert.equal(sameState(local.state(), state), true);
  const count = server.calls.length;
  assert.equal(await local.client.sync(), false);
  assert.equal(server.calls.length, count);
  await local.client.authenticate('login', { username: 'alice', password: 'newpassword123' }, false);
  assert.equal(local.client.getStatus().phase, 'idle');
});

test('origin-wide synchronization lock prevents shared-tab daily deltas from being uploaded twice', async t => {
  const server = fakeServer(); const base = core.createState(now);
  const account = server.add('alice', base);
  const identity = server.session(account);
  const values = new Map([[IDENTITY, clone(identity)], [META + account.user.id, { base: clone(account.snapshot), pending: null }]]);
  let state = core.rateWord(base, ids[0], 'known', now);
  let lock = Promise.resolve();
  const withSyncLock = operation => {
    const next = lock.then(operation, operation);
    lock = next.catch(() => {});
    return next;
  };
  const createTab = () => {
    const client = createCloudClient({
      storage: { get: key => clone(values.get(key)), put: (key, value) => values.set(key, clone(value)), remove: key => values.delete(key) },
      request: (...args) => server.request(...args), getState: () => clone(state), setState: next => { state = clone(next); },
      getBookIds: () => [], prepareBooks: async () => {}, withSyncLock
    });
    t.after(() => client.destroy());
    return client;
  };
  const tabA = createTab(); const tabB = createTab();
  await Promise.all([tabA.sync(), tabB.sync()]);
  assert.equal(account.snapshot.state.daily[day].answerCount, 1);
  assert.equal(state.daily[day].answerCount, 1);
  assert.equal(server.calls.filter(call => call.method === 'POST' && call.route === '/sync').length, 1);
});

test('a local snapshot already equal to cloud does not manufacture a second daily delta from an older base', async t => {
  const server = fakeServer(); const base = core.createState(now);
  const reviewed = core.rateWord(base, ids[0], 'known', now);
  const account = server.add('alice', reviewed);
  const local = device(t, server, { identity: server.session(account), state: reviewed });
  local.values.set(META + account.user.id, { base: { revision: 0, state: base, bookIds: [] }, pending: null });
  await local.client.sync();
  assert.equal(local.state().daily[day].answerCount, 1);
  assert.equal(account.snapshot.state.daily[day].answerCount, 1);
  assert.equal(server.calls.filter(call => call.method === 'POST' && call.route === '/sync').length, 0);
});

test('scheduled local changes report pending until the cloud acknowledges them', async t => {
  const server = fakeServer(); const account = server.add('alice', core.createState(now));
  const local = device(t, server, { identity: server.session(account), state: account.snapshot.state });
  await local.client.sync();
  local.setState(core.rateWord(local.state(), ids[0], 'known', now));
  local.client.schedule();
  assert.equal(local.client.getStatus().phase, 'pending');
  assert.match(local.client.getStatus().message, /等待同步/);
});

test('an interrupted account transition recovers its matching identity before any cloud upload', async t => {
  const server = fakeServer();
  const alice = server.add('alice', core.rateWord(core.createState(now), ids[0], 'known', now));
  const bob = server.add('bob', core.rateWord(core.createState(now), ids[1], 'unsure', now));
  let crash = false;
  const local = device(t, server, { identity: server.session(alice), state: alice.snapshot.state,
    beforePut(key, value) { if (crash && key === IDENTITY && value.user.id === bob.user.id) throw new Error('interrupted identity write'); } });
  await local.client.sync();
  crash = true;
  await assert.rejects(local.client.authenticate('login', { username: 'bob', password: 'password123' }, false), /interrupted identity write/);
  assert.ok(local.values.has('oneword.cloud.transition.v1'));
  assert.equal(local.values.get(IDENTITY).user.id, alice.user.id);
  assert.deepEqual(Object.keys(local.state().words), [ids[1]]);
  const requestCount = server.calls.length;
  assert.equal(await local.client.sync(), false);
  assert.equal(server.calls.length, requestCount);
  local.client.destroy();
  const restarted = device(t, server, { state: local.state(), values: local.values });
  await restarted.client.sync();
  assert.equal(restarted.client.getStatus().user.id, bob.user.id);
  assert.deepEqual(Object.keys(alice.snapshot.state.words), [ids[0]]);
  assert.deepEqual(Object.keys(bob.snapshot.state.words), [ids[1]]);
  assert.equal(restarted.values.has('oneword.cloud.transition.v1'), false);
});

test('an interrupted logout restores guest progress and clears account identity before networking', async t => {
  const server = fakeServer();
  const alice = server.add('alice', core.rateWord(core.createState(now), ids[0], 'known', now));
  const guest = core.rateWord(core.createState(now), ids[2], 'unknown', now);
  const local = device(t, server, { state: guest });
  await local.client.authenticate('login', { username: 'alice', password: 'password123' }, false);
  let crash = true;
  const remove = local.storage.remove;
  local.storage.remove = key => { if (crash && key === IDENTITY) throw new Error('interrupted logout'); return remove(key); };
  await assert.rejects(local.client.logout(), /interrupted logout/);
  assert.equal(sameState(local.state(), guest), true);
  assert.ok(local.values.has('oneword.cloud.transition.v1'));
  local.client.destroy(); crash = false;
  const requestCount = server.calls.length;
  const restarted = device(t, server, { state: local.state(), values: local.values });
  assert.equal(await restarted.client.sync(), false);
  assert.equal(server.calls.length, requestCount);
  assert.equal(restarted.client.getStatus().user, null);
  assert.equal(sameState(restarted.state(), guest), true);
  assert.deepEqual(Object.keys(alice.snapshot.state.words), [ids[0]]);
});

test('an answer made after applied-state persistence but failed pending cleanup is not counted twice after restart', async t => {
  const server = fakeServer(); const base = core.createState(now);
  const account = server.add('alice', base);
  let failCleanup = false;
  const local = device(t, server, { identity: server.session(account), state: base, beforePut(key, value) {
    if (failCleanup && key === META + account.user.id && !value.pending) throw new Error('disk full during pending cleanup');
  } });
  await local.client.sync();
  local.setState(core.rateWord(base, ids[0], 'known', now));
  account.snapshot = { ...account.snapshot, revision: 2, state: core.rateWord(base, ids[1], 'unknown', now) };
  failCleanup = true;
  await local.client.sync();
  assert.equal(local.state().daily[day].answerCount, 2);
  assert.equal(local.appliedId(), local.values.get(META + account.user.id).pending.application.id);
  local.setState(core.rateWord(local.state(), ids[2], 'unsure', now + 1000));
  local.client.destroy();
  const restarted = device(t, server, { state: local.state(), values: local.values, appliedId: local.appliedId() });
  await restarted.client.sync();
  assert.equal(restarted.state().daily[day].answerCount, 3);
  assert.equal(account.snapshot.state.daily[day].answerCount, 3);
});
