const core = require('../shared/core')
const vocabulary = require('../data/vocabulary')
const storage = require('./storage')
const config = require('../config')
const KEY = 'oneword.state.v1'
const RECOVERY_KEY = KEY + '.recovery'
const LIBRARY_INDEX_KEY = 'oneword.libraries.v1'
const LIBRARY_PREFIX = 'oneword.library.v1.'
let librariesLoaded = false
let installedBookIds = []
let cached = null
let recoveryBlocked = false
let loadWarning = ''
function read() {
  if (cached) return cached
  ensureLibraries()
  let saved
  try {
    saved = storage.get(KEY)
    cached = saved ? core.restoreState(saved) : core.createState()
  }
  catch (error) {
    // Preserve the exact unreadable value before allowing a fresh record to be
    // saved. Repeated corruptions append backups instead of replacing one.
    try {
      const existing = storage.get(RECOVERY_KEY)
      const backups = existing && Array.isArray(existing.backups) ? existing.backups.slice() : existing ? [{ recordedAt: Date.now(), reason: '旧版异常备份', data: existing }] : []
      backups.push({ recordedAt: Date.now(), reason: error.message || '记录格式异常', data: saved === undefined ? storage.original(KEY) : saved })
      storage.put(RECOVERY_KEY, { version: 1, backups })
      loadWarning = '旧记录暂时无法读取，原始内容已保留。可在「我的 → 数据与备份」导出。'
    } catch (_) {
      recoveryBlocked = true
      loadWarning = '旧记录无法读取，且存储空间不足以保留备份。已暂停写入，原记录仍保留。'
    }
    cached = core.createState()
  }
  return cached
}
function write(state) {
  if (recoveryBlocked) throw new Error('为保留原始记录，当前已暂停写入。请释放存储空间后重启微信。')
  storage.put(KEY, state)
  cached = state
  return state
}
function recoveryInfo() {
  read()
  let backup = null
  try { backup = storage.get(RECOVERY_KEY) } catch (_) {}
  const count = backup && Array.isArray(backup.backups) ? backup.backups.length : backup ? 1 : 0
  return { available: count > 0, count, blocked: recoveryBlocked, warning: loadWarning }
}
function recoveryJSON() {
  const backup = storage.get(RECOVERY_KEY)
  if (!backup) throw new Error('没有可导出的异常记录备份')
  return JSON.stringify(backup, null, 2)
}
function clearAll() {
  const fresh = core.createState()
  storage.put(KEY, fresh)
  cached = fresh
  storage.remove(RECOVERY_KEY)
  recoveryBlocked = false
  loadWarning = ''
  return fresh
}
function ensureLibraries() {
  if (librariesLoaded) return
  librariesLoaded = true
  let ids = []
  try { ids = storage.get(LIBRARY_INDEX_KEY) || [] } catch (_) {}
  if (!Array.isArray(ids)) return
  ids.forEach(id => {
    if (!vocabulary.books.some(book => book.id === id && book.available)) return
    try {
      const payload = storage.get(LIBRARY_PREFIX + id)
      if (payload && typeof core.installBook === 'function') { core.installBook(payload); installedBookIds.push(id) }
    } catch (_) { loadWarning = '有一份完整词库缓存无法读取，已保留原内容。可在词书页重新下载。' }
  })
}
function getInstalledBookIds() { ensureLibraries(); return installedBookIds.slice() }
function storageUsage() {
  try {
    const info = wx.getStorageInfoSync()
    return { used: (info.currentSize / 1024).toFixed(1), limit: (info.limitSize / 1024).toFixed(0) }
  } catch (_) { return null }
}
function downloadBook(id) {
  ensureLibraries()
  if (!vocabulary.books.some(book => book.id === id && book.available)) return Promise.reject(new Error('这本完整词库暂不可用'))
  if (installedBookIds.includes(id)) return Promise.resolve(vocabulary.books.find(book => book.id === id))
  if (typeof core.validateBook !== 'function' || typeof core.installBook !== 'function') return Promise.reject(new Error('请更新到支持完整词库的版本'))
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.apiBase + '/books/' + encodeURIComponent(id) + '/words?edition=full', method: 'GET', timeout: 45000,
      success(response) {
        try {
          if (response.statusCode !== 200) throw new Error('词库下载暂时失败，请稍后重试')
          const payload = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
          core.validateBook(payload)
          if (!payload.book || payload.book.id !== id) throw new Error('下载词库与所选词书不一致')
          storage.put(LIBRARY_PREFIX + id, payload)
          const nextIds = installedBookIds.includes(id) ? installedBookIds.slice() : installedBookIds.concat(id)
          try { storage.put(LIBRARY_INDEX_KEY, nextIds) }
          catch (error) {
            // The dictionary is not enabled until its durable index exists.
            // Reclaim a newly staged download if the second write hits quota.
            try { storage.remove(LIBRARY_PREFIX + id) } catch (_) {}
            throw error
          }
          const book = core.installBook(payload)
          installedBookIds = nextIds
          resolve(book)
        } catch (error) { reject(error) }
      },
      fail() { reject(new Error('下载未完成，精选词库仍可使用。请检查网络或稍后重试。')) }
    })
  })
}
function exportBackup() {
  return JSON.stringify({ format: 'oneword.backup', version: 1, state: { ...read(), history: [] }, bookIds: getInstalledBookIds(), exportedAt: Date.now() }, null, 2)
}
function inspectBackup(input) {
  let raw
  try { raw = typeof input === 'string' ? JSON.parse(input) : input } catch (_) { throw new Error('备份不是有效 JSON，请粘贴完整内容') }
  if (typeof input === 'string' && input.length > 5 * 1024 * 1024) throw new Error('备份超过 5 MB，请拆分或联系维护者协助恢复')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('备份格式不正确')
  const envelope = raw.format === 'oneword.backup' || raw.product === 'oneword'
  if (raw.format === 'oneword.backup' && raw.version !== 1) throw new Error('备份版本暂不支持，请使用一词 v1 备份')
  const state = envelope ? raw.state : raw
  if (!state || state.version !== 1 || !state.words || !state.settings) throw new Error('备份中的学习记录格式无效')
  let ids = envelope ? (raw.bookIds || raw.catalogBooks || []) : []
  if (!Array.isArray(ids)) throw new Error('备份中的词书清单无效')
  ids = ids.map(item => typeof item === 'string' ? item : item && (item.id || item.book && item.book.id))
  if (Object.keys(state.words).some(id => !vocabulary.wordMap[id]) && !ids.length) ids.push(state.bookId)
  ids = Array.from(new Set(ids))
  if (ids.some(id => !vocabulary.books.some(book => book.id === id && book.available))) throw new Error('备份包含当前不可用的词书')
  return { state, bookIds: ids, requiredBookIds: ids.filter(id => !getInstalledBookIds().includes(id)) }
}
async function restoreBackup(input) {
  const info = inspectBackup(input)
  for (const id of info.requiredBookIds) await downloadBook(id)
  // Parse within the core realm, preserving its strict object validation.
  const next = core.importState(JSON.stringify(info.state))
  return write(next)
}
function pendingInfo(state, now) {
  const at = now === undefined ? Date.now() : now
  const book = currentBook(state)
  const items = book.wordIds.map(id => state.words[id]).filter(progress => progress && progress.dueAt > at && (progress.status === 'unknown' || progress.status === 'unsure'))
  const nextAt = items.reduce((min, item) => Math.min(min, item.dueAt), Infinity)
  return { count: items.length, unknown: items.filter(item => item.status === 'unknown').length, unsure: items.filter(item => item.status === 'unsure').length, nextAt: Number.isFinite(nextAt) ? nextAt : null, nextLabel: Number.isFinite(nextAt) ? formatDue(nextAt) : '' }
}
function apply(fn) {
  try { return write(fn(read())) }
  catch (error) {
    wx.showToast({ title: error.message || '保存失败，请稍后重试', icon: 'none' })
    return null
  }
}
function tutorialSeen() { return !!read().settings.tutorialComplete }
function finishTutorial() { apply(state => core.updateSettings(state, { tutorialComplete: true })) }
function resetTutorial() { apply(state => core.updateSettings(state, { tutorialComplete: false })) }
function getWord(id) { return vocabulary.wordMap[id] || vocabulary.words.find(word => word.id === id) }
function currentBook(state) { return vocabulary.books.find(book => book.id === (state || read()).bookId) }
function formatDue(value) {
  if (!value) return '学习后安排'
  const t = new Date(value).getTime() - Date.now()
  if (t <= 0) return '现在可复习'
  if (t < 3600000) return Math.max(1, Math.ceil(t / 60000)) + ' 分钟后'
  if (t < 86400000) return Math.ceil(t / 3600000) + ' 小时后'
  return Math.ceil(t / 86400000) + ' 天后'
}
function progressFor(id) {
  const p = read().words[id]
  return p ? { ...p, statusLabel: { known: '认识', unknown: '不认识', unsure: '不确定' }[p.status], dueLabel: formatDue(p.dueAt) } : null
}
function speak(word) {
  const accent = read().settings.accent || 'us'
  const src = word.audio && (word.audio[accent] || word.audio.us || word.audio.uk)
  if (!src || !/^https:\/\//.test(src)) {
    wx.showToast({ title: '此词暂无授权音频，可参考音标', icon: 'none' })
    return
  }
  const audio = wx.createInnerAudioContext()
  audio.src = src
  audio.onEnded(() => audio.destroy())
  audio.onError(() => { audio.destroy(); wx.showToast({ title: '音频暂不可用', icon: 'none' }) })
  audio.play()
}
module.exports = { core, vocabulary, read, write, apply, tutorialSeen, finishTutorial, resetTutorial, getWord, currentBook, formatDue, progressFor, speak, KEY, RECOVERY_KEY, recoveryInfo, recoveryJSON, clearAll, pendingInfo, getInstalledBookIds, storageUsage, downloadBook, exportBackup, inspectBackup, restoreBackup }
