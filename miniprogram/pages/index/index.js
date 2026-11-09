const store = require('../../utils/store')
const cloud = require('../../utils/cloud')
Page({
  data: { stats: {}, book: {}, tutorial: false, today: '', progressStyle: '', pending: {}, recovery: {}, orderOptions: store.core.LEARNING_ORDERS, orderIndex: 0, orderLabel: '记忆优先' },
  onShow() {
    if (this.unsubscribeCloud) this.unsubscribeCloud()
    this.unsubscribeCloud = cloud.subscribe(() => this.refresh())
    this.refresh()
    this.setData({ tutorial: !store.tutorialSeen() })
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = setInterval(() => this.refresh(), 15000)
  },
  refresh() {
    const state = store.read()
    const stats = store.core.getStats(state)
    const date = new Date()
    const orderOptions = store.core.LEARNING_ORDERS
    const orderIndex = Math.max(0, orderOptions.findIndex(order => order.id === (state.settings.learningOrder || 'adaptive')))
    this.setData({ orderOptions, orderIndex, orderLabel: orderOptions[orderIndex].label, stats, book: store.currentBook(state), today: (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日', pending: store.pendingInfo(state), recovery: store.recoveryInfo(), progressStyle: 'width:' + stats.progress + '%' })
  },
  learningOrder(event) {
    const order = this.data.orderOptions[Number(event.detail.value)]
    if (!order) return
    if (store.apply(state => store.core.updateSettings(state, { learningOrder: order.id }))) { this.refresh(); wx.showToast({ title: '已保存，下次开始学习生效', icon: 'none' }) }
  },
  start() {
    this.refresh()
    if (!this.data.stats.todayRemaining) { wx.switchTab({ url: '/pages/profile/profile' }); return }
    wx.navigateTo({ url: '/pages/study/study?mode=today' })
  },
  review() { wx.navigateTo({ url: '/pages/study/study?mode=review' }) },
  books() { wx.switchTab({ url: '/pages/books/books' }) },
  collections() { wx.switchTab({ url: '/pages/collections/collections' }) },
  dismissTutorial() { store.finishTutorial(); this.setData({ tutorial: false }) },
  beginTutorial() { this.dismissTutorial(); this.start() },
  onHide() { if (this.refreshTimer) clearInterval(this.refreshTimer); this.refreshTimer = null; if (this.unsubscribeCloud) this.unsubscribeCloud(); this.unsubscribeCloud = null },
  onUnload() { this.onHide() },
  noop() {}
})
