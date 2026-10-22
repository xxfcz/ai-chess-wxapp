/**
 * pages/landing/landing.js
 * Landing 首页（主包单页）：四张模式入口卡片 + 设置入口。
 * 只负责「选模式 + 初始化 session + 读取设置」，不含棋盘逻辑（方案 §1）。
 * 卡片点击 → 配 session 模式 → navigateTo 对应分包 page；返回 Landing / 切模式 → 全局 store 保留 session。
 *
 * 各模式分包：分析（pkg-analyze）已实现；对弈 / 打谱 / 学习 / 设置 暂用占位页，
 * 待各自分包落地后替换对应 url（看板 L2-T6 / T7 / T8 与设置页）。
 */
const clipboardImport = require('../../utils/clipboard-import')

/** 模式入口卡片：key 用于 wx:key（字符串字段）；url 是 navigateTo 目标。 */
const MODE_CARDS = [
  {
    key: 'play',
    mode: 'play',
    icon: '新',
    title: '开新局',
    desc: '与 AI 陪练对弈',
    ready: true,
    url: '/pkg-play/play/play?mode=play'
  },
  {
    key: 'analyze',
    mode: 'analyze',
    icon: '析',
    title: '分析棋局',
    desc: '粘贴 FEN 深度分析',
    ready: true,
    url: '/pkg-analyze/analyze/analyze?mode=analyze'
  },
  {
    key: 'replay',
    mode: 'replay',
    icon: '谱',
    title: '打谱',
    desc: '导入 PGN 复盘',
    ready: false,
    url: '/pages/placeholder/placeholder?title=打谱模式&desc=导入 PGN 逐步回放，每步引擎标注与分支讲解。正在打磨中，敬请期待。'
  },
  {
    key: 'learn',
    mode: 'learn',
    icon: '学',
    title: '学习',
    desc: '战术与开局',
    ready: false,
    url: '/pages/placeholder/placeholder?title=学习模式&desc=战术/开局题库练习与结果点评。正在打磨中，敬请期待。'
  }
]

const SETTINGS_URL = '/pages/placeholder/placeholder?title=设置&desc=引擎模式、自动点评与模型偏好将在设置页集中管理，敬请期待。'

Page({
  data: {
    cards: MODE_CARDS
  },

  onLoad() {
    /** 最近一次已询问过的剪贴板 FEN：同一内容只弹一次（与 analyze 共用同一去重语义） */
    this._lastPromptedFen = ''
  },

  onShow() {
    this._checkClipboardForFen()
  },

  /**
   * Landing 也探测剪贴板（方案 §11.6）：用户从对弈平台整段复制 FEN 回来，
   * 自动发现并询问是否跳到分析页载入。逻辑下沉到 utils/clipboard-import.js 与 analyze 共用。
   */
  _checkClipboardForFen() {
    const host = typeof wx !== 'undefined' ? wx : null
    clipboardImport.autoImportFenFromClipboard({
      host: host,
      currentFen: '',
      alreadyPrompted: fen => fen === this._lastPromptedFen,
      markPrompted: fen => { this._lastPromptedFen = fen },
      onApply: fen => this._openAnalyzeWithFen(fen)
    })
  },

  _openAnalyzeWithFen(fen) {
    const host = typeof wx !== 'undefined' ? wx : null
    const url = '/pkg-analyze/analyze/analyze?mode=analyze&fen=' + encodeURIComponent(fen)
    if (host && typeof host.navigateTo === 'function') {
      host.navigateTo({ url: url })
    }
  },

  /** 卡片点击：跳转到对应分包 / 占位页；缺 navigateTo 能力时静默（预览子集） */
  onCardTap(e) {
    const url = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.url : ''
    if (!url) return
    const host = typeof wx !== 'undefined' ? wx : null
    if (host && typeof host.navigateTo === 'function') {
      host.navigateTo({ url: url })
    }
  },

  onSettingsTap() {
    const host = typeof wx !== 'undefined' ? wx : null
    if (host && typeof host.navigateTo === 'function') {
      host.navigateTo({ url: SETTINGS_URL })
    }
  }
})
