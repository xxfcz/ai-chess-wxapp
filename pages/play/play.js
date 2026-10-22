/**
 * pages/play/play.js（对弈模式 page）
 * 玩家 vs 陪练（sparrer，引擎出着）：每步自动分析 + 点评（受 autoCoach + playCoachScope 门控）。
 *
 * 设计要点（看板 L2-T6 / 方案 §11.4）：
 *   - 棋盘不用 Canvas，沿用 8×8 view 网格（与 analyze 一致，任何环境可跑）。
 *   - 复用 L1 组件（board-view / session-bar / engine-panel / comment-card / move-list）
 *     与 L0 服务（engine-service 分析、coach-service 点评、session-store 跨分包），不重复实现。
 *   - 走子护栏：仅玩家自己行棋方（playAs）且轮到玩家、且 AI 不在思考时才能落子，杜绝自由模拟。
 *   - 引擎回着：玩家落子后自动分析，轮到 sparrer 时由引擎取最佳走法应着。
 *   - 点评触发：autoCoach=off 从不自动；on/remoteOnly 受 cloudReady 约束；对弈专属 playCoachScope
 *     决定「每步(allSteps)」还是「仅关键步(keySteps)」——关键步 = |Δcp|≥阈值 或 吃子/将军/送将。
 */
const { Game, START_FEN, isValidFen, extractFen } = require('../../utils/game')
const geometry = require('../../utils/geometry')
const boardModel = require('../../utils/board-model')
const device = require('../../utils/device')
const ai = require('../../utils/ai-client')
const coachDemo = require('../../utils/coach-demo')
const coachRunner = require('../../utils/coach-runner')
const settings = require('../../utils/settings')
const debugLog = require('../../utils/debug-log')
const { sessionStore } = require('../../utils/session-store')
const navigation = require('../../utils/navigation')

const DEPTH_OPTIONS = [2, 3, 4]
const DEFAULT_DEPTH_INDEX = 1
const AUTO_ANALYZE_DELAY = 280
const COACH_MIN_INTERVAL = 3000
const FEN_HINT = '支持完整 6 段 FEN，也支持只写棋子布局（自动补全）'
/** 手指移动超过该距离才算拖拽，否则视为点选 */
const DRAG_THRESHOLD = 6
/** 触摸事件可用时，系统还会合成一次 tap，靠时间窗忽略它 */
const TAP_SUPPRESS_MS = 700

/** sparrer 强度档：深度越小越弱（陪练而非碾压） */
const SPARRER_LEVELS = [
  { key: 'easy', label: '入门', depth: 2 },
  { key: 'standard', label: '标准', depth: 3 },
  { key: 'strong', label: '强', depth: 4 }
]

