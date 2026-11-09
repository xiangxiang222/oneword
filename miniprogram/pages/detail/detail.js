const store = require('../../utils/store')
Page({
  data: { word: null, progress: null, expanded: false, bookNames: '', canPlay: false },
  onLoad(options) { this.wordId = options.id; this.refresh() },
  onShow() { if (this.wordId) this.refresh(); if (this.refreshTimer) clearInterval(this.refreshTimer); this.refreshTimer = setInterval(() => this.refresh(), 30000) },
  refresh() {
    const word = store.getWord(this.wordId)
    if (!word) { wx.showToast({ title: '这个单词暂时找不到了', icon: 'none' }); return }
    const bookNames = store.vocabulary.books.filter(book => word.bookIds.includes(book.id)).map(book => book.title).join(' · ')
    this.setData({ word, progress: store.progressFor(word.id), bookNames, canPlay: !!word.audio })
    wx.setNavigationBarTitle({ title: word.word })
  },
  expand() { this.setData({ expanded: !this.data.expanded }) },
  relearn() {
    const before = store.read()
    const next = store.apply(state => store.core.rateWord(state, this.wordId, 'unknown'))
    if (!next) return
    if (next === before) { wx.showToast({ title: '刚记录过这个词，请稍等一下', icon: 'none' }); return }
    this.refresh()
    wx.showToast({ title: '已移入不认识，稍后复习', icon: 'none' })
  },
  speak() { store.speak(this.data.word) },
  copy() { wx.setClipboardData({ data: this.data.word.word }) },
  onHide() { if (this.refreshTimer) clearInterval(this.refreshTimer); this.refreshTimer = null },
  onUnload() { this.onHide() },
  back() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/collections/collections' }) }) }
})
