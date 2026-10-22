/**
 * pages/replay/replay.js（打谱模式 page，看板 L2-T7）
 *
 * 职责：导入 PGN → 走法树回放（主线 + 变例）→ 每步定位棋盘 + 引擎标注 + AI 点评（分支可点）。
 *
 * 设计要点：
 *   - 打谱的数据结构是**树**不是线性历史，所以这里用 L0 的 `Session`（FEN+UCI + 节点级缓存），
 *     而不是对弈/分析页的 `Game`。PGN 只在导入边界转换一次（`session.loadPgnTree`）。
 *   - 棋盘只读：不允许在打谱时走子（那会在别人的棋谱上乱改），落子能力留给对弈/分析模式。
 *   - 每步分析走节点级缓存：同一节点重访（反复前进后退）不再请求引擎，退/进分包也不重算
 *     （`Session` 把结果挂在节点上，重进页面时直接恢复）。
 *   - 复用 L1 组件（board-view / session-bar / engine-panel / comment-card / move-list）
 *     与 L0 服务（analysis / coach-runner / comment-model / pgn-tree / session-store）。
 *   - 点评/演示的页面级接线与 analyze/play 同构（同一套回调与交互态），不另造协议。
 */
const { Session } = require('../../utils/session')
const boardModel = require('../../utils/board-model')
const device = require('../../utils/device')
const ai = require('../../utils/ai-client')
const coachDemo = require('../../utils/coach-demo')
const coachRunner = require('../../utils/coach-runner')
const debugLog = require('../../utils/debug-log')
const { sessionStore } = require('../../utils/session-store')
const navigation = require('../../utils/navigation')

const DEPTH_OPTIONS = [2, 3, 4]
const DEFAULT_DEPTH_INDEX = 1
/** 切步后再分析，留一点时间合并连续快速点按 */
const AUTO_ANALYZE_DELAY = 200
const COACH_MIN_INTERVAL = 3000
const FEN_HINT = '也支持只贴 PGN 头 + 走法，或整段从对弈平台复制的 PGN'

/**
 * 内置示例：一条主线 + 一条变例（3... Nf6），用来验证「导入 → 回放 → 分支」全链路。
 * 新手不一定要手上有 PGN 才能看到打谱模式长什么样。
 */
const SAMPLE_PGN = [
  '[Event "示例对局"]',
  '[Site "黑白格大师"]',
  '[Date "2024.01.01"]',
  '[White "白方"]',
  '[Black "黑方"]',
  '[Result "1/2-1/2"]',
  '',
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 (3... Nf6 4. d3 Bc5) 4. c3 Nf6 5. d3 d6 1/2-1/2'
].join('\n')

