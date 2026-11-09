'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const storage = new Map()
const calls = []
let bridge
let status = { user: null, phase: 'guest', lastSyncedAt: null }
let schedules = 0
global.wx = {
  getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
  request(options) { calls.push(options); options.success({ statusCode: 200, data: '{"ok":true}' }) },
  showToast: value => calls.push({ toast: value }), showModal: value => calls.push({ modal: value }), getStorageInfoSync: () => ({ currentSize: 10, limitSize: 10240 })
}
const sharedFile = require.resolve('../miniprogram/shared/cloud-client')
require.cache[sharedFile] = { id: sharedFile, filename: sharedFile, loaded: true, exports: { createCloudClient(adapter) {
  bridge = adapter
  return {
    getStatus: () => ({ ...status }), schedule: () => { schedules += 1 },
    init: async () => {}, sync: async () => {}, logout: async () => { status = { user: null, phase: 'guest' }; adapter.onChange(status) },
    authenticate: async (mode, credentials, mergeGuest) => { calls.push({ auth: { mode, credentials, mergeGuest } }); status = { user: { id: 'account-1', username: credentials.username }, phase: 'idle' }; adapter.onChange(status) },
    deleteAccount: async () => {}, changePassword: async () => {}
  }
} } }
const store = require('../miniprogram/utils/store')
const cloud = require('../miniprogram/utils/cloud')

test('native authentication bridge sends bearer credentials through HTTPS and reports invalid responses', async () => {
  cloud.getStatus()
  const result = await bridge.request('POST', '/auth/login', { username: 'user', password: 'password' })
  assert.deepEqual(result, { status: 200, data: { ok: true } })
  const auth = calls.at(-1)
  assert.equal(auth.url, 'https://togetherbetter.cn/oneword/api/auth/login')
  assert.equal(auth.data.client, 'native')
  assert.equal(auth.header.Authorization, undefined)
  await bridge.request('GET', '/sync', undefined, 'opaque-session-token')
  assert.equal(calls.at(-1).header.Authorization, 'Bearer opaque-session-token')
  const request = wx.request
  try {
    wx.request = options => options.success({ statusCode: 200, data: '<html>bad gateway</html>' })
    await assert.rejects(bridge.request('GET', '/sync'), /服务响应/)
    wx.request = options => options.fail({ errMsg: 'offline' })
    await assert.rejects(bridge.request('GET', '/sync'), /本机/)
  } finally { wx.request = request }
})

test('native remote application does not loop into sync and signed-in progress cannot be locally cleared', () => {
  cloud.getStatus()
  const before = schedules
  const wordId = store.vocabulary.books.find(book => book.id === 'cet4').wordIds[0]
  const remote = store.core.rateWord(store.core.createState(), wordId, 'known')
  bridge.setState(remote, 'application-atomic-test')
  assert.equal(store.read().words[wordId].status, 'known')
  assert.equal(schedules, before)
  assert.equal(bridge.getAppliedId(), 'application-atomic-test')
  store.write(store.core.updateSettings(store.read(), { dailyGoal: 30 }))
  assert.equal(schedules, before + 1)
  assert.equal(storage.get(store.KEY)._cloudAppliedId, 'application-atomic-test')
  assert.equal(Object.hasOwn(store.read(), '_cloudAppliedId'), false)
  assert.equal(Object.hasOwn(JSON.parse(store.exportBackup()).state, '_cloudAppliedId'), false)
  status = { user: { id: 'account-1', username: 'user' }, phase: 'idle' }
  assert.throws(() => store.clearAll(), /先退出账号/)
  assert.equal(store.read().settings.dailyGoal, 30)
  status = { user: null, phase: 'guest' }
  store.clearAll()
  assert.equal(store.getAppliedId(), null)
  assert.equal(Object.keys(store.read().words).length, 0)
})

