import core from './generated/core.js'
import vocabulary from './generated/vocabulary.js'

const installed = new Set()
const DB_NAME = 'oneword-catalog-v1'
const STORAGE_TIMEOUT = 5000
function database() {
  return new Promise((resolve, reject) => {
    let settled = false
    let request
    const finish = (error, db) => {
      if (settled) { db?.close(); return }
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else { db.onversionchange = () => db.close(); resolve(db) }
    }
    const timer = setTimeout(() => finish(new Error('词库存储响应超时')), STORAGE_TIMEOUT)
    try {
      request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        if (settled) { request.transaction.abort(); return }
        if (!request.result.objectStoreNames.contains('books')) request.result.createObjectStore('books', { keyPath: 'book.id' })
      }
      request.onsuccess = () => finish(null, request.result)
      request.onerror = () => finish(request.error || new Error('无法打开词库存储'))
      request.onblocked = () => finish(new Error('词库存储被其他页面占用'))
    } catch (error) { finish(error) }
  })
}
function transactionResult(db, mode, operation) {
  return new Promise((resolve, reject) => {
    let transaction
    let result
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(() => {
      finish(new Error('词库存储响应超时'))
      try { transaction?.abort() } catch {}
    }, STORAGE_TIMEOUT)
    try {
      transaction = db.transaction('books', mode)
      const request = operation(transaction.objectStore('books'))
      request.onsuccess = () => { result = request.result }
      transaction.oncomplete = () => finish()
      transaction.onerror = () => finish(transaction.error || new Error('词库保存失败'))
      transaction.onabort = () => finish(transaction.error || new Error('词库存储操作已取消'))
    } catch (error) { finish(error) }
  })
}
async function cacheBook(payload) {
  const db = await database()
  try { await transactionResult(db, 'readwrite', store => store.put(payload)) }
  finally { db.close() }
}
export async function restoreCatalog() {
  let db
  try {
    db = await database()
    const payloads = await transactionResult(db, 'readonly', store => store.getAll())
    for (const payload of payloads) {
      try { core.installBook(payload); installed.add(payload.book.id) } catch {}
    }
  } catch { /* Built-in vocabulary remains available if storage is blocked or unavailable. */ }
  finally { db?.close() }
}
export function installedBooks() { return [...installed] }
export async function downloadBook(id) {
  if (installed.has(id)) return vocabulary.books.find(book => book.id === id)
  if (!vocabulary.books.some(book => book.id === id && book.available)) throw Error('这本词书暂不可用')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45000)
  let payload
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}api/books/${encodeURIComponent(id)}/words?edition=full`, { signal: controller.signal })
    if (!response.ok) throw Error('词库下载失败，请检查网络后重试。离线精选仍可使用。')
    payload = await response.json()
  } finally { clearTimeout(timer) }
  // Validate before persisting; cache success is required before enabling new words.
  core.validateBook(payload)
  try { await cacheBook(payload) } catch { throw Error('设备未能保存完整词库，请检查存储空间，或先使用离线精选。') }
  const book = core.installBook(payload)
  installed.add(id)
  return book
}
export async function restoreBookManifest(ids) {
  if (ids === undefined) return
  if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== 'string' || !vocabulary.books.some(book => book.id === id && book.available))) throw Error('备份中的词书列表无效')
  for (const id of [...new Set(ids)]) await downloadBook(id)
}
