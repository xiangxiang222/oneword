const store = require('../../utils/store')
const cloud = require('../../utils/cloud')
Page({
  data: { stats: {}, settings: {}, bars: [], goalOptions: [5, 10, 15, 20, 30, 40, 50, 75, 100], goalIndex: 3, orderOptions: store.core.LEARNING_ORDERS, orderIndex: 0, orderDescription: '', panel: '', importText: '', importError: '', restoring: false, recovery: {}, storageUsage: null, account: { user: null, phase: 'guest' }, syncLabel: '游客记录保存在本机', syncTime: '', authMode: 'login', username: '', password: '', newPassword: '', mergeGuest: true, authBusy: false, authError: '' },
  onShow() {
    if (this.unsubscribeCloud) this.unsubscribeCloud()
    this.unsubscribeCloud = cloud.subscribe(() => this.refresh())
    this.refresh()
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = setInterval(() => this.refresh(), 30000)
  },
  refresh() {
    const state = store.read()
    const stats = store.core.getStats(state)
    const max = Math.max(1, ...stats.last7Days.map(day => day.total))
    const orderOptions = store.core.LEARNING_ORDERS
    const orderIndex = Math.max(0, orderOptions.findIndex(order => order.id === (state.settings.learningOrder || 'adaptive')))
    const goalOptions = Array.from(new Set(this.data.goalOptions.concat(state.settings.dailyGoal))).sort((a, b) => a - b)
    const account = cloud.getStatus()
    if (account.phase === 'expired' && !['login', 'register'].includes(this.data.authMode)) this.setData({ authMode: 'login', password: '', newPassword: '' })
    const syncLabels = { guest: '游客记录保存在本机', idle: '学习记录已同步', syncing: '正在同步学习记录…', offline: '待联网同步，本机记录已保留', error: '同步未完成，请重试', expired: '登录已过期，请重新登录' }
    const syncTime = account.lastSyncedAt ? new Date(account.lastSyncedAt).toLocaleString('zh-CN') : ''
    const syncLabel = account.message === '本机已保存，等待同步' ? account.message : syncLabels[account.phase] || account.message || '等待同步'
    this.setData({ account, accountInitial: account.user ? account.user.username.slice(0, 1).toUpperCase() : '↗', syncLabel, syncTime, stats, recovery: store.recoveryInfo(), storageUsage: store.storageUsage(), settings: state.settings, orderOptions, orderIndex, orderDescription: orderOptions[orderIndex].description, goalOptions, bars: stats.last7Days.map(day => ({ ...day, barStyle: 'height:' + (day.total ? Math.max(7, day.total / max * 120) : 3) + 'rpx' })), goalIndex: goalOptions.indexOf(state.settings.dailyGoal) })
  },
  openAccount() { this.setData({ panel: 'account', authMode: 'login', username: this.data.account.user ? this.data.account.user.username : this.data.username, password: '', newPassword: '', authError: '' }) },
  authMode(event) { const mode = event.currentTarget.dataset.mode; if (!this.data.authBusy && ['login', 'register', 'password', 'delete'].includes(mode)) this.setData({ authMode: mode, password: '', newPassword: '', authError: '' }) },
  authInput(event) {
    const field = event.currentTarget.dataset.field
    if (['username', 'password', 'newPassword'].includes(field)) this.setData({ [field]: event.detail.value, authError: '' })
  },
  mergeGuest(event) { this.setData({ mergeGuest: event.detail.value.length > 0 }) },
  async authenticate() {
    if (this.data.authBusy) return
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(this.data.username.trim())) { this.setData({ authError: '账号需为 3–32 位字母、数字、点、下划线或短横线' }); return }
    if (this.data.password.length < 8 || this.data.password.length > 128) { this.setData({ authError: '密码需为 8–128 位，请勿使用其他平台的密码' }); return }
    this.setData({ authBusy: true, authError: '' })
    try {
      await cloud.authenticate(this.data.authMode, { username: this.data.username.trim(), password: this.data.password }, this.data.mergeGuest)
      this.setData({ password: '', newPassword: '', authError: '' }); this.refresh()
      wx.showToast({ title: this.data.authMode === 'register' ? '账号已创建' : '登录成功', icon: 'success' })
    } catch (error) { this.setData({ authError: error.message || '登录未完成，请稍后重试' }) }
    finally { this.setData({ authBusy: false }) }
  },
  async syncNow() {
    if (this.data.authBusy || this.data.account.phase === 'syncing') return
    this.setData({ authBusy: true, authError: '' })
    try { await cloud.sync(); this.refresh() }
    catch (error) { this.setData({ authError: error.message || '同步暂未完成，本机记录已保留' }) }
    finally { this.setData({ authBusy: false }) }
  },
  async signOut() {
    if (this.data.authBusy) return
    this.setData({ authBusy: true, authError: '' })
    try { await cloud.logout(); this.setData({ password: '', newPassword: '', authMode: 'login' }); this.refresh(); wx.showToast({ title: '已退出，返回游客进度', icon: 'none' }) }
    catch (error) { this.setData({ authError: error.message || '退出未完成，请稍后重试' }) }
    finally { this.setData({ authBusy: false }) }
  },
  async savePassword() {
    if (this.data.authBusy) return
    if (this.data.newPassword.length < 8 || this.data.newPassword.length > 128) { this.setData({ authError: '新密码需为 8–128 位' }); return }
    this.setData({ authBusy: true, authError: '' })
    try { await cloud.changePassword(this.data.password, this.data.newPassword); this.setData({ password: '', newPassword: '', authMode: 'login' }); this.refresh(); wx.showToast({ title: '密码已更新', icon: 'success' }) }
    catch (error) { this.setData({ authError: error.message || '密码未更新，请重试' }) }
    finally { this.setData({ authBusy: false }) }
  },
  deleteAccount() {
    if (this.data.authBusy || !this.data.password) return
    wx.showModal({ title: '永久注销这个账号？', content: '账号、云端词集、复习进度和学习统计会永久删除，无法撤销。请先导出备份。游客记录不受影响。', confirmText: '永久注销', confirmColor: '#a3614c', success: async result => {
      if (!result.confirm) return
      this.setData({ authBusy: true, authError: '' })
      try { await cloud.deleteAccount(this.data.password); this.setData({ password: '', newPassword: '', authMode: 'login' }); this.refresh(); wx.showToast({ title: '账号已注销', icon: 'none' }) }
      catch (error) { this.setData({ authError: error.message || '注销未完成，请重试' }) }
      finally { this.setData({ authBusy: false }) }
    } })
  },
  goal(event) { if (store.apply(state => store.core.updateSettings(state, { dailyGoal: this.data.goalOptions[Number(event.detail.value)] }))) this.refresh() },
  learningOrder(event) {
    const order = this.data.orderOptions[Number(event.detail.value)]
    if (!order) return
    if (store.apply(state => store.core.updateSettings(state, { learningOrder: order.id }))) { this.refresh(); wx.showToast({ title: '已保存，下次开始学习生效', icon: 'none' }) }
  },
  recall(event) { if (store.apply(state => store.core.updateSettings(state, { recallFirst: event.detail.value }))) this.refresh() },
  tutorial() { store.resetTutorial(); wx.switchTab({ url: '/pages/index/index' }) },
  openPanel(event) { this.setData({ panel: event.currentTarget.dataset.panel, importError: '' }) },
  closePanel() { if (!this.data.authBusy) this.setData({ panel: '', importError: '', password: '', newPassword: '', authError: '' }) },
  inputImport(event) { this.setData({ importText: event.detail.value, importError: '' }) },
  restore() {
    let info
    try { info = store.inspectBackup(this.data.importText) }
    catch (error) { this.setData({ importError: error.message || '备份格式不正确，请粘贴完整 JSON。' }); return Promise.resolve(false) }
    const names = info.requiredBookIds.map(id => store.vocabulary.books.find(book => book.id === id).title).join('、')
    return new Promise(resolve => {
      wx.showModal({ title: '恢复这份学习记录？', content: '当前设备的学习记录和设置将被备份替换。' + (this.data.account.user ? '恢复结果会同步到当前账号。' : '') + (names ? '需先联网下载完整词书：' + names + '。' : '') + '建议先导出当前记录。', confirmText: '确认恢复', confirmColor: '#244d3d', success: async result => {
        if (!result.confirm) { resolve(false); return }
        this.setData({ restoring: true, importError: '' })
        try {
          await store.restoreBackup(this.data.importText)
          this.setData({ panel: '', importText: '' }); this.refresh()
          wx.showToast({ title: '学习记录已恢复', icon: 'success' }); resolve(true)
        } catch (error) { this.setData({ importError: error.message || '恢复未完成，当前记录仍保留。' }); resolve(false) }
        finally { this.setData({ restoring: false }) }
      }, fail: () => resolve(false) })
    })
  },
  exportData() {
    const content = store.exportBackup()
    wx.setClipboardData({ data: content, success: () => wx.showToast({ title: '备份已复制，请妥善保存', icon: 'none' }), fail: () => wx.showToast({ title: '复制失败，请稍后重试', icon: 'none' }) })
  },
  clearData() {
    if (cloud.getStatus().user) { wx.showToast({ title: '请先退出账号，再清空游客记录', icon: 'none' }); return }
    wx.showModal({ title: '清空这台设备的学习记录？', content: '这会清空所有词集、复习进度、统计和异常记录备份，无法撤销。已下载词书会保留。建议先导出备份。', confirmText: '确认清空', confirmColor: '#a3614c', success: result => {
      if (!result.confirm) return
      try { store.clearAll(); this.closePanel(); this.refresh(); wx.showToast({ title: '已清空学习记录', icon: 'none' }) }
      catch (error) { wx.showToast({ title: error.message || '清空未完成，请重试', icon: 'none' }) }
    } })
  },
  exportRecovery() {
    try { wx.setClipboardData({ data: store.recoveryJSON(), success: () => wx.showToast({ title: '原始异常记录已复制，请保存', icon: 'none' }) }) }
    catch (error) { wx.showToast({ title: error.message || '导出失败，请重试', icon: 'none' }) }
  },
  copySource() { wx.setClipboardData({ data: 'https://github.com/skywind3000/ECDICT' }) },
  onHide() { if (this.refreshTimer) clearInterval(this.refreshTimer); this.refreshTimer = null; if (this.unsubscribeCloud) this.unsubscribeCloud(); this.unsubscribeCloud = null; this.setData({ password: '', newPassword: '' }) },
  onUnload() { this.onHide() },
  noop() {}
})
