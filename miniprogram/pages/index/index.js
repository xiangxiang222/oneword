const store = require('../../utils/store')
Page({
  data: { stats: {}, book: {}, tutorial: false, today: '', progressStyle: '', pending: {}, recovery: {} },
  onShow() {
    this.refresh()
    this.setData({ tutorial: !store.tutorialSeen() })
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = setInterval(() => this.refresh(), 15000)
  },
  refresh() {
    const state = store.read()
    const stats = store.core.getStats(state)
    const date = new Date()
    this.setData({ stats, book: store.currentBook(state), today: (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日', pending: store.pendingInfo(state), recovery: store.recoveryInfo(), progressStyle: 'width:' + stats.progress + '%' })
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
  onHide() { if (this.refreshTimer) clearInterval(this.refreshTimer); this.refreshTimer = null },
  onUnload() { this.onHide() },
  noop() {}
})
