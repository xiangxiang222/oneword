const store = require('../../utils/store')
const cloud = require('../../utils/cloud')
Page({
  data: { books: [], filtered: [], categories: ['全部', '基础', '大学', '留学'], category: '全部', query: '', currentId: '', total: 0, downloadingId: '', storageUsage: null },
  onShow() {
    if (this.unsubscribeCloud) this.unsubscribeCloud()
    this.unsubscribeCloud = cloud.subscribe(() => this.refresh())
    this.refresh()
  },
  refresh() {
    const books = store.vocabulary.books
    this.setData({ books, currentId: store.read().bookId, storageUsage: store.storageUsage(), total: books.filter(book => book.available).length })
    this.filter()
  },
  selectCategory(event) { this.setData({ category: event.currentTarget.dataset.category }); this.filter() },
  search(event) { this.setData({ query: event.detail.value }); this.filter() },
  filter() {
    const query = this.data.query.trim().toLowerCase()
    const filtered = this.data.books.filter(book => {
      const c = this.data.category
      const categoryMatch = c === '全部' || (c === '基础' && /小学|初中|高中|基础/.test(book.title + book.category)) || (c === '大学' && /四级|六级|考研|大学/.test(book.title + book.category)) || (c === '留学' && /雅思|托福|GRE|SAT|留学/.test(book.title + book.category))
      return categoryMatch && (!query || (book.title + book.subtitle + book.id).toLowerCase().includes(query))
    }).map(book => ({ ...book, active: book.id === this.data.currentId, countLabel: book.available ? (book.edition === 'full' ? '完整词表 · ' + book.count : '离线精选 · ' + (book.selectedCount || book.count)) + ' 词' : '词库准备中', fullLabel: book.edition === 'full' ? '已下载，可离线使用' : book.fullCount ? '可下载完整 ' + book.fullCount + ' 词' : '', downloading: book.id === this.data.downloadingId }))
    this.setData({ filtered })
  },
  choose(event) {
    const id = event.currentTarget.dataset.id
    const book = this.data.books.find(item => item.id === id)
    if (!book) return
    if (!book.available) { wx.showToast({ title: '这本词库正在整理，先选其他词书吧', icon: 'none' }); return }
    if (book.edition === 'full' || !book.fullAvailable || !book.fullCount) { this.selectBook(id); return }
    wx.showActionSheet({
      itemList: ['离线精选 · ' + (book.selectedCount || book.count) + ' 词', '下载完整词表 · ' + book.fullCount + ' 词'],
      success: result => { if (result.tapIndex === 1) this.download(id); else this.selectBook(id) }
    })
  },
  selectBook(id) {
    if (!store.apply(state => store.core.setBook(state, id))) return
    this.setData({ currentId: id }); this.filter()
    wx.showToast({ title: '已切换，原有记忆保留', icon: 'none' })
  },
  async download(id) {
    if (this.data.downloadingId) { wx.showToast({ title: '已有词库正在下载，请稍候', icon: 'none' }); return }
    this.setData({ downloadingId: id }); this.filter()
    wx.showToast({ title: '正在下载完整词库…', icon: 'none' })
    try {
      await store.downloadBook(id)
      this.setData({ books: store.vocabulary.books, storageUsage: store.storageUsage() })
      this.selectBook(id)
      wx.showToast({ title: '完整词库已保存，可离线学习', icon: 'none' })
    } catch (error) {
      wx.showModal({ title: '完整词库未保存', content: error.message || '下载失败，离线精选仍可使用。', showCancel: false, confirmColor: '#244d3d' })
    } finally { this.setData({ downloadingId: '' }); this.filter() }
  },
  learn() { wx.switchTab({ url: '/pages/index/index' }) },
  onHide() { if (this.unsubscribeCloud) this.unsubscribeCloud(); this.unsubscribeCloud = null },
  onUnload() { this.onHide() }
})