Page({
  data: {
    /* —— 棋盘（只读） —— */
    hasGame: false,
    boardSize: 336,
    cellSize: 42,
    pieceFont: 38,
    labelFont: 9,
    cells: [],
    flipped: false,
    evalPercent: 50,
    evalLabel: '0.00',
    statusLabel: '白方行棋',
    statusTone: 'even',
    turnClass: 'w',
    terminalLabel: '',
    canUndo: false,
    canRedo: false,

    /* —— 棋谱信息 / 步进 —— */
    gameTitle: '打谱',
    gameMeta: '',
    stepNo: 0,
    stepTotal: 0,
    stepLabel: '起始局面',
    pathLine: '',
    inVariation: false,
    branchPoint: false,
    childOptions: [],
    moveRows: [],
    moveCount: 0,
    movesAnchor: '',

    /* —— 引擎分析 —— */
    depthOptions: DEPTH_OPTIONS,
    depthIndex: DEFAULT_DEPTH_INDEX,
    analyzing: false,
    analysisLines: [],
    analysisMeta: '',
    analysisError: '',
    engineSource: '',
    engineLabel: '',
    engineNotice: '',
    hintIndex: -1,

    /* —— AI 点评 —— */
    coachText: '',
    coachError: '',
    coachDetail: '',
    commentingHint: '正在请求云端模型，通常需要 3~15 秒…',
    coachModel: '',
    demoActive: false,
    demoLines: [],
    coachSegments: [],
    demoBreadcrumb: '',
    demoPlaying: false,
    demoCanBack: false,
    demoCanForward: false,
    commenting: false,
    cloudReady: true,
    cloudHint: '',

    /* —— 导入 —— */
    pgnInput: '',
    pgnHint: FEN_HINT,
    pgnCollapsed: false,
    importError: '',

    /* —— 调试 —— */
    debugOpen: false,
    debugRows: [],
    debugCount: 0,
    debugEnabled: false,

    tabs: [
      { key: 'engine', label: '引擎分析' },
      { key: 'coach', label: 'AI点评' },
      { key: 'moves', label: '走子记录' }
    ],
    activeTabKey: 'engine',
    tabAnchor: 'tab-top-engine'
  },

  /* ------------------------------------------------------------ 生命周期 */

  onLoad(options) {
    // 预览环境可能退到「不带 query」的 url 跳转，参数改由导航层暂存，这里取回（原生环境无感）
    options = navigation.mergeLaunchOptions(options)
    const metrics = boardModel.boardMetrics(
      device.getWindowWidth(),
      Math.floor(device.getWindowHeight() * 0.5)
    )

    this.session = null
    this._headers = null
    this._flipped = false
    this._drag = null
    this._destroyed = false
    /** 节点 id → { depth, entry }：本页面会话内的分析缓存（Session 节点上另有一份跨页面缓存） */
    this._cache = {}
    /** 节点 id → 请求时用的深度：判断「节点上的缓存」在当前深度下能不能复用 */
    this._cacheDepth = {}
    /** 当前展示中的分析（fen 用于判断「这一步有没有已经分析过」） */
    this._view = null
    this.hint = null
    this._realFocus = []
    this._analyzeTimer = null
    this._analyzePromise = null
    this._analyzeAgain = false
    this._lastCoachAt = 0
    this._coachTimer = null
    this._coachController = null
    this._coachCancelled = false
    this._coachStartedAt = 0
    this._engineDegraded = false
    this.demo = null
    this._demoParsed = null

    debugLog.install()
    debugLog.push('info', '[打谱] 页面加载 · ' + (device.canRequest() ? '可发起网络请求' : '无网络请求能力'))
    this._debugUnsubscribe = debugLog.subscribe(() => {
      if (this._destroyed || !this.data.debugOpen) return
      this.refreshDebug()
    })

    const cloudReady = device.canRequest()

    // 跨分包保留：退出去再进来，棋谱与已分析节点都还在（Session 挂在全局 store 上）
    const stored = sessionStore.getSession()
    const canReuse = !!(stored && sessionStore.getMode() === 'replay' && !options.pgn)

    this.setData({
      boardSize: metrics.boardSize,
      cellSize: metrics.cellSize,
      pieceFont: Math.round(metrics.cellSize * 0.86),
      labelFont: Math.max(8, Math.round(metrics.cellSize * 0.2)),
      cloudReady: cloudReady,
      cloudHint: cloudReady ? '' : ai.ENV_NO_NETWORK_TEXT,
      pgnCollapsed: canReuse
    })

    if (canReuse) {
      this.session = stored
      const meta = sessionStore.getSessionMeta()
      this._headers = (meta && meta.headers) || null
      this.setData(Object.assign({
        hasGame: true,
        pgnInput: (meta && meta.pgn) || ''
      }, this._metaPatch()))
      this.syncAll()
      const node = this.session.current()
      // 节点级缓存：同一局面重进页面也不再打引擎
      if (node.analysis) this.applyEntry(this.buildEntry(node.analysis))
      this.scheduleAnalyze()
      debugLog.push('info', '[打谱] 恢复上次棋谱 · 主线 ' + (this.session.mainLine().length - 1) + ' 步')
    } else {
      sessionStore.setSession(null, 'replay')
      this.setData({ hasGame: false, pgnCollapsed: false })
    }

    // 允许深链带入 PGN（例如分享/调试时直接打开某盘棋）
    if (options.pgn) {
      let text = ''
      try { text = decodeURIComponent(options.pgn) } catch (e) { text = String(options.pgn) }
      this.setData({ pgnInput: text })
      this.onImport()
    }
  },

  onUnload() {
    this._destroyed = true
    if (this.demo) this.demo.exit()
    if (this._analyzeTimer) clearTimeout(this._analyzeTimer)
    if (this._debugUnsubscribe) {
      this._debugUnsubscribe()
      this._debugUnsubscribe = null
    }
    if (this._coachTimer) {
      clearInterval(this._coachTimer)
      this._coachTimer = null
    }
    if (this._coachController) {
      try { this._coachController.abort() } catch (e) { /* 重复中断忽略 */ }
    }
  },

  onShow() {
    // 打谱页不自动读剪贴板：导入是显式动作（有「从剪贴板载入」按钮），避免边看棋边被弹窗打断
  },

  /* -------------------------------------------------------- 棋谱信息 / 同步 */

  _metaPatch() {
    const h = this._headers || {}
    const hasPlayers = !!(h.White || h.Black)
    const title = hasPlayers ? ((h.White || '白方') + ' vs ' + (h.Black || '黑方')) : '打谱'
    const parts = []
    if (h.Event) parts.push(h.Event)
    if (h.Date && h.Date !== '????.??.??') parts.push(h.Date)
    if (h.Result && h.Result !== '?') parts.push('结果 ' + h.Result)
    return { gameTitle: title, gameMeta: parts.join(' · ') }
  },

  depth() {
    return DEPTH_OPTIONS[this.data.depthIndex] || 3
  },

  syncAll() {
    if (!this.session) return
    const session = this.session
    const node = session.current()
    const path = session.pathToCurrent()
    const ply = path.length - 1
    const mainTotal = session.mainLine().length - 1
    const status = session.status(node.fen)
    const children = node.children || []
    const sans = path.slice(1).map(n => n.san).filter(Boolean)
    const tail = sans.slice(-12)

    this.setData({
      statusLabel: status.label,
      statusTone: status.over ? 'over' : status.inCheck ? 'check' : 'even',
      turnClass: session.turn(node.fen),
      flipped: this._flipped,
      terminalLabel: status.over ? status.label : '',
      canUndo: !!node.parentId,
      canRedo: children.length > 0,
      cells: this.buildCells(),
      moveRows: this.buildMoveRows(node.id),
      moveCount: mainTotal,
      stepNo: ply,
      stepTotal: mainTotal,
      stepLabel: ply === 0
        ? (this._headers && this._headers.FEN ? '起始局面（指定 FEN）' : '起始局面')
        : '第 ' + ply + ' 步 · ' + (node.san || ''),
      pathLine: (sans.length > 12 ? '… ' : '') + tail.join(' '),
      inVariation: ply > 0 && !session.isMainLine(node),
      branchPoint: children.length > 1,
      childOptions: children.map(function (child, i) {
        return {
          key: child.id,
          id: child.id,
          san: child.san,
          main: i === 0,
          label: (i === 0 ? '主线 ' : '分支 ') + child.san
        }
      })
    })
  },

  /** 主线走法表（每条带节点 id，点一下可定位；当前所在的那一手高亮） */
  buildMoveRows(activeId) {
    const main = this.session.mainLine()
    const rows = []
    for (let i = 1; i < main.length; i += 2) {
      const w = main[i]
      const b = main[i + 1]
      const no = (i + 1) / 2
      rows.push({
        no: no,
        key: 'mv' + no,
        white: w ? w.san : '',
        black: b ? b.san : '',
        whiteKey: w ? w.id : '',
        blackKey: b ? b.id : '',
        whiteActive: !!w && w.id === activeId,
        blackActive: !!b && b.id === activeId
      })
    }
    return rows
  },

  buildCells() {
    const node = this.session.current()
    return boardModel.buildCells({
      board: this.session.board(node.fen),
      flipped: this._flipped,
      selected: null,
      legalTargets: [],
      lastMove: node.from ? { from: node.from, to: node.to } : null,
      checkSquare: this.session.kingSquareUnderCheck(node.fen),
      hint: this.hint,
      hiddenSquare: null,
      focus: this._realFocus || []
    })
  },

  demoActive() {
    return !!(this.demo && this.demo.active)
  },

  /* -------------------------------------------------------------- 导航 */

  /**
   * 切到另一个节点后的统一收尾：清掉上一步的点评/演示/提示，重渲棋盘与列表，再排队分析。
   * 点评文字属于「上一个局面」，跟着局面走才不会指错。
   */
  afterNavigate() {
    if (this._destroyed || !this.session) return
    if (this.demo) {
      this.demo.exit()
      this.demo = null
    }
    this._demoParsed = null
    this._clearCoach()
    this.hint = null
    this._realFocus = []
    this.setData({
      demoActive: false,
      demoBreadcrumb: '',
      demoPlaying: false,
      demoCanBack: false,
      demoCanForward: false
    })
    this.syncAll()
    this.scheduleAnalyze()
  },

  onStepBack() {
    if (!this.session) return
    if (this.demoActive()) this.onDemoExit()
    if (!this.session.parent()) return
    this.afterNavigate()
  },

  onStepForward() {
    if (!this.session) return
    if (this.demoActive()) this.onDemoExit()
    if (!this.session.stepForward()) return
    this.afterNavigate()
  },

  onReset() {
    if (!this.session) return
    if (this.demoActive()) this.onDemoExit()
    this.session.gotoRoot()
    this.afterNavigate()
  },

  onGotoEnd() {
    if (!this.session) return
    if (this.demoActive()) this.onDemoExit()
    const main = this.session.mainLine()
    if (!main.length) return
    this.session.goto(main[main.length - 1].id)
    this.afterNavigate()
  },

  /** 跳到指定节点：走法列表点击、分支 chips、点评里的走法链接都走这里 */
  onGotoNode(e) {
    if (!this.session) return
    const d = (e && e.detail) ? e.detail
      : (e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {})
    const id = d.node || d.id || ''
    if (!id) return
    if (this.demoActive()) this.onDemoExit()
    if (!this.session.goto(id)) return
    this.afterNavigate()
  },

  onFlip() {
    if (this.demoActive()) {
      this.demo.flip()
      this.setData(this.demo.view())
      return
    }
    this._flipped = !this._flipped
    this.setData({ flipped: this._flipped })
    this.syncAll()
  },

  /* -------------------------------------------------------------- Tabs */

  onSwitchTab(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.tab : ''
    if (!key || key === this.data.activeTabKey) return
    this.setData({ activeTabKey: key, tabAnchor: 'tab-top-' + key })
  },

  /* -------------------------------------------------------------- 引擎标注 */

  scheduleAnalyze() {
    if (this._destroyed || !this.session) return
    if (this._analyzeTimer) clearTimeout(this._analyzeTimer)
    this._analyzeTimer = setTimeout(() => {
      this._analyzeTimer = null
      this.runAnalyze()
    }, AUTO_ANALYZE_DELAY)
  },

  onDepthChange(e) {
    const index = Number(e.detail.value)
    if (!(index >= 0) || index >= DEPTH_OPTIONS.length) return
    this.setData({ depthIndex: index })
    this.runAnalyze()
  },

  onAnalyze() {
    this.runAnalyze()
  },

  /**
   * 分析当前节点。命中缓存（本页 _cache 或 Session 节点上挂的 analysis）就直接渲染，
   * 否则排队请求引擎；正在分析时若又切了局面，收尾后自动补跑当前局面。
   */
  runAnalyze() {
    if (this._destroyed || !this.session) return Promise.resolve()
    const node = this.session.current()
    const depth = this.depth()

    const cached = this._cache[node.id]
    if (cached && cached.depth === depth) {
      this.applyEntry(cached.entry)
      return Promise.resolve()
    }

    // 跨页面缓存：Session 节点自己存了上一次的分析结果（重进打谱页时走这条）。
    // 只有「深度未知（说明是上一次进入页面留下的）」或「深度一致」时才复用，
    // 否则改深度就必须重算——不能拿深度 2 的结果冒充深度 4。
    const nodeCached = this.session.getAnalysis(node.id)
    if (nodeCached) {
      const knownDepth = this._cacheDepth[node.id]
      if (knownDepth === undefined || knownDepth === depth) {
        const entry = this.buildEntry(nodeCached)
        this._cache[node.id] = { depth: depth, entry: entry }
        this._cacheDepth[node.id] = depth
        this.applyEntry(entry)
        return Promise.resolve()
      }
    }

    if (this._analyzePromise) {
      this._analyzeAgain = true
      return this._analyzePromise
    }

    this._analyzePromise = this.doAnalyze(node, depth).then(
      () => this.settleAnalyze(),
      () => this.settleAnalyze()
    )
    return this._analyzePromise
  },

  settleAnalyze() {
    this._analyzePromise = null
    if (this._analyzeAgain && !this._destroyed) {
      this._analyzeAgain = false
      this.runAnalyze()
    }
  },

  async doAnalyze(node, depth) {
    if (this._destroyed) return
    this.setData({ analyzing: true, analysisError: '' })

    try {
      const result = await ai.analyzePosition({
        fen: node.fen,
        depth: depth,
        multiPV: 3,
        onProgress: info => {
          if (this._destroyed || !info || !info.reached) return
          this.setData({ analysisMeta: '已完成深度 ' + info.reached + '…' })
        }
      })
      if (this._destroyed) return

      const entry = this.buildEntry(result)
      this._cache[node.id] = { depth: depth, entry: entry }
      this._cacheDepth[node.id] = depth
      // L0 节点级缓存：重访同一节点（含退出页面再进入）不再请求引擎
      this.session.cacheAnalysis(node.id, result)

      // 分析期间已经切走了：结果只入缓存，不覆盖当前画面
      if (this.session.currentId() !== node.id) {
        this._analyzeAgain = true
        return
      }
      this.applyEntry(entry)
      this.noticeEngineDegrade(entry, result)
      // 演示跑在临时副本上：分析晚到不能把演示中的棋盘顶回真实局面
      if (!this.demoActive()) this.syncAll()
    } catch (err) {
      if (this._destroyed) return
      this.setData({
        analysisError: (err && err.message) || '分析失败，请重试',
        analysisLines: []
      })
    } finally {
      if (!this._destroyed) this.setData({ analyzing: false })
    }
  },

  /** 把引擎结果整理成一份可直接 setData 的展示数据（缓存里存的就是它） */
  buildEntry(result) {
    const sideToMove = result.sideToMove ||
      (this.session ? this.session.turn(this.session.current().fen) : 'w')
    const views = this.buildLineViews(result.lines, sideToMove)
    const best = result.lines && result.lines.length ? ai.formatScore(result.lines[0], sideToMove) : null
    const src = ai.describeEngineSource(result)
    return {
      views: views,
      result: result,
      sideToMove: sideToMove,
      source: src.source,
      label: src.label,
      notice: src.notice,
      degraded: !!src.degraded,
      evalPercent: best ? ai.evalPercent(best.whiteCp) : 50,
      evalLabel: best ? best.text : '—',
      meta: this.buildAnalysisMeta(result, src)
    }
  },

  applyEntry(entry) {
    if (!entry) return
    this._view = {
      fen: this.session ? this.session.current().fen : '',
      result: entry.result
    }
    this.hint = null
    this.setData({
      analysisLines: entry.views,
      analysisMeta: entry.meta,
      engineSource: entry.source,
      engineLabel: entry.label,
      engineNotice: entry.notice,
      evalPercent: entry.evalPercent,
      evalLabel: entry.evalLabel,
      analysisError: '',
      hintIndex: -1
    })
  },

  buildLineViews(rawLines, sideToMove, activeIndex) {
    const active = typeof activeIndex === 'number' ? activeIndex : -1
    return (rawLines || []).map(function (item, i) {
      const view = ai.buildLineView(item, sideToMove)
      view.idx = i
      view.key = 'line' + i
      view.active = i === active
      return view
    })
  },

  applyLineActive(activeIndex) {
    const list = this.data.analysisLines || []
    let changed = false
    const next = list.map(function (item, i) {
      const want = i === activeIndex
      if (!!item.active === want) return item
      changed = true
      return Object.assign({}, item, { active: want })
    })
    if (changed) this.setData({ analysisLines: next })
  },

  buildAnalysisMeta(result, src) {
    if (result.terminal) return '局面已结束'
    const tag = (src && src.label) || '引擎'
    return tag + ' · 深度 ' + result.depth + ' · ' + result.nodes + ' 节点 · ' + result.elapsedMs + 'ms'
  },

  noticeEngineDegrade(entry, result) {
    if (!(entry && entry.degraded)) {
      if (this._engineDegraded) { this._engineDegraded = false; device.toast('云端引擎已恢复') }
      return
    }
    if (this._engineDegraded) return
    this._engineDegraded = true
    device.toast('云端引擎不可用，已改用本地引擎')
    debugLog.push('warn', '[引擎] 已降级到本地 · ' + ((result && result.degradedFrom) || ''))
  },

  /** 点一条路线：在棋盘上预览这步走法（不改变棋谱位置） */
  onPreviewLine(e) {
    const index = (e && e.detail && e.detail.index != null)
      ? e.detail.index
      : (e && e.currentTarget && e.currentTarget.dataset ? Number(e.currentTarget.dataset.index) : NaN)
    const line = this.data.analysisLines[index]
    if (!line) return
    if (this.data.hintIndex === index) {
      this.hint = null
      this.setData({ hintIndex: -1 })
      this.applyLineActive(-1)
    } else {
      this.hint = { from: line.from, to: line.to }
      this.setData({ hintIndex: index })
      this.applyLineActive(index)
    }
    this.syncAll()
  },

  /** 确保当前局面已有分析（点评前兜底） */
  async ensureAnalysis(fen) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this._destroyed) return false
      if (this._view && this._view.fen === fen) return true
      await this.runAnalyze()
    }
    return !!(this._view && this._view.fen === fen)
  },

  /* -------------------------------------------------------------- PGN 导入 */

  onToggleImport() {
    this.setData({ pgnCollapsed: !this.data.pgnCollapsed })
  },

  onPgnInput(e) {
    this.setData({ pgnInput: (e && e.detail ? e.detail.value : '') || '', importError: '' })
  },

  onUseSample() {
    this.setData({ pgnInput: SAMPLE_PGN, importError: '', pgnCollapsed: false })
    device.toast('已填入示例 PGN，点「载入」开始回放')
  },

  /** 手动从剪贴板读 PGN：用户显式点击，直接尝试导入 */
  onPastePgn() {
    const host = typeof wx !== 'undefined' ? wx : null
    if (!host || typeof host.getClipboardData !== 'function') {
      device.toast('当前环境不支持读取剪贴板')
      return
    }
    host.getClipboardData({
      success: res => {
        if (this._destroyed) return
        const raw = (res && typeof res.data === 'string') ? res.data : ''
        if (!raw.trim()) { device.toast('剪贴板是空的'); return }
        this.setData({ pgnInput: raw, importError: '' })
        this.onImport()
      },
      fail: () => device.toast('读取剪贴板失败')
    })
  },

  onImport() {
    const raw = (this.data.pgnInput || '').trim()
    if (!raw) {
      device.toast('请先粘贴 PGN')
      return false
    }
    return this.loadPgn(raw)
  },

  /**
   * 载入一段 PGN：解析成功才替换当前棋谱（失败不动既有棋盘），并清空旧的分析/点评。
   * @returns {boolean}
   */
  loadPgn(text) {
    const session = new Session()
    const parsed = session.loadPgnTree(text)
    if (!parsed || !parsed.ok) {
      const msg = (parsed && parsed.error) || 'PGN 解析失败'
      this.setData({ importError: msg, pgnCollapsed: false })
      debugLog.push('warn', '[打谱] PGN 解析失败 · ' + msg)
      return false
    }

    if (this.demo) { this.demo.exit(); this.demo = null }
    this._demoParsed = null
    this._clearCoach()
    this.session = session
    this._headers = parsed.headers || {}
    this._cache = {}
    this._cacheDepth = {}
    this._view = null
    this._flipped = false
    this.hint = null
    this._realFocus = []
    this._engineDegraded = false

    sessionStore.setSession(session, 'replay', {
      headers: this._headers,
      plyCount: parsed.plyCount,
      variationCount: parsed.variationCount,
      result: parsed.result || '',
      pgn: text
    })
    sessionStore.setAnalysis(null)

    this.setData(Object.assign({
      hasGame: true,
      importError: '',
      pgnCollapsed: true,
      pgnInput: text,
      flipped: false,
      analysisLines: [],
      analysisMeta: '',
      analysisError: '',
      engineSource: '',
      engineLabel: '',
      engineNotice: '',
      evalPercent: 50,
      evalLabel: '0.00',
      hintIndex: -1,
      demoActive: false,
      demoBreadcrumb: '',
      demoPlaying: false,
      demoCanBack: false,
      demoCanForward: false
    }, this._metaPatch()))

    this.syncAll()
    this.scheduleAnalyze()

    const mainPly = session.mainLine().length - 1
    const extra = parsed.variationCount ? ' · ' + parsed.variationCount + ' 条变例' : ''
    debugLog.push('info', '[打谱] 载入成功 · 主线 ' + mainPly + ' 步' + extra +
      ' · 共 ' + session.nodeCount() + ' 个节点')
    device.toast('已载入 · 主线 ' + mainPly + ' 步' + extra)
    return true
  },

  /* ---------------------------------------------------------- AI 点评 */

  updateCoachHint() {
    if (!this.data.commenting) return
    const seconds = Math.max(1, Math.round((Date.now() - this._coachStartedAt) / 1000))
    const model = this.data.coachModel ? '（' + this.data.coachModel + '）' : ''
    this.setData({ commentingHint: '正在等待云端模型' + model + '返回，已等待 ' + seconds + ' 秒…' })
  },

  /** 清掉点评与演示（切步/重新导入时调用；不弹「已取消」提示） */
  _clearCoach() {
    this._coachCancelled = true
    if (this._coachTimer) { clearInterval(this._coachTimer); this._coachTimer = null }
    if (this._coachController) {
      try { this._coachController.abort() } catch (e) { /* 重复中断忽略 */ }
      this._coachController = null
    }
    this.setData({
      commenting: false,
      coachText: '',
      coachError: '',
      coachDetail: '',
      coachModel: '',
      coachSegments: [],
      demoLines: []
    })
  },

  cancelCoach() {
    this._clearCoach()
    this._lastCoachAt = 0
    device.toast('已取消本次点评')
  },

  /** 手动点评当前局面（打谱不自动点评：逐 step 调模型既慢又吵） */
  onCoach() {
    if (this.data.commenting) { this.cancelCoach(); return }
    if (!this.session) return
    if (!this.data.cloudReady) {
      device.toast('当前环境无法发起云端请求')
      return
    }
    const now = Date.now()
    if (now - this._lastCoachAt < COACH_MIN_INTERVAL) { device.toast('请求过于频繁，请稍候'); return }

    const node = this.session.current()
    const fen = node.fen
    const start = result => {
      if (this._destroyed) return
      this._lastCoachAt = Date.now()
      this._runCoachCommentWith(fen, result, { hint: '正在请求云端模型，通常需要 3~15 秒…' })
    }

    if (!this._view || this._view.fen !== fen) {
      this.ensureAnalysis(fen).then(ready => {
        if (this._destroyed) return
        if (!ready) { device.toast('请先完成局面分析'); return }
        start(this._view ? this._view.result : null)
      })
      return
    }
    start(this._view.result)
  },

  _runCoachCommentWith(fen, result, opts) {
    opts = opts || {}
    const Controller = typeof AbortController === 'function' ? AbortController : null
    const controller = Controller ? new Controller() : null
    this._coachController = controller
    this._coachCancelled = false
    this._coachStartedAt = Date.now()

    if (this.demo) this.demo.exit()
    this.demo = null
    this._demoParsed = null
    this._realFocus = []
    this.setData({
      commenting: true,
      coachText: '',
      coachError: '',
      coachDetail: '',
      coachModel: '',
      demoLines: [],
      coachSegments: [],
      demoActive: false,
      demoBreadcrumb: '',
      demoPlaying: false,
      demoCanBack: false,
      demoCanForward: false,
      commentingHint: opts.hint || '正在请求云端模型，通常需要 3~15 秒…'
    })

    if (this._coachTimer) clearInterval(this._coachTimer)
    this._coachTimer = setInterval(() => this.updateCoachHint(), 1000)

    coachRunner.runCoachComment({
      fen: fen,
      sideToMove: result ? result.sideToMove : (this.session ? this.session.turn(fen) : 'w'),
      lines: result ? result.lines : [],
      result: result,
      onDelta: value => {
        if (this._destroyed || this._coachCancelled) return
        this.setData({ coachText: coachDemo.stripDemoBlock(value) })
      },
      onModel: info => {
        if (this._destroyed) return
        const label = (info && info.label) || ''
        if (label !== this.data.coachModel) this.setData({ coachModel: label })
        this.updateCoachHint()
      },
      onResult: r => {
        if (this._destroyed || this._coachCancelled) return
        this._onCoachResult(r.parsed, fen)
        this._finalizeCoach()
      },
      onError: info => {
        if (this._destroyed || this._coachCancelled) return
        debugLog.push('error', '[点评] 失败 · ' + (info.kind || 'unknown') + ' · ' + (info.detail || info.message))
        this.setData({ coachError: info.message, coachDetail: info.detail || '', commenting: false })
        this._finalizeCoach()
      },
      onWarn: w => { debugLog.push('warn', '[点评] ' + w) },
      signal: controller ? controller.signal : undefined
    })
  },

  _onCoachResult(parsed, fen) {
    this._demoParsed = parsed.lines.length ? { lines: parsed.lines, rootFen: fen } : null
    this.demo = this._demoParsed
      ? new coachDemo.DemoSession(parsed.lines, fen, { flipped: this._flipped })
      : null
    this.setData({
      coachText: parsed.prose,
      commenting: false,
      demoLines: this.demo ? this.demo.lineViews() : [],
      coachSegments: coachDemo.tokenizeText(parsed.prose, { lines: parsed.lines, colorMode: 'branch' }) || [],
      demoActive: false,
      demoBreadcrumb: '',
      demoPlaying: false,
      demoCanBack: false,
      demoCanForward: false
    })
  },

  _finalizeCoach() {
    if (this._coachTimer) { clearInterval(this._coachTimer); this._coachTimer = null }
    this._coachController = null
  },

  /* ---------------------------------------------------------- 走法演示 */

  _ensureDemo() {
    if (this.demo) return true
    if (!this._demoParsed || !this._demoParsed.lines.length) return false
    this.demo = new coachDemo.DemoSession(this._demoParsed.lines, this._demoParsed.rootFen, { flipped: this._flipped })
    return true
  },

  onEnterDemo(e) {
    const lineId = (e && e.detail && e.detail.line != null)
      ? e.detail.line
      : (e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.line : '')
    if (!lineId || !this._ensureDemo()) return
    this.demo.enter(lineId)
    this.setData(this.demo.view())
  },

  onDemoStep(e) {
    if (!this.demo) return
    const dir = Number((e && e.detail && e.detail.dir != null)
      ? e.detail.dir
      : (e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.dir : 0))
    this.demo.step(dir > 0 ? 1 : -1)
    this.setData(this.demo.view())
  },

  onDemoPlay() {
    if (!this.demo) return
    if (this.demo.playing) { this.demo.pause(); this.setData({ demoPlaying: false }); return }
    this.demo.play(() => this.setData(this.demo.view()))
    this.setData(this.demo.view())
  },

  onDemoExit() {
    if (this.demo) this.demo.exit()
    this.demo = null
    this.setData({
      demoActive: false,
      demoBreadcrumb: '',
      demoPlaying: false,
      demoCanBack: false,
      demoCanForward: false
    })
    this.syncAll()
  },

  onCoachTokenTap(e) {
    const d = (e && e.detail) ? e.detail
      : (e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {})
    if (d.sq || d.piece) return this._focusToken(d)
    if (!d.line || !this._ensureDemo()) return
    this.demo.enterAt(d.line, Number(d.ply) || 0)
    this.setData(this.demo.view())
  },

  _focusToken(d) {
    const line = d.line || ''
    let squares = []
    let useDemo = false
    if (d.piece) {
      if (line && this._ensureDemo()) {
        useDemo = true
        this.demo.enterAt(line, Number(d.ply) || 0)
        squares = this.demo.findPieces(d.piece)
      } else if (this.session) {
        squares = this._pieceSquares(d.piece)
      }
    } else if (line && this._ensureDemo()) {
      useDemo = true
      this.demo.enterAt(line, Number(d.ply) || 0)
      squares = [d.sq]
    } else {
      squares = [d.sq]
    }
    if (useDemo && this.demoActive()) {
      this.demo.setFocus(squares)
      this.setData(this.demo.view())
      return
    }
    this._realFocus = squares.filter(function (sq) { return !!sq })
    this.syncAll()
  },

  /** 打谱棋盘只读，点评里点「白车」这类棋子记号时按当前局面找同名棋子 */
  _pieceSquares(token) {
    if (!this.session || typeof token !== 'string' || token.length < 2) return []
    const color = token.charAt(0)
    const type = token.charAt(1)
    const board = this.session.board()
    if (!board) return []
    const out = []
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const p = board[row][col]
        if (p && p.color === color && p.type === type) {
          out.push(String.fromCharCode(97 + col) + (8 - row))
        }
      }
    }
    return out
  },

  /* ---------------------------------------------------------- 点评复制 */

  _proseText() {
    return (this.data.coachText || '').trim()
  },

  _lineText(lineId) {
    if (!this._demoParsed || !this._demoParsed.lines.length) return ''
    const line = this._demoParsed.lines.find(l => l.id === lineId)
    if (!line) return ''
    return coachDemo.linePlainText(line, this.session ? this.session.turn() : 'w')
  },

  _branchText() {
    if (!this._demoParsed || !this._demoParsed.lines.length) return ''
    return coachDemo.branchPlainText(this._demoParsed.lines, this.session ? this.session.turn() : 'w')
  },

  _openCopyMenu(lineId) {
    const opts = []
    if (lineId) {
      const one = this._lineText(lineId)
      if (one) opts.push({ label: '复制这条分支', text: one })
    }
    const branches = this._branchText()
    if (branches) opts.push({ label: lineId ? '复制全部分支' : '复制分支走法', text: branches })
    const prose = this._proseText()
    if (prose) opts.push({ label: '复制点评原文', text: prose })
    if (prose && branches) {
      opts.push({
        label: '复制全部（正文+分支）',
        text: coachDemo.coachPlainText(prose, this._demoParsed.lines, this.session ? this.session.turn() : 'w')
      })
    }
    if (!opts.length) { device.toast('还没有可复制的点评'); return }
    if (opts.length === 1) { device.copyText(opts[0].text); return }
    const picked = device.actionSheet(opts.map(o => o.label), idx => {
      if (typeof idx === 'number' && idx >= 0 && opts[idx]) device.copyText(opts[idx].text)
    })
    if (!picked) device.copyText(opts[0].text)
  },

  onCopyCoach() { this._openCopyMenu('') },
  onCoachLongPress() { this._openCopyMenu('') },

  onLineLongPress(e) {
    const d = (e && e.detail) ? e.detail
      : (e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {})
    this._openCopyMenu(d.line || '')
  },

  /* ------------------------------------------------------------ 运行日志 */

  refreshDebug() {
    const rows = debugLog.list()
    this.setData({ debugRows: rows.slice().reverse(), debugCount: rows.length })
  },

  onToggleDebug() {
    const open = !this.data.debugOpen
    this.setData({ debugOpen: open })
    if (open) this.refreshDebug()
  },

  onClearDebug() {
    debugLog.clear()
    this.refreshDebug()
  },

  onCopyDebug() {
    const content = debugLog.text() || '（暂无日志）'
    const host = typeof wx !== 'undefined' ? wx : null
    if (host && typeof host.setClipboardData === 'function') {
      host.setClipboardData({
        data: content,
        success: () => device.toast('日志已复制'),
        fail: () => device.toast('复制失败，可长按选中文字')
      })
      return
    }
    device.toast('当前环境不支持复制，请长按选中文字')
  },

  onToggleEnableDebug() {
    const host = typeof wx !== 'undefined' ? wx : null
    if (!host || typeof host.setEnableDebug !== 'function') {
      device.toast('当前环境没有调试面板接口，请用「复制」导出日志')
      return
    }
    const next = !this.data.debugEnabled
    host.setEnableDebug({
      enableDebug: next,
      success: () => {
        this.setData({ debugEnabled: next })
        device.toast(next ? '调试面板已开启，重新进入小程序后生效' : '调试面板已关闭')
      },
      fail: () => device.toast('调试面板切换失败')
    })
  }
})
