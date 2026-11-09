const store = require('../../utils/store')
Page({
  data: { status: 'unknown', query: '', items: [], total: 0, counts: {}, tabs: [{ id: 'unknown', label: '不认识' }, { id: 'unsure', label: '不确定' }, { id: 'known', label: '认识' }], explanation: '' },
  onShow() { this.refresh() },
  tab(event) { this.setData({ status: event.currentTarget.dataset.status }); this.refresh() },
  search(event) { this.setData({ query: event.detail.value }); this.refresh() },
  refresh() {
    const state = store.read()
    const stats = store.core.getStats(state)
    const query = this.data.query.toLowerCase().trim()
    const all = store.core.getCollection(state, this.data.status)
    const items = all.filter(word => !query || (word.word + word.coreMeaning).toLowerCase().includes(query)).map(word => ({ ...word, dueLabel: store.formatDue(state.words[word.id].dueAt) }))
    const explanation = { unknown: '从这里重新开始。不认识的词，会更早回来。', unsure: '眼熟但想不起来？给这些词多一次相遇。', known: '认识也需要温习。下一次复习，已经安排好了。' }[this.data.status]
    this.setData({ items, total: all.length, counts: { unknown: stats.unknownCount, unsure: stats.unsureCount, known: stats.knownCount }, explanation })
  },
  detail(event) { wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(event.currentTarget.dataset.id) }) },
  practice() { wx.navigateTo({ url: '/pages/study/study?mode=' + this.data.status }) },
  learn() { wx.switchTab({ url: '/pages/index/index' }) }
})
