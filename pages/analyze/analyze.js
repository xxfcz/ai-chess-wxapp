/**
 * pages/analyze/analyze.js
 * 分析页：FEN 初始化 → WXML 棋盘 → 拖拽/点选走子 → 终局提示 → 三条路线 AI 分析 → 云端点评。
 *
 * 棋盘不用 Canvas：网页版预览不实现 wx.createSelectorQuery，拿不到 2d 节点。
 * 改用 8×8 的 view 网格后，交互只依赖格子的 data-sq 与手指位移，任何环境都能跑。
 */
const { Game, START_FEN } = require('../../utils/game')
const geometry = require('../../utils/geometry')
const boardModel = require('../../utils/board-model')
const device = require('../../utils/device')
const ai = require('../../utils/ai-client')
const coachDemo = require('../../utils/coach-demo')
const debugLog = require('../../utils/debug-log')

const DEPTH_OPTIONS = [2, 3, 4]
const DEFAULT_DEPTH_INDEX = 1
const AUTO_ANALYZE_DELAY = 280
const COACH_MIN_INTERVAL = 3000
const FEN_HINT = '支持完整 6 段 FEN，也支持只写棋子布局（自动补全）'
/** 手指移动超过该距离才算拖拽，否则视为点选 */
const DRAG_THRESHOLD = 6
/** 触摸事件可用时，系统还会合成一次 tap，靠时间窗忽略它 */
const TAP_SUPPRESS_MS = 700

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
    hintIndex: -1,
    evalPercent: 50,
    evalLabel: '0.00',
    terminalLabel: '',
    coachText: '',
    coachError: '',
    /** 点评失败的排查线索（错误码 + 底层原因） */
    coachDetail: '',
    /** 生成中的等待说明；环境不支持流式返回时只能等完整结果 */
    commentingHint: '正在请求云端模型，通常需要 3~15 秒…',
    /** 本次点评实际使用的云端模型名，显示在点评下方 */
    coachModel: '',
    demoActive: false,
    demoLines: [],
    coachSegments: [],
    demoBreadcrumb: '',
    demoPlaying: false,
    demoCanBack: false,
    demoCanForward: false,
    commenting: false,
    /** 当前环境是否有网络请求能力（网页版预览可能没有 wx.request） */
    cloudReady: true,
    cloudHint: '',
    /** 运行日志（预览面板没有控制台，真机也看不到 console，就把日志放到界面上） */
    debugOpen: false,
    debugRows: [],
    debugCount: 0,
    debugEnabled: false,
    /**
     * 布局：棋盘固定在屏幕上方（唯一不滚动的元素），
     * 状态/控制按钮与 Tab 内容同属一个滚动区，Tab 栏钉在底部。
     * Tab：引擎分析（含深度选择与「PV走法」）/ AI教练点评 / 走子记录 / 运行日志 / 局面。
     */
    tabs: [
      { key: 'fen', label: '局面' },
      { key: 'engine', label: '引擎分析' },
      { key: 'coach', label: 'AI教练点评' },
      { key: 'moves', label: '走子记录' },
      { key: 'log', label: '运行日志' }
    ],
    activeTabKey: 'engine',
    /** 滚动区回到顶部用的锚点 id，切换 Tab 时换成新值即可滚回顶部 */
    tabAnchor: 'tab-top-engine'
  },

  /* ------------------------------------------------------------ 生命周期 */

  onLoad() {
    const metrics = boardModel.boardMetrics(
      device.getWindowWidth(),
      Math.floor(device.getWindowHeight() * 0.5)
    )

    this.game = new Game(START_FEN)
    this.hint = null
    this._drag = null
    this._touchHandledAt = 0
    this._destroyed = false
    this._analyzePromise = null
    this._runningFen = null
    this._analyzeAgain = false
    this._lastResult = null
    this._analysisFen = ''
    this._fenEditing = false
    this._lastCoachAt = 0
    this._coachTimer = null
    this._coachController = null
    this._coachCancelled = false
    this._coachStartedAt = 0
    this.demo = null
    this._demoParsed = null   // 最近一次点评解析出的演示线（退出演示后可凭它重建会话）
    this._realFocus = []      // 真实棋盘上的「位置焦点」高亮（点评里点到的格子/棋子）

    // 日志缓冲：正常由 app.js 装好，这里兜底一次（重复调用是安全的）
    debugLog.install()
    debugLog.push('info', '[页面] 分析页已加载 · ' + (device.canRequest() ? '可发起网络请求' : '无网络请求能力'))
    this._debugUnsubscribe = debugLog.subscribe(() => {
      if (this._destroyed || !this.data.debugOpen) return
      this.refreshDebug()
    })

    // 预览环境可能只实现了 wx 的一个子集；云端点评依赖 wx.request，先探测再告知
    const cloudReady = device.canRequest()

    this.setData({
      boardSize: metrics.boardSize,
      cellSize: metrics.cellSize,
      pieceFont: Math.round(metrics.cellSize * 0.86),
      labelFont: Math.max(8, Math.round(metrics.cellSize * 0.2)),
      cloudReady: cloudReady,
      cloudHint: cloudReady ? '' : ai.ENV_NO_NETWORK_TEXT
    })
    this.syncAll()
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
      try {
        this._coachController.abort()
      } catch (e) {
        // 忽略重复中断
      }
    }
  },

  /* -------------------------------------------------------------- 同步 */

  /** 从棋局状态整体刷新页面数据与棋盘 */
  syncAll() {
    const game = this.game
    const status = game.status()
    const history = game.history()
    const rows = []
    for (let i = 0; i < history.length; i += 2) {
      const no = i / 2 + 1
      rows.push({
        no: no,
        // wx:key 用字符串字段，避免个别渲染实现对数字键处理不一致
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

    if (!this._fenEditing) {
      patch.fenInput = game.getFen()
    }
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

  /** 是否处于「走法演示」状态（演示跑在临时副本上，不触碰真实棋局） */
  demoActive() {
    return !!(this.demo && this.demo.active)
  },

  /**
   * 组装三条路线的展示数据。
   *
   * 下标与选中态都写进数据里，而不是留给模板的循环变量：
   * 预览环境在渲染 wx:for 元素「自身」的属性时拿不到 index，
   * 表达式中一旦引用 index，整行都会渲染不出来（只剩同级的说明文字）。
   */
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

  /** 只切换路线高亮，避免整块分析数据重算 */
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

  /* -------------------------------------------------------------- 走子 */

  applyMove(from, to) {
    const move = this.game.tryMove(from, to)
    this._drag = null
    if (!move) {
      // 非法落点：棋子弹回原位，保留选中便于直接点选合法落点
      this.setData({ ghost: null })
      this.syncAll()
      return false
    }
    this.hint = null
    this._fenEditing = false
    this._realFocus = []
    // 真实棋局一动，点评演示就过期了：清掉演示状态与解析缓存
    this.demo = null
    this._demoParsed = null
    this.setData({ hintIndex: -1, ghost: null, coachText: '', coachError: '', coachDetail: '', coachModel: '', demoLines: [], coachSegments: [], demoActive: false, demoBreadcrumb: '', demoPlaying: false, demoCanBack: false, demoCanForward: false })
    this.syncAll()
    this.scheduleAnalyze()
    return true
  },

  /**
   * 处理一次「按在某个格子上」的操作（触摸与点选共用）。
   * @param {string} square
   * @param {object|null} touch 触摸事件里的触点，带 clientX/clientY；点选传 null
   */
  pressSquare(square, touch) {
    if (this.demoActive()) return
    this._realFocus = []
    const game = this.game
    this._drag = null

    // 已选中棋子时，按到合法落点直接走子
    if (game.selected && game.isLegalTarget(square)) {
      this.applyMove(game.selected, square)
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

  onCellTouchStart(e) {
    if (!this.game) return
    if (this.demoActive()) return
    this._realFocus = []
    this._touchHandledAt = Date.now()
    const square = e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.sq : ''
    if (!square) return
    const touch = e.touches && e.touches[0] ? e.touches[0] : null
    this.pressSquare(square, touch)
  },

  onBoardTouchMove(e) {
    if (this.demoActive()) return
    this._realFocus = []
    const drag = this._drag
    if (!drag) return
    const touch = e.touches && e.touches[0] ? e.touches[0] : null
    if (!touch || typeof touch.clientX !== 'number') return

    const dx = touch.clientX - drag.startX
    const dy = touch.clientY - drag.startY

    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
      drag.moved = true
      // 棋子改由浮层显示，格内不再重复画
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
    if (this.demoActive()) return
    this._realFocus = []
    this._touchHandledAt = Date.now()
    const drag = this._drag
    if (!drag) return
    this._drag = null

    // 没移动过：按在格子上属于点选，选择状态已在 touchstart 处理
    if (!drag.moved) {
      this.setData({ ghost: null })
      return
    }

    const touch = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : null
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
      this.applyMove(drag.from, target)
      return
    }
    // 非法落点：弹回，并保留选中状态
    this.syncAll()
  },

  /** 点选走子的兜底：个别环境不派发触摸事件，只能靠 tap */
  onCellTap(e) {
    if (this.demoActive()) return
    this._realFocus = []
    if (Date.now() - this._touchHandledAt < TAP_SUPPRESS_MS) return
    if (!this.game) return
    const square = e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.sq : ''
    if (!square) return
    this.pressSquare(square, null)
  },

  onUndo() {
    if (this.demoActive()) return
    this._realFocus = []
    if (!this.game.canUndo()) return
    this.game.undo()
    this.hint = null
    this._drag = null
    this._fenEditing = false
    this.setData({ hintIndex: -1, ghost: null, coachText: '', coachError: '', coachDetail: '', coachModel: '' })
    this.syncAll()
    this.scheduleAnalyze()
  },

  onRedo() {
    if (this.demoActive()) return
    this._realFocus = []
    if (!this.game.canRedo()) return
    this.game.redo()
    this.hint = null
    this._drag = null
    this._fenEditing = false
    this.setData({ hintIndex: -1, ghost: null, coachText: '', coachError: '', coachDetail: '', coachModel: '' })
    this.syncAll()
    this.scheduleAnalyze()
  },

  onReset() {
    if (this.demoActive()) return
    this._realFocus = []
    this.game.reset()
    this.hint = null
    this._drag = null
    this._fenEditing = false
    this._lastResult = null
    this._analysisFen = ''
    this.setData({
      hintIndex: -1,
      ghost: null,
      analysisLines: [],
      analysisMeta: '',
      analysisError: '',
      evalPercent: 50,
      evalLabel: '0.00',
      coachText: '',
      coachError: '',
      coachDetail: '',
      coachModel: ''
    })
    this.syncAll()
    this.scheduleAnalyze()
  },

  onFlip() {
    if (this.demoActive()) {
      this.demo.flip()
      this.setData(this.demo.view())
      return
    }
    this.game.flip()
    this._drag = null
    this.hint = null
    this.setData({
      flipped: this.game.flipped,
      hintIndex: -1,
      ghost: null
    })
    this.syncAll()
  },

  /* --------------------------------------------------------------- Tabs */

  /** 切换底部 Tab；同时把滚动区回到顶部，免得停在上一屏的位置 */
  onSwitchTab(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.tab : ''
    if (!key || key === this.data.activeTabKey) return
    this.setData({ activeTabKey: key, tabAnchor: 'tab-top-' + key })
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
    this._realFocus = []
    const raw = (this.data.fenInput || '').trim()
    if (!raw) {
      device.toast('请先粘贴 FEN')
      return
    }
    try {
      this.game.load(raw)
    } catch (err) {
      device.toast((err && err.message) || 'FEN 不合法')
      return
    }
    this._fenEditing = false
    this.hint = null
    this._drag = null
    this._lastResult = null
    this._analysisFen = ''
    this.setData({
      hintIndex: -1,
      ghost: null,
      analysisLines: [],
      analysisMeta: '',
      analysisError: '',
      evalPercent: 50,
      evalLabel: '0.00',
      coachText: '',
      coachError: '',
      coachDetail: '',
      coachModel: ''
    })
    this.syncAll()
    this.scheduleAnalyze()
  },

  /* -------------------------------------------------------------- 分析 */

  onDepthChange(e) {
    const index = Number(e.detail.value)
    if (!(index >= 0) || index >= DEPTH_OPTIONS.length) return
    this.setData({ depthIndex: index })
    this.runAnalyze()
  },

  onAnalyze() {
    this.runAnalyze()
  },

  scheduleAnalyze() {
    if (this._analyzeTimer) clearTimeout(this._analyzeTimer)
    this._analyzeTimer = setTimeout(() => {
      this._analyzeTimer = null
      this.runAnalyze()
    }, AUTO_ANALYZE_DELAY)
  },

  /**
   * 触发分析。已有分析在进行时复用同一个 Promise，
   * 并在局面已变化时排队重跑，保证调用方总能 await 到「当前局面」的结果。
   */
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

  /** 确保「当前局面」已有分析结果；用于生成点评前的兜底 */
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
        fen: fen,
        depth: depth,
        multiPV: 3,
        onProgress: info => {
          if (this._destroyed || !info || !info.reached) return
          this.setData({ analysisMeta: '已完成深度 ' + info.reached + '…' })
        }
      })
      if (this._destroyed) return

      // 分析期间局面已变化，丢弃过期结果
      if (this.game.getFen() !== fen) return

      const lines = this.buildLineViews(result.lines, sideToMove)
      const best = result.lines.length ? ai.formatScore(result.lines[0], sideToMove) : null

      this._lastResult = result
      this._analysisFen = fen

      this.setData({
        analysisLines: lines,
        analysisMeta: result.terminal
          ? '局面已结束'
          : '深度 ' + result.depth + ' · ' + result.nodes + ' 节点 · ' + result.elapsedMs + 'ms',
        terminalLabel: result.terminal ? result.terminal.label : this.data.terminalLabel,
        evalPercent: best ? ai.evalPercent(best.whiteCp) : 50,
        evalLabel: best ? best.text : '—',
        hintIndex: -1
      })
      this.hint = null
      this.syncAll()
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

  /** 点击路线 → 在棋盘上预览该走法 */
  onPreviewLine(e) {
    const data = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : null
    const index = Number(data && data.index)
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

  /* ------------------------------------------------------------ 运行日志 */

  /** 刷新「运行日志」卡片（最新的排在最上面） */
  refreshDebug() {
    const rows = debugLog.list()
    this.setData({
      debugRows: rows.slice().reverse(),
      debugCount: rows.length
    })
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

  /** 复制全部日志：预览面板与真机都能用，用户可以直接把细节贴出来 */
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

  /**
   * 真机上看 console 的官方办法：打开调试面板（vConsole）。
   * 需要重新进入小程序才生效；环境不支持时如实说明。
   */
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
  },

  /* ---------------------------------------------------------- 云端点评 */

  /** 生成中的提示：带上当前模型与已等待秒数，避免用户以为程序卡死 */
  updateCoachHint() {
    if (!this.data.commenting) return
    const seconds = Math.max(1, Math.round((Date.now() - this._coachStartedAt) / 1000))
    const model = this.data.coachModel ? '（' + this.data.coachModel + '）' : ''
    this.setData({
      commentingHint: '正在等待云端模型' + model + '返回，已等待 ' + seconds + ' 秒…'
    })
  },

  /** 放弃本次点评：模型太慢时用户不该被一直卡住 */
  cancelCoach() {
    this._coachCancelled = true
    if (this._coachTimer) {
      clearInterval(this._coachTimer)
      this._coachTimer = null
    }
    if (this._coachController) {
      try {
        this._coachController.abort()
      } catch (e) {
        // 重复中断忽略
      }
      this._coachController = null
    }
    // 取消后立刻可以重来，不受频控限制
    this._lastCoachAt = 0
    this.setData({ commenting: false, coachText: '', coachError: '', coachDetail: '', coachModel: '' })
    debugLog.push('info', '[点评] 已取消（等待 ' + Math.round((Date.now() - this._coachStartedAt) / 1000) + ' 秒）')
    device.toast('已取消本次点评')
  },

  async onCoach() {
    // 生成中再点一次 = 取消
    if (this.data.commenting) {
      this.cancelCoach()
      return
    }

    const now = Date.now()
    if (now - this._lastCoachAt < COACH_MIN_INTERVAL) {
      device.toast('请求过于频繁，请稍候')
      return
    }

    const fen = this.game.getFen()
    // 局面变化或还没有结果时，先跑一次引擎分析，让点评有据可依
    if (!this._lastResult || this._analysisFen !== fen) {
      const ready = await this.ensureAnalysis(fen)
      if (this._destroyed) return
      if (!ready) {
        device.toast('请先完成局面分析')
        return
      }
    }
    this._lastCoachAt = Date.now()

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
      commentingHint: '正在请求云端模型，通常需要 3~15 秒…'
    })

    if (this._coachTimer) clearInterval(this._coachTimer)
    this._coachTimer = setInterval(() => this.updateCoachHint(), 1000)
    debugLog.push('info', '[点评] 请求开始 · ' + (this.data.coachModel || '待选模型') + ' · 局面 ' + fen.slice(0, 40))

    try {
      const text = await ai.requestCoachComment({
        fen: fen,
        sideToMove: this._lastResult.sideToMove,
        lines: this._lastResult.lines,
        onDelta: value => {
          if (this._destroyed || this._coachCancelled) return
          // 流式期间就把 ===DEMO=== 结构化块剔掉，避免原始 JSON 闪现在正文里
          this.setData({ coachText: coachDemo.stripDemoBlock(value) })
        },
        onModel: info => {
          if (this._destroyed) return
          const label = (info && info.label) || ''
          if (label !== this.data.coachModel) this.setData({ coachModel: label })
          this.updateCoachHint()
        },
        signal: controller ? controller.signal : undefined
      })
      if (this._destroyed || this._coachCancelled) return
      const parsed = coachDemo.parseDemo(text, this.game.getFen())
      // 解析结果留存：退出演示后再次点击记号/分支，可凭它重建会话
      this._demoParsed = parsed.lines.length ? { lines: parsed.lines, rootFen: this.game.getFen() } : null
      this.demo = this._demoParsed
        ? new coachDemo.DemoSession(parsed.lines, this.game.getFen(), { flipped: this.game.flipped })
        : null
      this.setData({
        coachText: parsed.prose,
        commenting: false,
        demoLines: this.demo ? this.demo.lineViews() : [],
        // 正文一律走富文本片段（走法/格子/棋子都可点），不再有纯文本兜底
        coachSegments: coachDemo.tokenizeText(parsed.prose, { lines: parsed.lines, colorMode: 'branch' }) || [],
        demoActive: false,
        demoBreadcrumb: '',
        demoPlaying: false,
        demoCanBack: false,
        demoCanForward: false
      })
      debugLog.push('info', '[点评] 完成 · ' + Math.round((Date.now() - this._coachStartedAt) / 1000) +
        ' 秒 · ' + text.length + ' 字 · ' + (this.data.coachModel || '未知模型'))
    } catch (err) {
      // 主动取消不算失败，不能把中断报成错误
      if (this._destroyed || this._coachCancelled) return
      const info = ai.llmErrorInfo(err)
      debugLog.push('error', '[点评] 失败 · ' + (info.kind || 'unknown') + ' · ' + (info.detail || info.message))
      // 原始错误留到控制台，便于在开发者工具里追查
      try {
        console.error('[AI 教练点评]', info.kind, info.detail, err)
      } catch (e) {
        // 控制台不可用时忽略
      }
      this.setData({
        coachError: info.message,
        coachDetail: info.detail || '',
        commenting: false
      })
    } finally {
      if (this._coachTimer) {
        clearInterval(this._coachTimer)
        this._coachTimer = null
      }
      this._coachController = null
    }
  },

  /* ---------------------------------------------------------- 走法演示 */

  /** 演示会话不在时（退出后又被点击）按最近一次点评的解析结果重建 */
  _ensureDemo() {
    if (this.demo) return true
    if (!this._demoParsed || !this._demoParsed.lines.length) return false
    this.demo = new coachDemo.DemoSession(this._demoParsed.lines, this._demoParsed.rootFen, { flipped: this.game.flipped })
    return true
  },

  /** 点击分支标签：进入该线，从被点评局面起逐步重放 */
  onEnterDemo(e) {
    const lineId = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.line : ''
    if (!lineId || !this._ensureDemo()) return
    this.demo.enter(lineId)
    this.setData(this.demo.view())
  },

  /** 演示内上一步 / 下一步 */
  onDemoStep(e) {
    if (!this.demo) return
    const dir = Number((e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.dir : 0))
    this.demo.step(dir > 0 ? 1 : -1)
    this.setData(this.demo.view())
  },

  /** 演示播放 / 暂停（自动逐步落子） */
  onDemoPlay() {
    if (!this.demo) return
    if (this.demo.playing) {
      this.demo.pause()
      this.setData({ demoPlaying: false })
      return
    }
    this.demo.play(() => this.setData(this.demo.view()))
    this.setData(this.demo.view())
  },

  /** 退出演示：销毁临时副本，棋盘回到真实棋局；分支列表与富文本点评保留 */
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

  /**
   * 点击点评/分支描述里的记号：
   *   - 走法（SAN）→ 进入对应分支并演示到那一手；
   *   - 格子/棋子 → 先把语境分支上盘（若记号是某手的落点则演示到那一手，
   *     否则停在起点），再以独立紫色高亮目标格（棋子可多格）。
   * 没有语境线（无演示线或正文前文没有分支）时，直接在真实棋盘上高亮。
   */
  onCoachTokenTap(e) {
    const d = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {}
    if (d.sq || d.piece) return this._focusToken(d)
    if (!d.line || !this._ensureDemo()) return
    this.demo.enterAt(d.line, Number(d.ply) || 0)
    this.setData(this.demo.view())
  },

  /** 格子 / 棋子记号的位置高亮 */
  _focusToken(d) {
    const line = d.line || ''
    let squares = []
    let useDemo = false
    if (d.piece) {
      if (line && this._ensureDemo()) {
        useDemo = true
        this.demo.enterAt(line, Number(d.ply) || 0)
        squares = this.demo.findPieces(d.piece)
      } else {
        squares = this.game.pieceSquares(d.piece.charAt(0), d.piece.charAt(1))
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

  /* ---------------------------------------------------------- 点评复制 */

  /** 点评正文纯文本（已剔除结构化块） */
  _proseText() {
    const t = this.data.coachText || ''
    return t.trim()
  },

  /** 取某条分支的纯文本（用于「复制这条分支」） */
  _lineText(lineId) {
    if (!this._demoParsed || !this._demoParsed.lines.length) return ''
    const line = this._demoParsed.lines.find(l => l.id === lineId)
    if (!line) return ''
    return coachDemo.linePlainText(line, this.game.getTurn())
  },

  /** 全部分支纯文本 */
  _branchText() {
    if (!this._demoParsed || !this._demoParsed.lines.length) return ''
    return coachDemo.branchPlainText(this._demoParsed.lines, this.game.getTurn())
  },

  /**
   * 统一入口：长按点评 / 点「复制」按钮 / 长按某条分支 共用。
   * 不强制弹菜单（预览环境可能无 actionSheet），只有「一项可复制」时直接复制，
   * 多项时用微信操作菜单让用户挑要复制哪一段。
   * @param {string} [lineId] 指定分支时只围绕该分支构建菜单
   */
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
    if (!opts.length) {
      device.toast('还没有可复制的点评')
      return
    }
    if (opts.length === 1) {
      device.copyText(opts[0].text)
      return
    }
    const picked = device.actionSheet(opts.map(o => o.label), idx => {
      if (typeof idx === 'number' && idx >= 0 && opts[idx]) device.copyText(opts[idx].text)
    })
    if (!picked) device.copyText(opts[0].text)
  },

  /** 「复制」按钮 / 长按整段点评：弹出复制菜单 */
  onCopyCoach() {
    this._openCopyMenu('')
  },

  /** 长按整段点评正文（与按钮同效，方便预览环境无长按时也能复制） */
  onCoachLongPress() {
    this._openCopyMenu('')
  },

  /** 长按某条分支走法：围绕该分支弹出复制菜单 */
  onLineLongPress(e) {
    const d = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {}
    this._openCopyMenu(d.line || '')
  }
})
