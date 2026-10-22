/**
 * pages/landing/landing.js
 * Landing 首页（主包单页）：四张模式入口卡片 + 设置入口。
 * 只负责「选模式 + 初始化 session + 读取设置」，不含棋盘逻辑（方案 §1）。
 * 卡片点击 → 配 session 模式 → 跳转到对应模式页；返回 Landing / 切模式 → 全局 store 保留 session。
 *
 * 各模式页：分析（pages/analyze）、对弈（pages/play）、打谱（pages/replay）已落地（单包结构，
 * 2026-10-22 晚由分包改回主包：内置预览不支持分包页面导航）；
 * 学习 / 设置 暂用占位页，待各自页面落地后替换对应 url（看板 L2-T8 deferred 与设置页）。
 */
const clipboardImport = require('../../utils/clipboard-import')
const navigation = require('../../utils/navigation')
const debugLog = require('../../utils/debug-log')

/** 环境能力探测清单：预览只有接口子集，缺什么直接列出来，省得靠猜 */
const PROBE_APIS = [
  'navigateTo', 'redirectTo', 'reLaunch', 'switchTab',
  'setClipboardData', 'request', 'showToast',
  'getWindowInfo', 'getSystemInfoSync', 'setEnableDebug'
]

/** 模式入口卡片：key 用于 wx:key（字符串字段）；url 是 navigateTo 目标。 */
const MODE_CARDS = [
  {
    key: 'play',
    mode: 'play',
    icon: '新',
    title: '开新局',
    desc: '与 AI 陪练对弈',
    ready: true,
    url: '/pages/play/play?mode=play'
  },
  {
    key: 'analyze',
    mode: 'analyze',
    icon: '析',
    title: '分析棋局',
    desc: '粘贴 FEN 深度分析',
    ready: true,
    url: '/pages/analyze/analyze?mode=analyze'
  },
  {
    key: 'replay',
    mode: 'replay',
    icon: '谱',
    title: '打谱',
    desc: '导入 PGN 复盘',
    ready: true,
    url: '/pages/replay/replay?mode=replay'
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
    cards: MODE_CARDS,
    /** 跳转失败时的显形文案（空串表示无错误）；预览运行时若不支持某种 url 形式会走到这里 */
    navError: '',
    /** 复制按钮的反馈：预览可能没有 setClipboardData，必须说清楚「怎么拿到这段文字」 */
    copyHint: '',
    /** 调试模式（默认收起）：运行日志 + 环境能力探测，是预览面板里唯一的 console 出口 */
    debugOpen: false,
    debugRows: [],
    debugText: '',
    debugCount: 0,
    debugHint: '',
    envRows: []
  },

  onLoad() {
    /** 最近一次已询问过的剪贴板 FEN：同一内容只弹一次（与 analyze 共用同一去重语义） */
    this._lastPromptedFen = ''
    debugLog.push('info', '[页面] Landing 已加载 · ' +
      (typeof wx !== 'undefined' && typeof wx.request === 'function' ? '可发起网络请求' : '无网络请求能力'))
    // 日志变化时只更新界面（用户没展开调试面板就不 setData，避免无谓渲染）
    this._debugUnsubscribe = debugLog.subscribe(() => {
      if (this.data.debugOpen) this.refreshDebug()
    })
  },

  onUnload() {
    if (typeof this._debugUnsubscribe === 'function') this._debugUnsubscribe()
    this._debugUnsubscribe = null
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

  /**
   * 统一跳转入口（utils/navigation.js）：先按带 query 的绝对路径跳，
   * 失败再依次换形式重试；全失败则把实际错误贴到界面上，不再静默。
   * 成功/失败的细节都写进运行日志——「第几种形式成功」是判断宿主差异的唯一证据。
   */
  _go(url) {
    const host = typeof wx !== 'undefined' ? wx : null
    debugLog.push('info', '[导航] 前往 ' + url)
    navigation.navigate(url, {
      host: host,
      onSuccess: info => {
        debugLog.push('info', '[导航] 成功 · ' + (info.url || '') +
          '（第 ' + (info.attempts || 1) + ' 种形式' + (info.via ? ' · ' + info.via : '') + '）')
      },
      onFail: info => {
        debugLog.push('error', '[导航] 失败 · ' + (info.reason || 'unknown') + ' · ' + (info.errMsg || ''))
        const tried = Array.isArray(info.tried) ? info.tried : []
        tried.forEach(t => {
          debugLog.push('error', '[导航] 试过 ' + (t.via ? t.via + ' ' : '') + t.url +
            ' → ' + (t.errMsg || '（无返回）'))
        })
        this.setData({ navError: navigation.describeFailure(info), copyHint: '' })
      }
    })
  },

  _openAnalyzeWithFen(fen) {
    this._go('/pages/analyze/analyze?mode=analyze&fen=' + encodeURIComponent(fen))
  },

  /** 卡片点击：跳转到对应分包 / 占位页 */
  onCardTap(e) {
    const url = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.url : ''
    if (!url) return
    this._go(url)
  },

  onSettingsTap() {
    this._go(SETTINGS_URL)
  },

  /**
   * 复制失败详情。预览环境常常没有 setClipboardData —— 那就不能静默：
   * 明确告诉用户「长按上面的文字手动选中」，并保证那段文字本身可选中。
   */
  onCopyNavError() {
    const text = this.data.navError || ''
    if (!text) return
    const host = typeof wx !== 'undefined' ? wx : null
    if (host && typeof host.setClipboardData === 'function') {
      host.setClipboardData({
        data: text,
        success: () => this.setData({ copyHint: '已复制到剪贴板' }),
        fail: () => this.setData({ copyHint: '当前环境不支持复制，请长按上面的文字手动选中' })
      })
      return
    }
    this.setData({ copyHint: '当前环境不支持复制，请长按上面的文字手动选中' })
  },

  onDismissNavError() {
    this.setData({ navError: '', copyHint: '' })
  },

  /* ---------------------------------------------------- 调试模式（运行日志） */

  /** 把日志与能力探测装进 data（最新的在最上面） */
  refreshDebug() {
    const rows = debugLog.list().slice().reverse().map(row => Object.assign({}, row, {
      levelClass: 'lv-' + row.level
    }))
    this.setData({
      debugRows: rows,
      debugCount: rows.length,
      debugText: debugLog.text()
    })
  },

  onToggleDebug() {
    const open = !this.data.debugOpen
    this.setData({ debugOpen: open, debugHint: '' })
    if (!open) return
    this.setData({ envRows: this._probeEnv() })
    this.refreshDebug()
    debugLog.push('info', '[调试] 已打开调试面板')
  },

  /** 探测宿主实现了哪些 wx 接口：预览是子集实现，缺什么一眼能看到 */
  _probeEnv() {
    const host = typeof wx !== 'undefined' ? wx : null
    return PROBE_APIS.map(name => ({
      key: 'api' + name,
      name: name,
      ok: !!(host && typeof host[name] === 'function')
    }))
  },

  onCopyDebug() {
    const content = debugLog.text() || '（暂无日志）'
    const host = typeof wx !== 'undefined' ? wx : null
    if (host && typeof host.setClipboardData === 'function') {
      host.setClipboardData({
        data: content,
        success: () => this.setData({ debugHint: '日志已复制' }),
        fail: () => this.setData({ debugHint: '当前环境不支持复制，请长按下方文字手动选中' })
      })
      return
    }
    this.setData({ debugHint: '当前环境不支持复制，请长按下方文字手动选中' })
  },

  onClearDebug() {
    debugLog.clear()
    this.refreshDebug()
    this.setData({ debugHint: '已清空' })
  }
})
