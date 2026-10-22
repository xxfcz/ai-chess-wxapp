/**
 * session-store.js · 跨页面 / 分包的全局会话仓库（单例）。
 *
 * 解决的问题（方案 §1 / 看板 L2-T3）：
 *   Landing 与各模式分包之间靠 navigateTo 跳转，每次进入分包 page 都会重建页面实例。
 *   若不保留，退出 analyze 再进入就会丢掉「当前局面」与「已分析的三线结果」，
 *   既浪费一次引擎计算，又打断用户心流。
 *
 * 设计约束（来自 memory / AGENTS.md）：
 *   - 远程引擎无状态、本地引擎是纯函数，重入只重渲 UI、不重算已分析局面。
 *   - 因此这里只缓存「Game 实例 + 最近一次分析结果」，重入时直接恢复显示。
 *   - 不依赖 wx / DOM，可纯 Node 单测（回归脚本直接 require）。
 *
 * 注意：本仓库「内部一律 FEN + UCI」，Game 实例的持久化就是内存里持有一个引用，
 * 不做序列化（小程序单进程，navigateTo 不杀进程）。
 */

const store = {
  /** 当前棋局实例（Game）；跨分包复用同一引用，避免重算 */
  _game: null,
  /**
   * 当前走法树会话（Session）：打谱模式用它，因为 PGN 复盘需要主线 + 变例树。
   * Game 是线性历史，Session 是树——两者都放这里，由模式各自取用（互不干扰）。
   */
  _session: null,
  /** Session 的随附元信息（PGN 头、总步数等，重进打谱页时恢复标题用） */
  _sessionMeta: null,
  /** 当前会话来自哪个模式（'analyze' / 'play' / 'replay' …）；避免跨模式误复用 */
  _mode: '',
  /** 最近一次分析结果：{ fen, result, lines, engineSource, engineLabel, engineNotice, evalPercent, evalLabel, analysisMeta } */
  _analysis: null,
  /**
   * 待送达的目标页参数（url query 的解析结果）。
   * 起因：预览运行时对带 query 的 navigateTo 报「未找到页面」，导航层会退到
   * 「不带 query 的 url」重试；参数就从 query 挪到这里，由目标页 onLoad 取回，
   * 页面行为不变（见 utils/navigation.js#mergeLaunchOptions）。
   */
  _pendingParams: null,

  setGame(game, mode) {
    this._game = game
    if (mode != null) this._mode = mode
  },

  getGame() {
    return this._game
  },

  setSession(session, mode, meta) {
    this._session = session || null
    this._sessionMeta = meta || null
    if (mode != null) this._mode = mode
  },

  getSession() {
    return this._session
  },

  getSessionMeta() {
    return this._sessionMeta
  },

  getMode() {
    return this._mode
  },

  setAnalysis(analysis) {
    this._analysis = analysis || null
  },

  getAnalysis() {
    return this._analysis
  },

  /** 导航层写入目标页参数（每次跳转前重置，避免上一次的残留串到这一次） */
  setPendingParams(params) {
    this._pendingParams = params || null
  },

  /** 目标页取走参数：取后即清，保证「一次性送达」语义 */
  takePendingParams() {
    const p = this._pendingParams
    this._pendingParams = null
    return p
  },

  /** 测试与冷启动用：清空全部会话状态 */
  reset() {
    this._game = null
    this._session = null
    this._sessionMeta = null
    this._mode = ''
    this._analysis = null
    this._pendingParams = null
  }
}

module.exports = { sessionStore: store }
