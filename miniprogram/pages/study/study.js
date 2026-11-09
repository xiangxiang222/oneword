const store = require('../../utils/store')
const cloud = require('../../utils/cloud')
const MODE_LABELS = { today: '今日学习', review: '到期复习', unknown: '不认识词集', unsure: '不确定词集', known: '认识词集' }
Page({
  data: { word: null, mode: 'today', modeLabel: '', orderId: 'adaptive', orderLabel: '记忆优先', bookTitle: '', index: 0, total: 0, done: false, revealed: true, expanded: false, canUndo: false, dragStyle: '', swipeLabel: '', stats: {}, sessionCounts: { known: 0, unsure: 0, unknown: 0 }, nextDueLabel: '', progressStyle: 'width:0%', busy: false, pending: {} },
  onLoad(options) {
    const mode = MODE_LABELS[options.mode] ? options.mode : 'today'
    const state = store.read()
    const orderId = state.settings.learningOrder || 'adaptive'
    const order = store.core.LEARNING_ORDERS.find(item => item.id === orderId) || store.core.LEARNING_ORDERS[0]
    this.queue = store.core.makeSession(state, { mode, limit: 50 })
    this.actions = []
    this.cursor = 0
    this.setData({ orderId: order.id, orderLabel: order.label, mode, modeLabel: MODE_LABELS[mode], bookTitle: store.currentBook().title, total: this.queue.length })
    this.present()
  },
  onShow() {
    if (!this.queue) return
    if (this.unsubscribeCloud) this.unsubscribeCloud()
    this.unsubscribeCloud = cloud.subscribe(() => this.refreshStats())
    this.refreshStats()
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = setInterval(() => this.refreshStats(), 15000)
  },
  refreshStats() {
    const state = store.read()
    const stats = store.core.getStats(state)
    this.setData({ stats, pending: store.pendingInfo(state), nextDueLabel: store.formatDue(stats.nextDueAt) })
  },
  present() {
    const state = store.read()
    const word = this.queue[this.cursor]
    const stats = store.core.getStats(state)
    const counts = this.actions.reduce((all, action) => { all[action.rating] += 1; return all }, { known: 0, unsure: 0, unknown: 0 })
    this.setData({ word: word || null, index: this.cursor, done: !word, revealed: !state.settings.recallFirst, expanded: false, canUndo: this.actions.length > 0 && state.history.length > 0, dragStyle: '', swipeLabel: '', stats, pending: store.pendingInfo(state), sessionCounts: counts, nextDueLabel: store.formatDue(stats.nextDueAt), progressStyle: 'width:' + (this.queue.length ? this.cursor / this.queue.length * 100 : 100) + '%' })
    if (word) wx.setNavigationBarTitle({ title: this.data.modeLabel + ' · ' + (this.cursor + 1) + '/' + this.queue.length })
    else wx.setNavigationBarTitle({ title: '这一组，完成了' })
  },
  reveal() { this.setData({ revealed: true }) },
  expand() { this.setData({ expanded: !this.data.expanded }) },
  score(event) { this.rate(event.currentTarget.dataset.rating) },
  rate(rating) {
    if (!this.data.word || !this.data.revealed || this.data.expanded || this.data.busy) return
    const before = store.read()
    const next = store.apply(state => store.core.rateWord(state, this.data.word.id, rating))
    if (!next || next === before) return
    this.setData({ busy: true })
    this.actions.push({ id: this.data.word.id, rating })
    this.cursor += 1
    this.present()
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
    this.unlockTimer = setTimeout(() => this.setData({ busy: false }), 220)
  },
  undo() {
    if (!this.actions.length || this.data.busy) return
    const before = store.read()
    const next = store.apply(state => store.core.undo(state))
    if (!next || next === before) return
    this.actions.pop()
    this.cursor = Math.max(0, this.cursor - 1)
    this.present()
    wx.showToast({ title: '已撤销上一词', icon: 'none' })
  },
  touchStart(event) {
    if (this.data.expanded || !this.data.revealed) return
    const touch = event.touches[0]
    this.touchOrigin = { x: touch.clientX, y: touch.clientY }
  },
  touchMove(event) {
    if (!this.touchOrigin || this.data.busy) return
    const touch = event.touches[0]
    const dx = Math.max(-150, Math.min(150, touch.clientX - this.touchOrigin.x))
    if (Math.abs(touch.clientY - this.touchOrigin.y) > 70) return
    this.setData({ dragStyle: 'transform:translateX(' + dx * .38 + 'px) rotate(' + dx * .025 + 'deg)', swipeLabel: Math.abs(dx) > 35 ? (dx < 0 ? '← 不认识' : '认识 →') : '' })
  },
  touchEnd(event) {
    if (!this.touchOrigin) return
    const touch = event.changedTouches[0]
    const dx = touch.clientX - this.touchOrigin.x
    const dy = touch.clientY - this.touchOrigin.y
    this.touchOrigin = null
    this.setData({ dragStyle: '', swipeLabel: '' })
    if (Math.abs(dx) >= 85 && Math.abs(dy) < 80) this.rate(dx < 0 ? 'unknown' : 'known')
  },
  touchCancel() { this.touchOrigin = null; this.setData({ dragStyle: '', swipeLabel: '' }) },
  home() { wx.switchTab({ url: '/pages/index/index' }) },
  nextGroup() {
    const state = store.read()
    const order = store.core.LEARNING_ORDERS.find(item => item.id === (state.settings.learningOrder || 'adaptive')) || store.core.LEARNING_ORDERS[0]
    this.queue = store.core.makeSession(state, { mode: this.data.mode, limit: 50 })
    this.actions = []; this.cursor = 0
    this.setData({ total: this.queue.length, orderId: order.id, orderLabel: order.label })
    this.present()
  },
  onHide() { if (this.refreshTimer) clearInterval(this.refreshTimer); this.refreshTimer = null; if (this.unsubscribeCloud) this.unsubscribeCloud(); this.unsubscribeCloud = null },
  onUnload() { this.onHide(); if (this.unlockTimer) clearTimeout(this.unlockTimer) }
})
