'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const os = require('node:os')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')
const mini = path.resolve(__dirname, '../miniprogram')
const storage = new Map()
const calls = []
global.wx = {
  getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
  showToast: value => calls.push(['toast', value]), setNavigationBarTitle: value => calls.push(['title', value]), vibrateShort() {},
  showModal: options => { calls.push(['modal', options]); if (options.success) options.success({ confirm: true }) }, showActionSheet: options => options.success({ tapIndex: 0 }), setClipboardData: options => { calls.push(['clipboard', options.data]); if (options.success) options.success() },
  navigateTo: options => calls.push(['navigate', options.url]), switchTab: options => calls.push(['tab', options.url]), navigateBack: () => calls.push(['back'])
}
const store = require('../miniprogram/utils/store')
function reset(patch) {
  calls.length = 0
  const state = patch ? store.core.updateSettings(store.core.createState(), patch) : store.core.createState()
  store.write(state)
}
function loadPage(name, options) {
  const file = path.join(mini, 'pages', name, name + '.js')
  let page
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: createRequire(file), Page: value => { page = value }, wx: global.wx, Date,
    setTimeout: callback => { callback(); return 1 }, clearTimeout() {}, setInterval: () => 1, clearInterval() {}
  }, { filename: file })
  page.data = JSON.parse(JSON.stringify(page.data))
  page.setData = patch => Object.assign(page.data, patch)
  if (page.onLoad) page.onLoad(options || {})
  return page
}

test('native study persists real ratings, advances the card, and undo restores daily counts', () => {
  reset({ dailyGoal: 5 })
  const page = loadPage('study', { mode: 'today' })
  assert.equal(page.data.total, 5)
  const first = page.data.word.id
  page.rate('known')
  assert.equal(page.data.index, 1)
  assert.equal(store.read().words[first].status, 'known')
  const second = page.data.word.id
  page.rate('unknown')
  assert.equal(store.read().words[second].interval, 5 * 60000)
  assert.equal(store.core.getStats(store.read()).todayAnswers, 2)
  page.undo()
  assert.equal(page.data.word.id, second)
  assert.equal(store.read().words[second], undefined)
  assert.equal(store.core.getStats(store.read()).todayAnswers, 1)
})

test('native recall mode and expanded meanings require an explicit reveal before rating', () => {
  reset({ recallFirst: true, dailyGoal: 5 })
  const page = loadPage('study')
  page.rate('known')
  assert.equal(page.data.index, 0)
  page.reveal()
  page.expand()
  page.rate('known')
  assert.equal(page.data.index, 0)
  page.expand()
  page.rate('known')
  assert.equal(page.data.index, 1)
})

test('native gestures ignore vertical movement, map left to unknown and right to known', () => {
  reset({ dailyGoal: 5 })
  const page = loadPage('study')
  const start = (x, y) => page.touchStart({ touches: [{ clientX: x, clientY: y }] })
  const end = (x, y) => page.touchEnd({ changedTouches: [{ clientX: x, clientY: y }] })
  start(200, 200); end(300, 400)
  assert.equal(page.data.index, 0)
  const first = page.data.word.id
  start(200, 200); end(90, 215)
  assert.equal(store.read().words[first].status, 'unknown')
  const second = page.data.word.id
  start(150, 200); end(260, 210)
  assert.equal(store.read().words[second].status, 'known')
})

test('native completion reports the actual session and undo can reopen the final card', () => {
  reset({ dailyGoal: 1 })
  const page = loadPage('study')
  page.rate('unsure')
  assert.equal(page.data.done, true)
  assert.equal(page.data.sessionCounts.unsure, 1)
  assert.equal(page.data.stats.todayNew, 1)
  page.undo()
  assert.equal(page.data.done, false)
  assert.equal(page.data.stats.todayNew, 0)
})

test('native book switching preserves learned records across books', () => {
  reset()
  const study = loadPage('study')
  study.rate('known')
  const learned = Object.keys(store.read().words)[0]
  const books = loadPage('books')
  books.onShow()
  books.choose({ currentTarget: { dataset: { id: 'gre' } } })
  assert.equal(store.read().bookId, 'gre')
  assert.equal(store.read().words[learned].status, 'known')
  const before = store.read()
  books.choose({ currentTarget: { dataset: { id: 'sat' } } })
  assert.equal(store.read(), before)
})

