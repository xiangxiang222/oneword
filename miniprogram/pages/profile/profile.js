const store = require('../../utils/store')
Page({
  data: { stats: {}, settings: {}, bars: [], goalOptions: [5, 10, 15, 20, 30, 40, 50, 75, 100], goalIndex: 3, orderOptions: store.core.LEARNING_ORDERS, orderIndex: 0, orderDescription: '', panel: '', importText: '', importError: '', restoring: false, recovery: {}, storageUsage: null },
  onShow() { this.refresh(); if (this.refreshTimer) clearInterval(this.refreshTimer); this.refreshTimer = setInterval(() => this.refresh(), 30000) },
  refresh() {
    const state = store.read()
    const stats = store.core.getStats(state)
    const max = Math.max(1, ...stats.last7Days.map(day => day.total))
    const orderOptions = store.core.LEARNING_ORDERS
    const orderIndex = Math.max(0, orderOptions.findIndex(order => order.id === (state.settings.learningOrder || 'adaptive')))
    const goalOptions = Array.from(new Set(this.data.goalOptions.concat(state.settings.dailyGoal))).sort((a, b) => a - b)
    this.setData({ stats, recovery: store.recoveryInfo(), storageUsage: store.storageUsage(), settings: state.settings, orderOptions, orderIndex, orderDescription: orderOptions[orderIndex].description, goalOptions, bars: stats.last7Days.map(day => ({ ...day, barStyle: 'height:' + (day.total ? Math.max(7, day.total / max * 120) : 3) + 'rpx' })), goalIndex: goalOptions.indexOf(state.settings.dailyGoal) })
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
  closePanel() { this.setData({ panel: '', importError: '' }) },
  inputImport(event) { this.setData({ importText: event.detail.value, importError: '' }) },
  restore() {
    let info
    try { info = store.inspectBackup(this.data.importText) }
    catch (error) { this.setData({ importError: error.message || '备份格式不正确，请粘贴完整 JSON。' }); return Promise.resolve(false) }
    const names = info.requiredBookIds.map(id => store.vocabulary.books.find(book => book.id === id).title).join('、')
    return new Promise(resolve => {
      wx.showModal({ title: '恢复这份学习记录？', content: '当前设备的学习记录和设置将被备份替换。' + (names ? '需先联网下载完整词书：' + names + '。' : '') + '建议先导出当前记录。', confirmText: '确认恢复', confirmColor: '#244d3d', success: async result => {
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
  onHide() { if (this.refreshTimer) clearInterval(this.refreshTimer); this.refreshTimer = null },
  onUnload() { this.onHide() },
  noop() {}
})
