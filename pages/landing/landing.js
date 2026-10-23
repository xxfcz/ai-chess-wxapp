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
const engineProbe = require('../../utils/engine-probe')

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

/** 本页 route：跳转后用它和页面栈顶比对，作为「确实已经离开本页」的证据（见 _isPageHidden） */
const LANDING_ROUTE = 'pages/landing/landing'

/** 点了之后多久内的 onHide 才算「这次跳转真的切走了」（超出就当成切后台等无关隐藏） */
const NAV_EVIDENCE_MS = 5000

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
    envRows: [],
    /** 引擎连通性探测结果：同一份包在四个宿主里失败原因完全不同，必须能逐条量出来 */
    engineRows: [],
    engineHint: '',
    probing: false
  },

  onLoad() {
    /** 最近一次已询问过的剪贴板 FEN：同一内容只弹一次（与 analyze 共用同一去重语义） */
    this._lastPromptedFen = ''
    /** 最近一次跳转的结论（'' = 还没结论）：唯一目的是别把成功误报成失败（见 _isPageHidden） */
    this._navFailReason = ''
    /** 最近一次点击跳转的时间戳：onHide 撤误报时据此判断「是不是这一次跳转造成的切页」 */
    this._navPendingAt = 0
    this._hidden = false
    this._hideCount = 0
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

  /**
   * 页面被切走：这本身就是「上一次跳转生效了」的铁证。
   * 部分宿主（内置预览）不做 success/fail 回调，只能靠 onHide 补判；
   * 顺便把已经贴到界面上的「点击后没有响应」误报撤掉——用户返回时不该看到假错误。
   * 撤误报只认「刚点完就切走」（窗口内）：小程序切后台也会触发 onHide，那是另一回事。
   */
  onHide() {
    this._hidden = true
    this._hideCount = (this._hideCount || 0) + 1
    const justTapped = this._navPendingAt && (Date.now() - this._navPendingAt) <= NAV_EVIDENCE_MS
    if (this._navFailReason === 'no-callback' && this.data.navError && justTapped) {
      this._navFailReason = ''
      this.setData({ navError: '', copyHint: '' })
      debugLog.push('info', '[导航] 已离开页面 → 撤销「没有响应」误报（宿主未回调）')
    }
  },

  onShow() {
    this._hidden = false
    this._checkClipboardForFen()
  },

  /**
   * 宿主是否已经把本页切走（导航层超时前的取证入口）。
   * 两条独立证据：① onHide 过；② 页面栈顶已不是 landing（有的宿主不触发 onHide）。
   * 两条都拿不到就返回 false，让导航层照常显形「没有响应」——不猜。
   */
  _isPageHidden() {
    if (this._hidden) return true
    const route = navigation.topRoute()
    return !!route && route !== LANDING_ROUTE
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
   *
   * isPageHidden：宿主可能跳成功却不回调（内置预览实测如此），
   * 超时前用「页面已切走」取证，避免把成功报成「点击后没有响应」。
   */
  _go(url) {
    const host = typeof wx !== 'undefined' ? wx : null
    debugLog.push('info', '[导航] 前往 ' + url)
    this._navFailReason = ''
    this._navPendingAt = Date.now()
    // 重试即清上一次的残留错误：否则上一次的失败横幅会一直挂着，看起来像这次也失败了
    if (this.data.navError) this.setData({ navError: '', copyHint: '' })
    navigation.navigate(url, {
      host: host,
      isPageHidden: () => this._isPageHidden(),
      // 测试用它把看门狗压到几十毫秒，否则「宿主不回调」要等满 1.5 秒
      noCallbackMs: this._navTimeoutMs,
      onSuccess: info => {
        this._navFailReason = ''
        const how = info.via === 'page-hidden'
          ? '页面已切走 · 宿主未回调（静默成功）'
          : '第 ' + (info.attempts || 1) + ' 种形式' + (info.via ? ' · ' + info.via : '')
        debugLog.push('info', '[导航] 成功 · ' + (info.url || '') + '（' + how + '）')
      },
      onFail: info => {
        this._navFailReason = info.reason || 'unknown'
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

  /**
   * 探测远端引擎连通性（只读，不影响熔断/分析）。
   * 四个宿主的失败原因完全不同（域名白名单 / 沙箱路径 / 网关 403 / 明文 HTTP 被重置 /
   * 宿主不回调），这里一条条量出来，用户可以直接把这几行贴出来定位。
   */
  onProbeEngine() {
    if (this.data.probing) return
    this.setData({ probing: true, engineHint: '正在探测…', engineRows: [] })
    debugLog.push('info', '[探测] 开始探测云端引擎')
    engineProbe.probe({
      host: typeof wx !== 'undefined' ? wx : null,
      // 测试用它把超时压到几十毫秒，否则「宿主不回调」这条分支要等满 6 秒
      timeoutMs: this._probeTimeoutMs
    })
      .then(res => {
        const rows = (res.rows || []).map(row => Object.assign({}, row, { levelClass: 'lv-' + row.level }))
        this.setData({
          probing: false,
          engineRows: rows,
          engineHint: res.hint || ''
        })
        debugLog.push(res.reachable ? 'info' : 'warn',
          '[探测] ' + (res.reachable ? '通' : '不通') + ' · ' + (res.endpoint || '') + ' · ' + (res.hint || ''))
        rows.forEach(row => {
          debugLog.push(row.level === 'error' ? 'warn' : 'info',
            '[探测] ' + row.name + ' · ' + row.detail)
        })
      })
      .catch(err => {
        this.setData({
          probing: false,
          engineHint: '探测失败：' + ((err && err.message) || '未知原因')
        })
      })
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
