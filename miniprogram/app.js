const cloud = require('./utils/cloud')
App({
  onLaunch() {
    this.globalData = { name: '一词 OneWord' }
    if (wx.onNetworkStatusChange) wx.onNetworkStatusChange(info => { if (info.isConnected) cloud.sync().catch(() => {}) })
  },
  onShow() { cloud.init().catch(() => {}) },
  onHide() { cloud.sync().catch(() => {}) }
})