Page({
  data: {
    boardSize: 336,
    cellSize: 42,
    pieceFont: 38,
    labelFont: 9,
    cells: [],
    ghost: null,
    fenInput: START_FEN,
    fenHint: FEN_HINT,
    fenCollapsed: true,
    statusLabel: '白方行棋',
    statusTone: 'even',
    turnClass: 'w',
    flipped: false,
    canUndo: false,
    canRedo: false,
    moveRows: [],
    moveCount: 0,
    movesAnchor: '',
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
    evalPercent: 50,
    evalLabel: '0.00',
    terminalLabel: '',
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
    tabAnchor: 'tab-top-engine',
    /* —— 对弈模式专有 —— */
    playAs: 'w',
    sparrerColor: 'b',
    myTurn: true,
    engineThinking: false,
    thinkingLabel: '',
    strengthOptions: SPARRER_LEVELS,
    strengthKey: 'standard',
    sparrerDepth: 3,
    sideOptions: [
      { key: 'w', label: '我执白', icon: '白' },
      { key: 'b', label: '我执黑', icon: '黑' }
    ]
  },

  /* ------------------------------------------------------------ 生命周期 */

  onLoad(options) {
    // 预览环境可能退到「不带 query」的 url 跳转，参数改由导航层暂存，这里取回（原生环境无感）
    options = navigation.mergeLaunchOptions(options)
    const metrics = boardModel.boardMetrics(
      device.getWindowWidth(),
      Math.floor(device.getWindowHeight() * 0.5)
    )

    // 设置：玩家执子方 + sparrer 强度 + 自动点评偏好
    const s = settings.getSettings()
    let playAs = (options.side === 'w' || options.side === 'b') ? options.side : s.playAs
    playAs = (playAs === 'w' || playAs === 'b') ? playAs : 'w'
    const strength = SPARRER_LEVELS.find(l => l.key === s.sparrerLevel) || SPARRER_LEVELS[1]
    this._sparrerDepth = strength.depth

    // 全局 store：跨分包保留当前棋局（退出对弈再进入不丢局面）
    const storedGame = sessionStore.getGame()
    this.game = (storedGame && sessionStore.getMode() === 'play' && !options.fen)
      ? storedGame
      : new Game(START_FEN)
    sessionStore.setGame(this.game, 'play')
    this.game.flipped = (playAs === 'b')

    this.hint = null
    this._drag = null
    this._touchHandledAt = 0
    this._destroyed = false
    this._engineThinking = false
    this._analyzePromise = null
    this._runningFen = null
    this._analyzeAgain = false
    this._lastResult = null
    this._analysisFen = ''
    this._fenEditing = false
    this._engineDegraded = false
    this._lastPromptedFen = ''
    this._lastCoachAt = 0
    this._coachTimer = null
    this._coachController = null
    this._coachCancelled = false
    this._coachStartedAt = 0
    this._pendingWho = 'kickoff'
    this._preMoveWhiteCp = null
    this._inCheckBefore = false
    this._lastPlayerMove = null
    this._gaveCheck = false
    this.demo = null
    this._demoParsed = null
    this._realFocus = []
    this._playAs = playAs
    this._sparrerColor = (playAs === 'w' ? 'b' : 'w')

    if (options.fen) {
      try {
        this.game.load(options.fen)
        sessionStore.setAnalysis(null)
      } catch (e) { /* 非法 fen 忽略 */ }
    }

    debugLog.install()
    debugLog.push('info', '[对弈] 页面加载 · 玩家执' + (playAs === 'w' ? '白' : '黑') +
      ' · ' + (device.canRequest() ? '可发起网络请求' : '无网络请求能力'))
    this._debugUnsubscribe = debugLog.subscribe(() => {
      if (this._destroyed || !this.data.debugOpen) return
      this.refreshDebug()
    })

    const cloudReady = device.canRequest()

    const saved = sessionStore.getAnalysis()
    if (saved && saved.fen === this.game.getFen()) {
      this._lastResult = saved.result
      this._analysisFen = saved.fen
      this.setData({
        analysisLines: saved.lines,
        engineSource: saved.engineSource,
        engineLabel: saved.engineLabel,
        engineNotice: saved.engineNotice,
        evalPercent: saved.evalPercent,
        evalLabel: saved.evalLabel,
        analysisMeta: saved.analysisMeta
      })
    }

    this.setData({
      boardSize: metrics.boardSize,
      cellSize: metrics.cellSize,
      pieceFont: Math.round(metrics.cellSize * 0.86),
      labelFont: Math.max(8, Math.round(metrics.cellSize * 0.2)),
      playAs: playAs,
      sparrerColor: this._sparrerColor,
      strengthKey: strength.key,
      sparrerDepth: this._sparrerDepth,
      flipped: this.game.flipped,
      cloudReady: cloudReady,
      cloudHint: cloudReady ? '' : ai.ENV_NO_NETWORK_TEXT
    })
    this.syncAll()
    this.recomputeTurn()
    // 开新局或恢复后，按当前行棋方决定要不要 sparrer 先走
    this.scheduleAnalyze('kickoff')
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
    // 对弈页不打扰剪贴板自动导入（那是 Landing/分析页的职责），避免对局中弹窗
  },

  /* -------------------------------------------------------------- 同步 */

  syncAll() {
    const game = this.game
    const status = game.status()
    const history = game.history()
    const rows = []
    for (let i = 0; i < history.length; i += 2) {
      const no = i / 2 + 1
      rows.push({
        no: no,
        key: 'mv' + no,
        white: history[i] ? history[i].san : '',
        black: history[i + 1] ? history[i + 1].san : ''
      })
    }

    const patch = {
      statusLabel: status.label,
      statusTone: status.over ? 'over' : status.inCheck ? 'check' : 'even',
      turnClass: game.getTurn(),
      flipped: game.flipped,
      canUndo: game.canUndo(),
      canRedo: game.canRedo(),
      moveRows: rows,
      moveCount: history.length,
      movesAnchor: rows.length ? 'mv' + rows.length : '',
      terminalLabel: status.over ? status.label : '',
      cells: this.buildCells()
    }
    if (!this._fenEditing) patch.fenInput = game.getFen()
    this.setData(patch)
  },

  buildCells() {
    const drag = this._drag
    return boardModel.buildCells({
      board: this.game.getBoard(),
      flipped: this.game.flipped,
      selected: this.game.selected,
      legalTargets: this.game.legalTargets,
      lastMove: this.game.lastMove(),
      checkSquare: this.game.kingSquareUnderCheck(),
      hint: this.hint,
      hiddenSquare: drag && drag.moved ? drag.from : null,
      focus: this._realFocus || []
    })
  },

  demoActive() {
    return !!(this.demo && this.demo.active)
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

  /* ----------------------------------------------------- 走子护栏与交互 */

  /** 当前是否允许玩家落子：轮到玩家、AI 没在思考、没在演示、页面没销毁 */
  _canPlayerMove() {
    if (this._destroyed || this.demoActive()) return false
    return !!this.data.myTurn
  },

  onCellTouchStart(e) {
    if (!this.game) return
    if (!this._canPlayerMove()) return
    this._realFocus = []
    this._touchHandledAt = Date.now()
    const detail = e.detail || {}
    const square = detail.sq != null ? detail.sq
      : (e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.sq : '')
    if (!square) return
    const touch = detail.x != null
      ? { clientX: detail.x, clientY: detail.y }
      : (e.touches && e.touches[0] ? e.touches[0] : null)
    this.pressSquare(square, touch)
  },

  onBoardTouchMove(e) {
    if (!this._canPlayerMove()) { this._drag = null; return }
    const drag = this._drag
    if (!drag) return
    const detail = e.detail || {}
    const touch = detail.x != null
      ? { clientX: detail.x, clientY: detail.y }
      : (e.touches && e.touches[0] ? e.touches[0] : null)
    if (!touch || typeof touch.clientX !== 'number') return
    const dx = touch.clientX - drag.startX
    const dy = touch.clientY - drag.startY
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
      drag.moved = true
      this.syncAll()
    }
    const size = this.data.cellSize
    this.setData({
      ghost: {
        glyph: drag.glyph,
        color: drag.color,
        size: size,
        font: Math.round(size * 0.86),
        left: drag.col * size + dx,
        top: drag.row * size + dy
      }
    })
  },

  onBoardTouchEnd(e) {
    if (!this._canPlayerMove()) { this._drag = null; return }
    const drag = this._drag
    if (!drag) return
    this._drag = null
    if (!drag.moved) {
      this.setData({ ghost: null })
      return
    }
    const detail = e.detail || {}
    const touch = detail.x != null
      ? { clientX: detail.x, clientY: detail.y }
      : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : null)
    let target = null
    if (touch && typeof touch.clientX === 'number') {
      const size = this.data.cellSize || 1
      const start = geometry.squareToCell(drag.from, this.game.flipped)
      const col = start.col + Math.round((touch.clientX - drag.startX) / size)
      const row = start.row + Math.round((touch.clientY - drag.startY) / size)
      if (col >= 0 && col <= 7 && row >= 0 && row <= 7) {
        target = geometry.cellToSquare(col, row, this.game.flipped)
      }
    }
    this.setData({ ghost: null })
    if (target && target !== drag.from && this.game.isLegalTarget(target)) {
      this.applyPlayerMove(drag.from, target)
      return
    }
    this.syncAll()
  },

  onCellTap(e) {
    if (!this._canPlayerMove()) return
    this._realFocus = []
    if (Date.now() - this._touchHandledAt < TAP_SUPPRESS_MS) return
    if (!this.game) return
    const detail = e.detail || {}
    const square = detail.sq != null
      ? detail.sq
      : (e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.sq : '')
    if (!square) return
    this.pressSquare(square, null)
  },

  /**
   * 选择棋子（对弈模式限定只能选自己行棋方的棋子，禁止自由模拟对方）。
   */
  pressSquare(square, touch) {
    if (this.demoActive()) return
    this._realFocus = []
    const game = this.game
    this._drag = null
    if (game.selected && game.isLegalTarget(square)) {
      this.applyPlayerMove(game.selected, square)
      return
    }
    const piece = game.pieceAt(square)
    if (!piece) {
      game.clearSelection()
      this.hint = null
      this.setData({ hintIndex: -1, ghost: null })
      this.syncAll()
      return
    }
    // 对弈模式：只能操作自己行棋方的棋子
    if (piece.color !== this._playAs) {
      game.clearSelection()
      this.hint = null
      this.setData({ hintIndex: -1, ghost: null })
      this.syncAll()
      return
    }
    game.select(square)
    this.hint = null
    if (touch && typeof touch.clientX === 'number' && typeof touch.clientY === 'number') {
      const cell = geometry.squareToCell(square, game.flipped)
      this._drag = {
        from: square,
        col: cell.col,
        row: cell.row,
        glyph: boardModel.GLYPHS[piece.type] || '',
        color: piece.color,
        startX: touch.clientX,
        startY: touch.clientY,
        moved: false
      }
    }
    this.setData({ hintIndex: -1, ghost: null })
    this.syncAll()
  },

  /**
   * 玩家落子（带护栏）：记录关键步判据所需的「走前上下文」，应用走法后排队分析。
   * who 后续在 afterAnalyze 里决定要不要点评 / 让 sparrer 回着。
   */
  applyPlayerMove(from, to) {
    if (!this._canPlayerMove()) return false
    const preStatus = this.game.status()
    this._inCheckBefore = preStatus.inCheck
    this._preMoveWhiteCp = (this._lastResult && this._analysisFen === this.game.getFen())
      ? ai.formatScore(this._lastResult.lines[0], this._lastResult.sideToMove).whiteCp
      : null
    const move = this.game.tryMove(from, to)
    this._drag = null
    if (!move) {
      this.setData({ ghost: null })
      this.syncAll()
      return false
    }
    this._lastPlayerMove = move
    this._gaveCheck = this.game.status().inCheck
    this.hint = null
    this._fenEditing = false
    this._realFocus = []
    this.demo = null
    this._demoParsed = null
    this.setData({ hintIndex: -1, ghost: null, coachText: '', coachError: '', coachDetail: '', coachModel: '', demoLines: [], coachSegments: [], demoActive: false, demoBreadcrumb: '', demoPlaying: false, demoCanBack: false, demoCanForward: false })
    this.syncAll()
    this.scheduleAnalyze('player')
    return true
  },

  onUndo() {
    if (this.demoActive()) return
    if (!this.game.canUndo()) return
    // 撤销到「玩家刚要走」的状态：连撤两步（玩家 + sparrer），避免把玩家卡在 AI 走后的局面
    this.game.undo()
    if (this.game.canUndo() && this.game.getTurn() !== this._playAs) this.game.undo()
    this.hint = null
    this._drag = null
    this._fenEditing = false
    this._lastResult = null
    this._analysisFen = ''
    sessionStore.setAnalysis(null)
    this.setData({ hintIndex: -1, ghost: null, coachText: '', coachError: '', coachDetail: '', coachModel: '' })
    this.syncAll()
    this.recomputeTurn()
    this.scheduleAnalyze('kickoff')
  },

  onRedo() {
    if (this.demoActive()) return
    if (!this.game.canRedo()) return
    this.game.redo()
    this.hint = null
    this._drag = null
    this._fenEditing = false
    this._lastResult = null
    this._analysisFen = ''
    this.setData({ hintIndex: -1, ghost: null, coachText: '', coachError: '', coachDetail: '', coachModel: '' })
    this.syncAll()
    this.recomputeTurn()
    this.scheduleAnalyze('kickoff')
  },

  onReset() {
    if (this.demoActive()) return
    this.newGame(this._playAs)
  },

  /** 重新开局（指定玩家执子方） */
  newGame(playAs) {
    playAs = (playAs === 'w' || playAs === 'b') ? playAs : 'w'
    this._playAs = playAs
    this._sparrerColor = (playAs === 'w' ? 'b' : 'w')
    this.game = new Game(START_FEN)
    this.game.flipped = (playAs === 'b')
    sessionStore.setGame(this.game, 'play')
    sessionStore.setAnalysis(null)
    this.hint = null
    this._drag = null
    this._fenEditing = false
    this._lastResult = null
    this._analysisFen = ''
    this._lastPlayerMove = null
    this.demo = null
    this._demoParsed = null
    this._realFocus = []
    this.setData({
      hintIndex: -1, ghost: null,
      analysisLines: [], analysisMeta: '', analysisError: '',
      engineNotice: '', evalPercent: 50, evalLabel: '0.00',
      coachText: '', coachError: '', coachDetail: '', coachModel: '',
      flipped: this.game.flipped, playAs: playAs, sparrerColor: this._sparrerColor,
      myTurn: true, engineThinking: false, thinkingLabel: ''
    })
    this.syncAll()
    this.recomputeTurn()
    this.scheduleAnalyze('kickoff')
  },

  onFlip() {
    if (this.demoActive()) {
      this.demo.flip()
      this.setData(this.demo.view())
      return
    }
    // 玩家手动翻转只影响观感，不改变 playAs 视角（重新开局才会换边）
    this.game.flip()
    this._drag = null
    this.hint = null
    this.setData({ flipped: this.game.flipped, hintIndex: -1, ghost: null })
    this.syncAll()
  },

  /* --------------------------------------------------------------- Tabs */

  onSwitchTab(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.tab : ''
    if (!key || key === this.data.activeTabKey) return
    this.setData({ activeTabKey: key, tabAnchor: 'tab-top-' + key })
  },

  onToggleFen() {
    this.setData({ fenCollapsed: !this.data.fenCollapsed })
  },

  /* --------------------------------------------------------------- FEN */

  onFenInput(e) {
    this._fenEditing = true
    this.setData({ fenInput: e.detail.value })
  },

  onUseStartFen() {
    this._fenEditing = true
    this.setData({ fenInput: START_FEN })
  },

  onLoadFen() {
    if (this.demoActive()) return
    const raw = (this.data.fenInput || '').trim()
    if (!raw) { device.toast('请先粘贴 FEN'); return }
    const fen = extractFen(raw) || raw
    this._applyLoadedFen(fen)
  },

  /**
   * 从外部 FEN 开局：以该局面作为新的对局起点（玩家执子方不变）。
   * 若开局后轮到 sparrer，则自动让 AI 先走。
   */
  _applyLoadedFen(fen) {
    try {
      this.game.load(fen)
    } catch (err) {
      device.toast((err && err.message) || 'FEN 不合法')
      return
    }
    this._fenEditing = false
    this.hint = null
    this._drag = null
    this._lastResult = null
    this._analysisFen = ''
    this._lastPlayerMove = null
    this.demo = null
    this._demoParsed = null
    sessionStore.setAnalysis(null)
    this.setData({
      hintIndex: -1, ghost: null,
      analysisLines: [], analysisMeta: '', analysisError: '', engineNotice: '',
      evalPercent: 50, evalLabel: '0.00',
      coachText: '', coachError: '', coachDetail: '', coachModel: '',
      myTurn: true, engineThinking: false, thinkingLabel: ''
    })
    this.syncAll()
    this.recomputeTurn()
    this.scheduleAnalyze('kickoff')
  },

  onPasteClipboard() {
    const host = typeof wx !== 'undefined' ? wx : null
    if (!host || typeof host.getClipboardData !== 'function') {
      device.toast('当前环境不支持读取剪贴板')
      return
    }
    host.getClipboardData({
      success: res => {
        if (this._destroyed) return
        const raw = (res && typeof res.data === 'string') ? res.data : ''
        const fen = extractFen(raw)
        if (!fen) { device.toast('剪贴板里没有合法的 FEN'); return }
        this._lastPromptedFen = fen
        this._applyLoadedFen(fen)
      },
      fail: () => device.toast('读取剪贴板失败')
    })
  },

  /* -------------------------------------------------------------- 分析 + sparrer */

  onDepthChange(e) {
    const index = Number(e.detail.value)
    if (!(index >= 0) || index >= DEPTH_OPTIONS.length) return
    this.setData({ depthIndex: index })
    this.runAnalyze()
  },

  onAnalyze() {
    this.runAnalyze()
  },

  scheduleAnalyze(who) {
    this._pendingWho = who
    if (this._analyzeTimer) clearTimeout(this._analyzeTimer)
    this._analyzeTimer = setTimeout(() => {
      this._analyzeTimer = null
      this.runAnalyze().then(() => {
        if (!this._destroyed) this.afterAnalyze(this._pendingWho)
      })
    }, AUTO_ANALYZE_DELAY)
  },

  runAnalyze() {
    if (this._destroyed) return Promise.resolve()
    const fen = this.game.getFen()
    if (this._analyzePromise) {
      if (this._runningFen !== fen) this._analyzeAgain = true
      return this._analyzePromise
    }
    this._runningFen = fen
    this._analyzePromise = this.doAnalyze(fen).then(
      () => this.settleAnalyze(),
      () => this.settleAnalyze()
    )
    return this._analyzePromise
  },

  settleAnalyze() {
    this._analyzePromise = null
    this._runningFen = null
    if (this._analyzeAgain && !this._destroyed) {
      this._analyzeAgain = false
      this.runAnalyze()
    }
  },

  async ensureAnalysis(fen) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this._destroyed) return false
      if (this._lastResult && this._analysisFen === fen) return true
      await this.runAnalyze()
    }
    return !!this._lastResult && this._analysisFen === fen
  },

  async doAnalyze(fen) {
    if (this._destroyed) return
    const sideToMove = this.game.getTurn()
    const depth = DEPTH_OPTIONS[this.data.depthIndex] || 3

    this.setData({ analyzing: true, analysisError: '' })

    try {
      const result = await ai.analyzePosition({
        fen: fen, depth: depth, multiPV: 3,
        onProgress: info => { if (this._destroyed || !info || !info.reached) return; this.setData({ analysisMeta: '已完成深度 ' + info.reached + '…' }) }
      })
      if (this._destroyed) return
      if (this.game.getFen() !== fen) return

      const lines = this.buildLineViews(result.lines, sideToMove)
      const best = result.lines.length ? ai.formatScore(result.lines[0], sideToMove) : null
      const src = ai.describeEngineSource(result)

      this._lastResult = result
      this._analysisFen = fen
      sessionStore.setAnalysis({
        fen: fen, result: result, lines: lines,
        engineSource: src.source, engineLabel: src.label, engineNotice: src.notice,
        evalPercent: best ? ai.evalPercent(best.whiteCp) : 50,
        evalLabel: best ? best.text : '—',
        analysisMeta: this.buildAnalysisMeta(result, src)
      })

      this.setData({
        analysisLines: lines,
        analysisMeta: this.buildAnalysisMeta(result, src),
        engineSource: src.source, engineLabel: src.label, engineNotice: src.notice,
        terminalLabel: result.terminal ? result.terminal.label : this.data.terminalLabel,
        evalPercent: best ? ai.evalPercent(best.whiteCp) : 50,
        evalLabel: best ? best.text : '—',
        hintIndex: -1
      })
      this.noticeEngineDegrade(src, result)
      this.hint = null
      this.syncAll()
    } catch (err) {
      if (this._destroyed) return
      this.setData({ analysisError: (err && err.message) || '分析失败，请重试', analysisLines: [] })
    } finally {
      if (!this._destroyed) this.setData({ analyzing: false })
    }
  },

  buildAnalysisMeta(result, src) {
    if (result.terminal) return '局面已结束'
    const tag = (src && src.label) || '引擎'
    return tag + ' · 深度 ' + result.depth + ' · ' + result.nodes + ' 节点 · ' + result.elapsedMs + 'ms'
  },

  noticeEngineDegrade(src, result) {
    if (!(src && src.degraded)) {
      if (this._engineDegraded) { this._engineDegraded = false; device.toast('云端引擎已恢复'); }
      return
    }
    if (this._engineDegraded) return
    this._engineDegraded = true
    device.toast('云端引擎不可用，已改用本地引擎')
    debugLog.push('warn', '[引擎] 已降级到本地 · ' + ((result && result.degradedFrom) || ''))
  },

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

  /**
   * 分析完成后的「后续动作」分发：
   *   - 终局 → 收尾，提示谁胜；
   *   - 轮到 sparrer → 让引擎回着（engineMove）；
   *   - 轮到玩家 → 若是玩家刚走的这步，按开关决定是否自动点评。
   */
  afterAnalyze(who) {
    if (this._destroyed) return
    const status = this.game.status()
    if (status.over) {
      this._engineThinking = false
      this.syncAll()
      this.recomputeTurn()
      return
    }
    if (this.game.getTurn() === this._sparrerColor) {
      this.engineMove()
      return
    }
    // 轮到玩家
    this._engineThinking = false
    if (who === 'player') this.maybeAutoCoach()
    this.recomputeTurn()
  },

  /**
   * sparrer（引擎）回着：取当前局面最佳走法应用，再分析玩家将要面对的局面。
   * 任何失败都降级为「把行棋权交回玩家」，绝不卡死对局。
   */
  engineMove() {
    if (this._destroyed) return
    this._engineThinking = true
    this.recomputeTurn()
    const fen = this.game.getFen()
    this.ensureAnalysis(fen).then(ok => {
      if (this._destroyed) return
      if (!ok || this.game.status().over || this.game.getTurn() !== this._sparrerColor) {
        this._engineThinking = false
        this.recomputeTurn()
        return
      }
      const best = this._lastResult && this._lastResult.lines[0]
      const depth = this.data.sparrerDepth || 3
      // 用 sparrer 专属深度再确认一次最佳着法（与玩家分析深度解耦）
      ai.analyzePosition({ fen: fen, depth: depth, multiPV: 1 }).then(res => {
        if (this._destroyed) return
        const mv = (res && res.lines && res.lines[0]) || best
        if (!mv) { this._engineThinking = false; this.recomputeTurn(); return }
        const move = this.game.tryMove(mv.from, mv.to)
        if (!move) { this._engineThinking = false; this.recomputeTurn(); return }
        this._drag = null
        this.demo = null
        this._demoParsed = null
        this._realFocus = []
        this.setData({ hintIndex: -1, ghost: null, coachText: '', coachError: '', coachDetail: '', coachModel: '', demoLines: [], coachSegments: [], demoActive: false, demoBreadcrumb: '', demoPlaying: false, demoCanBack: false, demoCanForward: false })
        this.syncAll()
        this.scheduleAnalyze('engine')
      }).catch(() => {
        this._engineThinking = false
        this.recomputeTurn()
      })
    })
  },

  recomputeTurn() {
    const over = this.game.status().over
    const myTurn = !over && !this._engineThinking && this.game.getTurn() === this._playAs
    let label = ''
    if (over) label = this.game.status().label
    else if (this._engineThinking) label = 'AI 思考中…'
    else if (myTurn) label = '轮到你落子'
    else label = ''
    this.setData({ myTurn: myTurn, engineThinking: this._engineThinking, thinkingLabel: label })
  },

  /**
   * 玩家刚走完一步 → 是否自动出点评（受 autoCoach + playCoachScope 门控）。
   * 关键步判定（纯引擎、确定性）：|Δcp|≥阈值 或 吃子 / 将军 / 送将（走前被将）。
   * LLM 点评始终需要云端，无网络时静默跳过（避免每步刷错误）。
   */
  maybeAutoCoach() {
    const s = settings.getSettings()
    if (s.autoCoach === 'off') return
    if (!this.data.cloudReady) return
    if (s.autoCoach === 'remoteOnly' && !this.data.cloudReady) return
    if (this.data.commenting) return

    const move = this._lastPlayerMove
    let isKey = true
    if (s.playCoachScope === 'keySteps') {
      const post = (this._lastResult && this._analysisFen === this.game.getFen() && this._lastResult.lines[0])
        ? ai.formatScore(this._lastResult.lines[0], this._lastResult.sideToMove).whiteCp
        : null
      const pre = this._preMoveWhiteCp
      let delta = null
      if (post != null && pre != null) delta = post - pre
      isKey = (delta != null && Math.abs(delta) >= (s.playKeyCp || 80)) ||
        !!(move && move.captured) || this._gaveCheck || this._inCheckBefore
    }
    if (!isKey) return
    this.runAutoCoach()
  },

  runAutoCoach() {
    const fen = this.game.getFen()
    if (!this._lastResult || this._analysisFen !== fen) {
      this.ensureAnalysis(fen).then(ready => {
        if (this._destroyed || !ready) return
        this._runCoachCommentWith(fen, this._lastResult, {
          hint: 'AI 正在点评这步棋…',
          auto: true,
          onResult: parsed => this._onCoachResult(parsed)
        })
      })
      return
    }
    this._runCoachCommentWith(fen, this._lastResult, {
      hint: 'AI 正在点评这步棋…',
      auto: true,
      onResult: parsed => this._onCoachResult(parsed)
    })
  },

  _onCoachResult(parsed) {
    this._demoParsed = parsed.lines.length ? { lines: parsed.lines, rootFen: this.game.getFen() } : null
    this.demo = this._demoParsed
      ? new coachDemo.DemoSession(parsed.lines, this.game.getFen(), { flipped: this.game.flipped })
      : null
    this.setData({
      coachText: parsed.prose,
      commenting: false,
      demoLines: this.demo ? this.demo.lineViews() : [],
      coachSegments: coachDemo.tokenizeText(parsed.prose, { lines: parsed.lines, colorMode: 'branch' }) || [],
      demoActive: false, demoBreadcrumb: '', demoPlaying: false, demoCanBack: false, demoCanForward: false
    })
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
      host.setClipboardData({ data: content, success: () => device.toast('日志已复制'), fail: () => device.toast('复制失败，可长按选中文字') })
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
      success: () => { this.setData({ debugEnabled: next }); device.toast(next ? '调试面板已开启，重新进入小程序后生效' : '调试面板已关闭') },
      fail: () => device.toast('调试面板切换失败')
    })
  },

  /* ---------------------------------------------------------- 手动 AI 点评 */

  /** 手动点评按钮（与自动点评共用执行通道，但受频控） */
  onCoach() {
    if (this.data.commenting) { this.cancelCoach(); return }
    const now = Date.now()
    if (now - this._lastCoachAt < COACH_MIN_INTERVAL) { device.toast('请求过于频繁，请稍候'); return }
    const fen = this.game.getFen()
    if (!this._lastResult || this._analysisFen !== fen) {
      this.ensureAnalysis(fen).then(ready => {
        if (this._destroyed) return
        if (!ready) { device.toast('请先完成局面分析'); return }
        this._lastCoachAt = Date.now()
        this._runCoachCommentWith(fen, this._lastResult, { hint: '正在请求云端模型，通常需要 3~15 秒…', onResult: parsed => this._onCoachResult(parsed) })
      })
      return
    }
    this._lastCoachAt = Date.now()
    this._runCoachCommentWith(fen, this._lastResult, { hint: '正在请求云端模型，通常需要 3~15 秒…', onResult: parsed => this._onCoachResult(parsed) })
  },

  updateCoachHint() {
    if (!this.data.commenting) return
    const seconds = Math.max(1, Math.round((Date.now() - this._coachStartedAt) / 1000))
    const model = this.data.coachModel ? '（' + this.data.coachModel + '）' : ''
    this.setData({ commentingHint: '正在等待云端模型' + model + '返回，已等待 ' + seconds + ' 秒…' })
  },

  cancelCoach() {
    this._coachCancelled = true
    if (this._coachTimer) { clearInterval(this._coachTimer); this._coachTimer = null }
    if (this._coachController) {
      try { this._coachController.abort() } catch (e) { /* 重复中断忽略 */ }
      this._coachController = null
    }
    this._lastCoachAt = 0
    this.setData({ commenting: false, coachText: '', coachError: '', coachDetail: '', coachModel: '' })
    device.toast('已取消本次点评')
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
      commenting: true, coachText: '', coachError: '', coachDetail: '', coachModel: '',
      demoLines: [], coachSegments: [], demoActive: false, demoBreadcrumb: '', demoPlaying: false,
      demoCanBack: false, demoCanForward: false, commentingHint: opts.hint || '正在请求云端模型，通常需要 3~15 秒…'
    })
    if (this._coachTimer) clearInterval(this._coachTimer)
    this._coachTimer = setInterval(() => this.updateCoachHint(), 1000)
    coachRunner.runCoachComment({
      fen: fen,
      sideToMove: result ? result.sideToMove : this.game.getTurn(),
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
        if (opts.onResult) opts.onResult(r.parsed)
        if (this._coachTimer) { clearInterval(this._coachTimer); this._coachTimer = null }
        this._coachController = null
      },
      onError: info => {
        if (this._destroyed || this._coachCancelled) return
        debugLog.push('error', '[点评] 失败 · ' + (info.kind || 'unknown') + ' · ' + (info.detail || info.message))
        this.setData({ coachError: info.message, coachDetail: info.detail || '', commenting: false })
        if (this._coachTimer) { clearInterval(this._coachTimer); this._coachTimer = null }
        this._coachController = null
      },
      onWarn: w => { debugLog.push('warn', '[点评] ' + w) },
      signal: controller ? controller.signal : undefined
    })
  },

  /* ---------------------------------------------------------- 走法演示（与 analyze 共用交互） */

  _ensureDemo() {
    if (this.demo) return true
    if (!this._demoParsed || !this._demoParsed.lines.length) return false
    this.demo = new coachDemo.DemoSession(this._demoParsed.lines, this._demoParsed.rootFen, { flipped: this.game.flipped })
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
    this.setData({ demoActive: false, demoBreadcrumb: '', demoPlaying: false, demoCanBack: false, demoCanForward: false })
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
      if (line && this._ensureDemo()) { useDemo = true; this.demo.enterAt(line, Number(d.ply) || 0); squares = this.demo.findPieces(d.piece) }
      else squares = this.game.pieceSquares(d.piece.charAt(0), d.piece.charAt(1))
    } else if (line && this._ensureDemo()) { useDemo = true; this.demo.enterAt(line, Number(d.ply) || 0); squares = [d.sq] }
    else squares = [d.sq]
    if (useDemo && this.demoActive()) { this.demo.setFocus(squares); this.setData(this.demo.view()); return }
    this._realFocus = squares.filter(sq => !!sq)
    this.syncAll()
  },

  /* ---------------------------------------------------------- 点评复制 */

  _proseText() { return (this.data.coachText || '').trim() },

  _lineText(lineId) {
    if (!this._demoParsed || !this._demoParsed.lines.length) return ''
    const line = this._demoParsed.lines.find(l => l.id === lineId)
    if (!line) return ''
    return coachDemo.linePlainText(line, this.game.getTurn())
  },

  _branchText() {
    if (!this._demoParsed || !this._demoParsed.lines.length) return ''
    return coachDemo.branchPlainText(this._demoParsed.lines, this.game.getTurn())
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
    if (prose && branches) opts.push({ label: '复制全部（正文+分支）', text: coachDemo.coachPlainText(prose, this._demoParsed.lines, this.game.getTurn()) })
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

  /* ---------------------------------------------------------- 对弈控制条 */

  onNewGame(e) {
    const side = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.side : ''
    this.newGame(side === 'b' ? 'b' : 'w')
  },

  onStrengthChange(e) {
    const level = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.level : ''
    const found = SPARRER_LEVELS.find(l => l.key === level)
    if (!found) return
    settings.setSetting('sparrerLevel', found.key)
    this._sparrerDepth = found.depth
    this.setData({ strengthKey: found.key, sparrerDepth: found.depth })
  }
})