test('native collections search uses saved statuses and the profile backup restores validated data', async () => {
  reset({ dailyGoal: 5 })
  const study = loadPage('study')
  const first = study.data.word
  study.rate('unknown')
  const collection = loadPage('collections')
  collection.onShow()
  assert.equal(collection.data.total, 1)
  collection.search({ detail: { value: first.word } })
  assert.equal(collection.data.items.length, 1)
  collection.search({ detail: { value: '__no_such_word__' } })
  assert.equal(collection.data.items.length, 0)
  const profile = loadPage('profile')
  profile.onShow()
  profile.exportData()
  const exported = calls.find(call => call[0] === 'clipboard')[1]
  store.write(store.core.createState())
  profile.data.importText = exported
  await profile.restore()
  assert.equal(store.read().words[first.id].status, 'unknown')
  profile.data.importText = '{invalid}'
  await profile.restore()
  assert.ok(profile.data.importError)
  assert.equal(store.read().words[first.id].status, 'unknown')
})

test('native tutorial completion is backed up as a learning setting', () => {
  reset()
  assert.equal(store.tutorialSeen(), false)
  store.finishTutorial()
  assert.equal(store.tutorialSeen(), true)
  assert.equal(JSON.parse(JSON.stringify(store.read())).settings.tutorialComplete, true)
  store.resetTutorial()
  assert.equal(store.tutorialSeen(), false)
})

test('native page files, bound handlers, JSON and module dependencies are complete', () => {
  const app = JSON.parse(fs.readFileSync(path.join(mini, 'app.json'), 'utf8'))
  for (const route of app.pages) {
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) assert.ok(fs.existsSync(path.join(mini, route + ext)), route + ext)
    const page = loadPage(path.basename(route))
    const wxml = fs.readFileSync(path.join(mini, route + '.wxml'), 'utf8')
    for (const match of wxml.matchAll(/(?:bind|catch)(?:tap|input|change|touchstart|touchmove|touchend|touchcancel)="([a-zA-Z_$][\w$]*)"/g)) assert.equal(typeof page[match[1]], 'function', route + ': missing ' + match[1])
    JSON.parse(fs.readFileSync(path.join(mini, route + '.json'), 'utf8'))
  }
  for (const tab of app.tabBar.list) for (const key of ['iconPath', 'selectedIconPath']) assert.ok(fs.existsSync(path.join(mini, tab[key])))
  assert.equal(JSON.parse(fs.readFileSync(path.join(mini, 'project.config.json'), 'utf8')).appid, 'touristappid')
})

const compiler = process.env.WECHAT_COMPILER_PATH || '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec'
test('native WXML and WXSS compile with the actual WeChat compiler', { skip: !fs.existsSync(path.join(compiler, 'wcc')) ? 'WeChat developer tools are not installed on this runner' : false }, () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'oneword-native-'))
  const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)])
  const all = files(mini)
  try {
    for (const [tool, ext] of [['wcc', '.wxml'], ['wcsc', '.wxss']]) {
      const input = all.filter(file => file.endsWith(ext)).map(file => path.relative(mini, file))
      const args = [...(tool === 'wcsc' ? ['-js'] : []), '-o', path.join(output, tool + '.js'), ...input]
      const result = spawnSync(path.join(compiler, tool), args, { cwd: mini, encoding: 'utf8' })
      assert.equal(result.status, 0, (result.stderr || '') + (result.stdout || ''))
    }
  } finally { fs.rmSync(output, { recursive: true, force: true }) }
})


test('native pending hints distinguish short relearning and refresh when the app returns', () => {
  reset({ dailyGoal: 5 })
  const study = loadPage('study')
  study.rate('unknown')
  study.rate('unsure')
  const home = loadPage('index')
  home.onShow()
  assert.equal(home.data.pending.unknown, 1)
  assert.equal(home.data.pending.unsure, 1)
  assert.equal(home.data.pending.count, 2)
  const before = store.read()
  const words = Object.fromEntries(Object.entries(before.words).map(([id, value]) => [id, { ...value, dueAt: Date.now() - 1000, lastReviewedAt: Date.now() - 10000, firstReviewedAt: Date.now() - 10000 }]))
  store.write({ ...before, words })
  home.onShow()
  assert.equal(home.data.pending.count, 0)
  assert.equal(home.data.stats.dueCount, 2)
  study.onShow()
  assert.equal(study.data.stats.dueCount, 2)
  home.onHide(); study.onHide()
})

