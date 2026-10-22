/**
 * pages/placeholder/placeholder.js
 * 轻量占位页：对弈 / 打谱 / 学习 三个模式分包尚未落地、以及设置页未建时，
 * Landing 卡片先指向这里，避免「可导航」却跳到不存在的页面而报错。
 * 各自分包（看板 L2-T6 / T7 / T8）与设置页落地后，替换 Landing 卡片 url 即可。
 */
Page({
  data: {
    title: '敬请期待',
    desc: '该模块正在开发中。'
  },

  onLoad(options) {
    options = options || {}
    this.setData({
      title: options.title || '敬请期待',
      desc: options.desc || '该模块正在开发中。'
    })
  },

  onBack() {
    const host = typeof wx !== 'undefined' ? wx : null
    if (host && typeof host.navigateBack === 'function') {
      host.navigateBack()
    }
  }
})