test('native cloud application marker survives a restart and failed writes leave the old state-marker pair intact', () => {
  const script = `
    const assert = require('node:assert/strict');
    const core = require('./miniprogram/shared/core');
    const initial = core.createState();
    const map = new Map([['oneword.state.v1', { ...initial, _cloudAppliedId: 'merge-before-restart' }]]);
    let fail = false;
    global.wx = { getStorageSync: key => map.get(key), setStorageSync(key,value) { if(fail) throw Error('quota'); map.set(key,value); }, removeStorageSync:key=>map.delete(key), showToast(){} };
    const store = require('./miniprogram/utils/store');
    assert.equal(store.getAppliedId(), 'merge-before-restart');
    assert.equal(Object.hasOwn(store.read(), '_cloudAppliedId'), false);
    store.write(core.updateSettings(store.read(), { dailyGoal: 25 }));
    assert.equal(map.get(store.KEY)._cloudAppliedId, 'merge-before-restart');
    fail = true;
    assert.throws(() => store.write(core.updateSettings(store.read(), { dailyGoal: 45 }), 'new-merge-failed'), /存储空间/);
    assert.equal(store.read().settings.dailyGoal, 25);
    assert.equal(store.getAppliedId(), 'merge-before-restart');
    assert.equal(map.get(store.KEY)._cloudAppliedId, 'merge-before-restart');
    fail = false;
    store.write(store.read(), null);
    assert.equal(store.getAppliedId(), null);
    assert.equal(Object.hasOwn(map.get(store.KEY), '_cloudAppliedId'), false);
  `
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('native account-transition recovery installs cached complete books before validating its progress', () => {
  const script = `
    const assert = require('node:assert/strict');
    const core = require('./miniprogram/shared/core');
    const vocabulary = require('./miniprogram/data/vocabulary');
    const payload = require('./data/full-books/primary.json');
    const extra = payload.words.find(word => !vocabulary.wordMap[word.id]);
    assert.ok(extra);
    const initial = core.createState();
    const selectedId = vocabulary.books.find(book => book.id === 'cet4').wordIds[0];
    const sample = core.rateWord(initial, selectedId, 'known');
    const dayKey = Object.keys(sample.daily)[0];
    const target = { ...sample, bookId:'primary', words: { [extra.id]:sample.words[selectedId] }, daily: { [dayKey]: { ...sample.daily[dayKey], newWordIds:[extra.id] } }, history:[] };
    const map = new Map([
      ['oneword.state.v1', initial],
      ['oneword.libraries.v1', ['primary']],
      ['oneword.library.v1.primary', payload],
      ['oneword.cloud.transition.v1', { toIdentity:{ user:{ id:'recovered-account',username:'learner' },token:'native-session-token' },toState:target,removeKeys:[] }]
    ]);
    global.wx = { getStorageSync:key=>map.get(key),setStorageSync:(key,value)=>map.set(key,value),removeStorageSync:key=>map.delete(key),showToast(){} };
    const cloud = require('./miniprogram/utils/cloud');
    const store = require('./miniprogram/utils/store');
    assert.equal(cloud.getStatus().user.id,'recovered-account');
    assert.equal(store.read().words[extra.id].status,'known');
    assert.equal(map.has('oneword.cloud.transition.v1'),false);
    assert.equal(store.getAppliedId(),null);
  `
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('native account form validates credentials, imports guests explicitly and clears password after login', async () => {
  const file = path.join(root, 'miniprogram/pages/profile/profile.js')
  let page
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: createRequire(file), Page: value => { page = value }, wx, Date, setInterval: () => 1, clearInterval() {} }, { filename: file })
  page.data = JSON.parse(JSON.stringify(page.data))
  page.setData = patch => Object.assign(page.data, patch)
  page.onShow()
  page.openAccount()
  page.data.username = 'bad user'
  page.data.password = 'password-123'
  await page.authenticate()
  assert.match(page.data.authError, /账号需为/)
  page.data.username = 'learner_123'
  page.data.mergeGuest = false
  await page.authenticate()
  const auth = calls.findLast(item => item.auth).auth
  assert.equal(auth.mode, 'login')
  assert.equal(auth.mergeGuest, false)
  assert.equal(auth.credentials.username, 'learner_123')
  assert.equal(page.data.password, '')
  assert.equal(page.data.account.user.username, 'learner_123')
  assert.equal(page.data.authBusy, false)
  page.data.password = 'leave-no-password-in-sheet'
  page.onHide()
  assert.equal(page.data.password, '')
})
