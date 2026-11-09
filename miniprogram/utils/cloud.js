const { createCloudClient } = require('../shared/cloud-client')
const store = require('./store')
const storage = require('./storage')
const config = require('../config')

let instance = null
let applyingRemote = false
const listeners = []
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = /^\/auth\/(login|register)$/.test(path) ? Object.assign({}, body, { client: 'native' }) : body
    wx.request({
      url: config.apiBase + path, method, data, timeout: 20000,
      header: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      success(response) {
        let value = response.data
        try { if (typeof value === 'string' && value) value = JSON.parse(value) }
        catch (_) { reject(new Error('服务响应暂时异常，请稍后重试')); return }
        resolve({ status: response.statusCode, data: value })
      },
      fail() { reject(new Error('暂时无法连接云端，学习记录仍保存在本机')) }
    })
  })
}
function client() {
  if (instance) return instance
  // A recovered account transition can contain words from complete books.
  // Install cached dictionaries before the shared engine validates its state.
  store.read()
  instance = createCloudClient({
    storage, request,
    getState: () => store.read(),
    getAppliedId: () => store.getAppliedId(),
    setState(state, applicationId) {
      applyingRemote = true
      try { store.write(state, applicationId) } finally { applyingRemote = false }
    },
    getBookIds: () => store.getInstalledBookIds(),
    async prepareBooks(ids) { for (const id of ids || []) await store.downloadBook(id) },
    onChange(status) { listeners.slice().forEach(listener => listener(status)) }
  })
  store.setChangeListener(() => { if (!applyingRemote) instance.schedule() })
  store.setClearGuard(() => { if (instance.getStatus().user) throw new Error('请先退出账号，再清空游客记录；云端账号记录会保留。') })
  return instance
}
function subscribe(listener) {
  listeners.push(listener)
  return () => { const index = listeners.indexOf(listener); if (index !== -1) listeners.splice(index, 1) }
}
module.exports = {
  init: () => client().init(),
  getStatus: () => client().getStatus(),
  authenticate: (mode, credentials, mergeGuest) => client().authenticate(mode, credentials, mergeGuest),
  sync: () => client().sync(),
  logout: () => client().logout(),
  deleteAccount: password => client().deleteAccount(password),
  changePassword: (currentPassword, newPassword) => client().changePassword(currentPassword, newPassword),
  subscribe
}
