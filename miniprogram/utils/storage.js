// WeChat limits both the whole storage area and each individual key. Large
// dictionaries and histories are split, with the descriptor committed last.
const CHUNK_SIZE = 120000
let sequence = 0
function isDescriptor(value) { return value && value._onewordChunks === 1 && Array.isArray(value.parts) }
function get(key) {
  const raw = wx.getStorageSync(key)
  if (!isDescriptor(raw)) return raw
  const chunks = raw.parts.map(part => {
    const value = wx.getStorageSync(part)
    if (typeof value !== 'string') throw new Error('本地分片记录不完整')
    return value
  })
  const json = chunks.join('')
  if (json.length !== raw.length) throw new Error('本地分片记录长度异常')
  return JSON.parse(json)
}
function put(key, value) {
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error('无法保存空记录')
  const previous = wx.getStorageSync(key)
  const staged = []
  try {
    if (json.length <= CHUNK_SIZE) wx.setStorageSync(key, value)
    else {
      const revision = Date.now().toString(36) + '-' + (++sequence).toString(36)
      for (let i = 0; i < json.length; i += CHUNK_SIZE) {
        const chunkKey = key + '.part.' + revision + '.' + staged.length
        wx.setStorageSync(chunkKey, json.slice(i, i + CHUNK_SIZE))
        staged.push(chunkKey)
      }
      wx.setStorageSync(key, { _onewordChunks: 1, parts: staged, length: json.length })
    }
  } catch (error) {
    staged.forEach(part => { try { wx.removeStorageSync(part) } catch (_) {} })
    throw new Error('本机存储空间不足，原记录仍保留。请先备份并释放空间。')
  }
  if (isDescriptor(previous)) previous.parts.forEach(part => { try { wx.removeStorageSync(part) } catch (_) {} })
  return value
}
function remove(key) {
  const previous = wx.getStorageSync(key)
  wx.removeStorageSync(key)
  if (isDescriptor(previous)) previous.parts.forEach(part => { try { wx.removeStorageSync(part) } catch (_) {} })
}
function original(key) {
  const raw = wx.getStorageSync(key)
  if (!isDescriptor(raw)) return raw
  const fragments = {}
  raw.parts.forEach(part => { try { fragments[part] = wx.getStorageSync(part) } catch (_) { fragments[part] = null } })
  return { storageHeader: raw, fragments }
}
module.exports = { get, put, remove, original, CHUNK_SIZE }