test('native large values are split below the key limit and a failed replacement preserves the previous value', () => {
  const chunks = require('../miniprogram/utils/storage')
  const originalSet = global.wx.setStorageSync
  chunks.put('native.storage.fixture', { text: '中'.repeat(300000) })
  assert.equal(storage.get('native.storage.fixture')._onewordChunks, 1)
  assert.equal(chunks.get('native.storage.fixture').text.length, 300000)
  const descriptor = storage.get('native.storage.fixture')
  for (const part of descriptor.parts) assert.ok(Buffer.byteLength(storage.get(part), 'utf8') < 1024 * 1024)
  let writes = 0
  global.wx.setStorageSync = (key, value) => { if (++writes === 2) throw new Error('quota'); originalSet(key, value) }
  try { assert.throws(() => chunks.put('native.storage.fixture', { text: '新'.repeat(400000) }), /原记录仍保留/) }
  finally { global.wx.setStorageSync = originalSet }
  assert.equal(chunks.get('native.storage.fixture').text, '中'.repeat(300000))
  assert.equal(storage.get('native.storage.fixture'), descriptor)
  chunks.remove('native.storage.fixture')
})

test('native cold start preserves malformed learning records before allowing fresh saves', () => {
  const script = `const assert=require('node:assert/strict'); const map=new Map(); const key='oneword.state.v1'; const broken={version:1,words:{broken:true},settings:{dailyGoal:'bad'}}; map.set(key,broken); global.wx={getStorageSync:k=>map.get(k),setStorageSync:(k,v)=>map.set(k,v),removeStorageSync:k=>map.delete(k),showToast(){}}; const store=require('./miniprogram/utils/store'); const fresh=store.read(); assert.equal(store.recoveryInfo().available,true); assert.deepEqual(map.get(key+'.recovery').backups[0].data,broken); store.write(fresh); assert.deepEqual(map.get(key+'.recovery').backups[0].data,broken);`
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('native cold start blocks writes when the malformed-record backup cannot be saved', () => {
  const script = `const assert=require('node:assert/strict'); const map=new Map(); const key='oneword.state.v1'; const broken={version:1,words:{broken:true},settings:{dailyGoal:'bad'}}; map.set(key,broken); global.wx={getStorageSync:k=>map.get(k),setStorageSync:(k,v)=>{if(k!==key)throw Error('quota');map.set(k,v)},removeStorageSync:k=>map.delete(k),showToast(){}}; const store=require('./miniprogram/utils/store'); const fresh=store.read(); assert.equal(store.recoveryInfo().blocked,true); assert.throws(()=>store.write(fresh),/暂停写入/); assert.equal(map.get(key),broken);`
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('native destructive clear is confirmed and removes recovery backups while keeping dictionaries', () => {
  reset()
  const profile = loadPage('profile')
  const previousModal = global.wx.showModal
  let modal
  global.wx.showModal = options => { modal = options }
  try {
    profile.clearData()
    assert.match(modal.content, /无法撤销/)
    assert.match(modal.content, /异常记录备份/)
    const before = store.read()
    modal.success({ confirm: false })
    assert.equal(store.read(), before)
    storage.set(store.RECOVERY_KEY, { version: 1, backups: [{ data: 'broken' }] })
    modal.success({ confirm: true })
    assert.equal(store.recoveryInfo().available, false)
  } finally { global.wx.showModal = previousModal }
})

test('native complete book download is validated, cached and included in portable backup metadata', async () => {
  reset()
  const payload = require('../data/full-books/primary.json')
  const oldRequest = global.wx.request
  global.wx.request = options => options.success({ statusCode: 200, data: payload })
  try {
    await store.downloadBook('primary')
    assert.equal(store.vocabulary.books.find(book => book.id === 'primary').edition, 'full')
    assert.equal(store.vocabulary.books.find(book => book.id === 'primary').count, payload.words.length)
    assert.ok(store.getInstalledBookIds().includes('primary'))
    const backup = JSON.parse(store.exportBackup())
    assert.equal(backup.format, 'oneword.backup')
    assert.ok(backup.bookIds.includes('primary'))
    await store.restoreBackup(JSON.stringify(backup))
  } finally { global.wx.request = oldRequest }
})

test('native cold start installs a split complete dictionary before validating learned words', () => {
  const script = `
    const assert = require('node:assert/strict');
    let map = new Map();
    const payload = require('./data/full-books/gre.json');
    const baseIds = new Set(require('./miniprogram/data/vocabulary').words.map(word => word.id));
    const extra = payload.words.find(word => !baseIds.has(word.id));
    assert.ok(extra);
    global.wx = {getStorageSync:k=>map.get(k),setStorageSync:(k,v)=>map.set(k,v),removeStorageSync:k=>map.delete(k),request:options=>options.success({statusCode:200,data:payload}),showToast(){}};
    (async()=>{
      let store = require('./miniprogram/utils/store');
      await store.downloadBook('gre');
      store.write(store.core.rateWord(store.core.setBook(store.read(),'gre'),extra.id,'known'));
      assert.equal(map.get('oneword.library.v1.gre')._onewordChunks,1);
      map = new Map(JSON.parse(JSON.stringify([...map])));
      for(const entry of ['./miniprogram/utils/store','./miniprogram/utils/storage','./miniprogram/shared/core','./miniprogram/data/vocabulary'])delete require.cache[require.resolve(entry)];
      store = require('./miniprogram/utils/store');
      const restored=store.read();
      assert.equal(restored.words[extra.id].status,'known');
      assert.equal(restored.bookId,'gre');
      assert.equal(store.currentBook().count,payload.words.length);
      assert.equal(store.recoveryInfo().available,false);
    })().catch(error=>{console.error(error);process.exitCode=1});
  `
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('native portable backup downloads a missing complete book before replacing local progress', () => {
  const script = `
    const assert = require('node:assert/strict');
    let map = new Map();let requests=0;
    const payload = require('./data/full-books/cet6.json');
    const baseIds = new Set(require('./miniprogram/data/vocabulary').words.map(word=>word.id));
    const extra=payload.words.find(word=>!baseIds.has(word.id));
    global.wx={getStorageSync:k=>map.get(k),setStorageSync:(k,v)=>map.set(k,v),removeStorageSync:k=>map.delete(k),request:options=>{requests++;options.success({statusCode:200,data:payload})},showToast(){}};
    (async()=>{
      let store=require('./miniprogram/utils/store');
      await store.downloadBook('cet6');
      store.write(store.core.rateWord(store.core.setBook(store.read(),'cet6'),extra.id,'unsure'));
      const backup=store.exportBackup();
      map=new Map();
      for(const entry of ['./miniprogram/utils/store','./miniprogram/utils/storage','./miniprogram/shared/core','./miniprogram/data/vocabulary'])delete require.cache[require.resolve(entry)];
      store=require('./miniprogram/utils/store');
      assert.deepEqual(store.inspectBackup(backup).requiredBookIds,['cet6']);
      await store.restoreBackup(backup);
      assert.equal(requests,2);
      assert.equal(store.read().words[extra.id].status,'unsure');
      assert.equal(store.currentBook().edition,'full');
      // Legacy pure-state exports remain supported on an installed device.
      await store.restoreBackup(JSON.stringify(store.read()));
      assert.equal(requests,2);
    })().catch(error=>{console.error(error);process.exitCode=1});
  `
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('native complete dictionary index quota failure keeps progress and reclaims the staged download', async () => {
  reset()
  const before = store.read()
  const oldRequest = global.wx.request
  const oldSet = global.wx.setStorageSync
  const payload = require('../data/full-books/toefl.json')
  global.wx.request = options => options.success({ statusCode: 200, data: payload })
  global.wx.setStorageSync = (key, value) => { if (key === 'oneword.libraries.v1') throw new Error('quota'); oldSet(key, value) }
  try {
    await assert.rejects(store.downloadBook('toefl'), /原记录仍保留/)
    assert.equal(store.read(), before)
    assert.equal(store.getInstalledBookIds().includes('toefl'), false)
    assert.equal(store.vocabulary.books.find(book => book.id === 'toefl').edition, 'selected')
    assert.equal([...storage.keys()].some(key => key.startsWith('oneword.library.v1.toefl')), false)
  } finally { global.wx.request = oldRequest; global.wx.setStorageSync = oldSet }
})

test('native unsupported backup envelope fails without replacing current learning data', async () => {
  reset()
  const before = store.read()
  await assert.rejects(store.restoreBackup(JSON.stringify({ format: 'oneword.backup', version: 2, state: before, bookIds: [] })), /版本暂不支持/)
  assert.equal(store.read(), before)
})

test('native goal picker preserves a valid custom daily goal restored from another client', () => {
  reset({ dailyGoal: 3 })
  const profile = loadPage('profile')
  profile.onShow()
  assert.equal(profile.data.goalOptions[profile.data.goalIndex], 3)
  profile.onHide()
})

test('native home and profile learning-order pickers preserve progress and expose the saved choice', () => {
  reset({ dailyGoal: 5 })
  const study = loadPage('study')
  const learnedId = study.data.word.id
  study.rate('unknown')
  const originalProgress = JSON.stringify(store.read().words[learnedId])
  const home = loadPage('index')
  home.onShow()
  assert.equal(home.data.orderLabel, '记忆优先')
  const alphabeticalIndex = home.data.orderOptions.findIndex(order => order.id === 'alphabetical')
  home.learningOrder({ detail: { value: String(alphabeticalIndex) } })
  assert.equal(store.read().settings.learningOrder, 'alphabetical')
  assert.equal(home.data.orderLabel, '字母顺序')
  assert.equal(JSON.stringify(store.read().words[learnedId]), originalProgress)
  assert.equal(store.read().settings.recallFirst, false)
  const profile = loadPage('profile')
  profile.onShow()
  assert.equal(profile.data.orderOptions[profile.data.orderIndex].id, 'alphabetical')
  assert.match(profile.data.orderDescription, /A.Z|字母/)
  const randomIndex = profile.data.orderOptions.findIndex(order => order.id === 'random')
  profile.learningOrder({ detail: { value: String(randomIndex) } })
  assert.equal(store.read().settings.learningOrder, 'random')
  home.onShow()
  assert.equal(home.data.orderLabel, '随机顺序')
  const before = store.read()
  profile.learningOrder({ detail: { value: '999' } })
  home.learningOrder({ detail: { value: '-1' } })
  assert.equal(store.read(), before)
  home.onHide(); profile.onHide()
})

test('native study captures the current learning order until the next group starts', () => {
  reset({ dailyGoal: 5, learningOrder: 'alphabetical' })
  const study = loadPage('study')
  const initialIds = Array.from(study.queue, word => word.id)
  const sortedIds = initialIds.slice().sort((a, b) => a.localeCompare(b))
  assert.deepEqual(initialIds, sortedIds)
  assert.equal(study.data.orderLabel, '字母顺序')
  const profile = loadPage('profile')
  profile.onShow()
  profile.learningOrder({ detail: { value: profile.data.orderOptions.findIndex(order => order.id === 'random') } })
  study.onShow()
  assert.equal(store.read().settings.learningOrder, 'random')
  assert.equal(study.data.orderId, 'alphabetical')
  assert.equal(study.data.orderLabel, '字母顺序')
  assert.deepEqual(Array.from(study.queue, word => word.id), initialIds)
  study.nextGroup()
  assert.equal(study.data.orderId, 'random')
  assert.equal(study.data.orderLabel, '随机顺序')
  const randomIds = Array.from(study.queue, word => word.id)
  const resumed = loadPage('study')
  assert.deepEqual(Array.from(resumed.queue, word => word.id), randomIds)
  assert.equal(new Set(randomIds).size, randomIds.length)
  study.onHide(); profile.onHide()
})

test('native learning-order preference survives portable backup restore and old backups use memory priority', async () => {
  reset({ learningOrder: 'random', dailyGoal: 5, recallFirst: true })
  const backup = store.exportBackup()
  store.write(store.core.createState())
  await store.restoreBackup(backup)
  assert.equal(store.read().settings.learningOrder, 'random')
  assert.equal(store.read().settings.recallFirst, true)
  const profile = loadPage('profile')
  profile.onShow()
  assert.equal(profile.data.orderOptions[profile.data.orderIndex].id, 'random')
  const legacy = JSON.parse(JSON.stringify(store.read()))
  delete legacy.settings.learningOrder
  await store.restoreBackup(JSON.stringify(legacy))
  assert.equal(store.read().settings.learningOrder, 'adaptive')
  const home = loadPage('index')
  home.onShow()
  assert.equal(home.data.orderLabel, '记忆优先')
  profile.onHide(); home.onHide()
})
