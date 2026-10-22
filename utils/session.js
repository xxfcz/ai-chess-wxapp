/**
 * session.js  —— L0 平台层：棋局会话（走子树）
 *
 * 这是平台化重构的核心抽象：把「线性棋局状态」升级为「带分支的走子树」。
 *
 * 设计约定（沿用现有数据格式与规则层，见 working-memory / AGENTS.md）：
 *   - 内部一律 FEN + UCI 表示；PGN 只在 import / export 边界各转换一次
 *     （load_pgn / pgn），绝不把 PGN 当作内部状态——同一局面经不同顺序到达时
 *     PGN 不同但 FEN 相同，用 PGN 存状态会让阶段三错题去重失效。
 *   - 规则判定复用 chess.js（纯函数、可单测）；终局口径沿用 game.js#status。
 *   - 每个节点缓存自己的引擎分析（analysis）与 AI 点评（coach），实现「节点级缓存」：
 *     走子树每个节点可缓存分析结果，重访不重算。
 *
 * 节点结构：
 *   { id, parentId, fen, uci, san, from, to, color, children: [], analysis, coach }
 *   - children[0] 是主线延续；children[1..] 是分支（variations）。
 *
 * 本模块不依赖 wx / DOM / Canvas，可单独纯 Node 单测。
 */
const { Chess } = require('./chess.js')
const pgnTree = require('./pgn-tree')

const START_FEN = 'r1b2rk1/ppp1p1pp/3b4/2qP4/8/2P2N1P/PP1B1P2/R1Q1RK2 w - - 0 1'
const DEFAULT_PROMOTION = 'q'

/** FEN 后五段的默认值；用户常常只贴第一段棋子布局 */
const FEN_FIELD_DEFAULTS = ['w', '-', '-', '0', '1']

/** 合法的棋子布局段：8 个由 / 分隔的行，只含棋子字母与空格数 */
const PLACEMENT_RE = /^([1-8pnbrqkPNBRQK]+\/){7}[1-8pnbrqkPNBRQK]+$/

/**
 * 规整 FEN：不足 6 段且首段确实是棋子布局时，按惯例补全尾部字段。
 * 与 game.js#normalizeFenFields 同义（规则层单一事实来源在此处复用同一套口径）。
 */
function normalizeFenFields(fen) {
  const parts = fen.trim().split(/\s+/)
  if (parts.length >= 6 || !PLACEMENT_RE.test(parts[0])) return parts.join(' ')
  while (parts.length < 6) parts.push(FEN_FIELD_DEFAULTS[parts.length - 1])
  return parts.join(' ')
}

let _nodeSeq = 0

function makeNode(parentId, fen, uci, san, from, to, color) {
  _nodeSeq += 1
  return {
    id: 'n' + _nodeSeq,
    parentId: parentId,
    fen: fen,
    uci: uci,
    san: san,
    from: from,
    to: to,
    color: color,
    children: [],
    analysis: null,
    coach: null
  }
}

class Session {
  constructor(fen) {
    this._nodes = new Map()
    this._byFen = new Map()
    this._root = makeNode(null, normalizeFenFields(fen || START_FEN), null, null, null, null, null)
    this._nodes.set(this._root.id, this._root)
    this._indexFen(this._root)
    this._currentId = this._root.id
  }

  /* --------------------------------------------------------- 基础查询 */

  root() {
    return this._root
  }

  current() {
    return this._nodes.get(this._currentId) || this._root
  }

  get(id) {
    return this._nodes.get(id) || null
  }

  /** 每个节点自带字符串 id（供 UI wx:key 与持久化） */
  currentId() {
    return this._currentId
  }

  /** 从根到当前节点（含）的路径，用于 PGN / 走子记录 */
  pathToCurrent() {
    return this._pathTo(this._currentId)
  }

  /** 从根到任意节点的路径（含） */
  pathTo(id) {
    return this._pathTo(id)
  }

  _pathTo(id) {
    const out = []
    let node = this._nodes.get(id)
    while (node) {
      out.unshift(node)
      node = node.parentId ? this._nodes.get(node.parentId) : null
    }
    return out
  }

  /** 沿 children[0] 走到主线叶节点 */
  mainLine() {
    const out = []
    let node = this._root
    while (node) {
      out.push(node)
      node = node.children.length ? node.children[0] : null
    }
    return out
  }

  /** 某节点的分支（variations）：children[1..] */
  variationsOf(id) {
    const node = this._nodes.get(id)
    if (!node) return []
    return node.children.slice(1)
  }

  isMainLine(node) {
    if (!node || !node.parentId) return true
    const parent = this._nodes.get(node.parentId)
    return !!parent && parent.children[0] === node
  }

  /** 已建立的节点总数（含根；打谱页用来显示「共 N 步（含变例）」） */
  nodeCount() {
    return this._nodes.size
  }

  /* --------------------------------------------------------- 规则层（复用 chess.js） */

  _chessAtFen(fen) {
    const normalized = normalizeFenFields(fen || '')
    const chess = new Chess()
    const check = chess.validate_fen(normalized)
    if (!check || check.valid !== true) return null
    chess.load(normalized)
    return chess
  }

  _buildProbe(fen, color) {
    const parts = (fen || '').split(' ')
    if (parts.length < 4) return null
    parts[1] = color
    parts[3] = '-'
    const f = parts.join(' ')
    const chess = new Chess()
    const check = chess.validate_fen(f)
    if (!check || check.valid !== true) return null
    chess.load(f)
    return chess
  }

  turn(fen) {
    const chess = this._chessAtFen(fen == null ? this.current().fen : fen)
    return chess ? chess.turn() : 'w'
  }

  board(fen) {
    const chess = this._chessAtFen(fen == null ? this.current().fen : fen)
    return chess ? chess.board() : null
  }

  pieceAt(fen, sq) {
    const chess = this._chessAtFen(fen == null ? this.current().fen : fen)
    return chess ? chess.get(sq) : null
  }

  /** 该局面下的全部合法走法（verbose） */
  legalMoves(fen) {
    const chess = this._chessAtFen(fen == null ? this.current().fen : fen)
    return chess ? chess.moves({ verbose: true }) : []
  }

  /** 指定棋子的全部合法落点（verbose） */
  movesFrom(fen, sq) {
    return this.legalMoves(fen).filter(m => m.from === sq)
  }

  /** 指定棋子的合法落点格子名（支持自由模拟：拖动对方棋子自动翻转行棋方） */
  legalTargetsFrom(fen, sq) {
    const chess = this._chessAtFen(fen == null ? this.current().fen : fen)
    if (!chess) return []
    const piece = chess.get(sq)
    if (!piece) return []
    if (piece.color === chess.turn()) {
      return this.movesFrom(fen, sq).map(m => m.to)
    }
    const probe = this._buildProbe(fen == null ? this.current().fen : fen, piece.color)
    if (!probe) return []
    return probe.moves({ verbose: true })
      .filter(m => m.from === sq)
      .map(m => m.to)
  }

  /** 终局 / 行棋方状态（口径与 game.js#status 完全一致） */
  status(fen) {
    const chess = this._chessAtFen(fen == null ? this.current().fen : fen)
    if (!chess) {
      return { over: false, inCheck: false, winner: null, reason: 'normal', label: '—' }
    }
    const turn = chess.turn()
    const turnLabel = turn === 'w' ? '白方' : '黑方'
    if (chess.in_checkmate()) {
      const winner = turn === 'w' ? 'b' : 'w'
      return {
        over: true, inCheck: true, winner,
        reason: 'checkmate',
        label: `将杀 · ${winner === 'w' ? '白方' : '黑方'}胜`
      }
    }
    if (chess.in_stalemate()) {
      return { over: true, inCheck: false, winner: null, reason: 'stalemate', label: '逼和 · 无子可动' }
    }
    if (chess.insufficient_material()) {
      return { over: true, inCheck: false, winner: null, reason: 'insufficient', label: '和棋 · 子力不足' }
    }
    if (chess.in_threefold_repetition()) {
      return { over: true, inCheck: false, winner: null, reason: 'threefold', label: '和棋 · 三次重复局面' }
    }
    if (chess.in_draw()) {
      return { over: true, inCheck: false, winner: null, reason: 'fifty', label: '和棋 · 50 回合规则' }
    }
    if (chess.in_check()) {
      return { over: false, inCheck: true, winner: null, reason: 'check', label: `将军 · ${turnLabel}应将` }
    }
    return { over: false, inCheck: false, winner: null, reason: 'normal', label: `${turnLabel}行棋` }
  }

  /**
   * 正在被将军的一方的王所在棋格；未被将军返回 null。
   * 口径与 game.js#kingSquareUnderCheck 一致（各模式共用同一套高亮语义）。
   */
  kingSquareUnderCheck(fen) {
    const chess = this._chessAtFen(fen == null ? this.current().fen : fen)
    if (!chess || !chess.in_check()) return null
    const color = chess.turn()
    const board = chess.board()
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const p = board[row][col]
        // chess.js 的 board() 第 0 行是第 8 横线
        if (p && p.type === 'k' && p.color === color) {
          return String.fromCharCode(97 + col) + (8 - row)
        }
      }
    }
    return null
  }

  /* --------------------------------------------------------- 走子 / 导航 */

  /**
   * 在当前节点下走一步，返回新建/命中的节点。
   * 若当前节点的某个子节点已是同一 UCI（主线或分支），则视为「回到该局面」直接导航过去。
   * 否则新建子节点：没有子节点时成为主线（children[0]），已有子节点时成为分支（children[1..]）。
   * @param {string} from
   * @param {string} to
   * @param {string} [promotion]
   * @returns {object|null} 节点或 null（非法走法）
   */
  applyMove(from, to, promotion) {
    if (!from || !to || from === to) return null
    let fen = this.current().fen
    let chess = this._chessAtFen(fen)
    if (!chess) return null

    const piece = chess.get(from)
    if (!piece) return null

    // 自由模拟双方：拖动对方棋子时，在副本上翻转行棋方后再判断落点（不改动真实局面）
    if (piece.color !== chess.turn()) {
      const probe = this._buildProbe(fen, piece.color)
      if (!probe) return null
      chess = probe
    }

    const move = chess.move({ from: from, to: to, promotion: promotion || DEFAULT_PROMOTION })
    if (!move) return null

    // 命中已有子节点（同一 UCI）：直接导航，避免重复建节点
    const cur = this.current()
    const hit = cur.children.find(c => c.uci === move.from + move.to)
    if (hit) {
      this._currentId = hit.id
      return hit
    }

    const node = makeNode(cur.id, chess.fen(), move.from + move.to, move.san, move.from, move.to, move.color)
    cur.children.push(node)
    this._nodes.set(node.id, node)
    this._indexFen(node)
    this._currentId = node.id
    return node
  }

  /** 在指定父节点下新增一条分支（即使已有同 UCI 子节点也会新建，用于手动分叉） */
  addVariation(parentId, from, to, promotion) {
    const parent = this._nodes.get(parentId)
    if (!parent) return null
    const chess = this._chessAtFen(parent.fen)
    if (!chess) return null
    const piece = chess.get(from)
    if (!piece) return null
    const probe = piece.color === chess.turn()
      ? chess
      : (this._buildProbe(parent.fen, piece.color) || chess)
    const move = probe.move({ from: from, to: to, promotion: promotion || DEFAULT_PROMOTION })
    if (!move) return null
    const node = makeNode(parent.id, probe.fen(), move.from + move.to, move.san, move.from, move.to, move.color)
    parent.children.push(node)
    this._nodes.set(node.id, node)
    this._indexFen(node)
    this._currentId = node.id
    return node
  }

  /** 从某节点分叉（forkFrom 的别名语义：在该节点下开一条新分支并跳过去） */
  forkFrom(nodeId, from, to, promotion) {
    return this.addVariation(nodeId, from, to, promotion)
  }

  /** 删除一条分支（不允许删除主线 children[0]） */
  deleteVariation(nodeId) {
    const node = this._nodes.get(nodeId)
    if (!node || !node.parentId) return false
    const parent = this._nodes.get(node.parentId)
    if (!parent) return false
    const idx = parent.children.indexOf(node)
    if (idx <= 0) return false // 主线不可删
    parent.children.splice(idx, 1)
    this._detach(node)
    if (this._currentId === nodeId || this._isAncestor(node, this._currentId)) {
      this._currentId = parent.id
    }
    return true
  }

  /** 把一条分支提升为父节点的主线（与 children[0] 交换） */
  promoteVariation(nodeId) {
    const node = this._nodes.get(nodeId)
    if (!node || !node.parentId) return false
    const parent = this._nodes.get(node.parentId)
    if (!parent) return false
    const idx = parent.children.indexOf(node)
    if (idx <= 0) return false
    const main = parent.children[0]
    parent.children[0] = node
    parent.children[idx] = main
    return true
  }

  _isAncestor(ancestor, id) {
    let node = this._nodes.get(id)
    while (node) {
      if (node.id === ancestor.id) return true
      node = node.parentId ? this._nodes.get(node.parentId) : null
    }
    return false
  }

  _detach(node) {
    this._nodes.delete(node.id)
    if (this._byFen.get(node.fen) === node.id) this._byFen.delete(node.fen)
    node.children.slice().forEach(c => this._detach(c))
  }

  /** 导航到指定节点 */
  goto(id) {
    if (this._nodes.has(id)) {
      this._currentId = id
      return this._nodes.get(id)
    }
    return null
  }

  gotoRoot() {
    this._currentId = this._root.id
    return this._root
  }

  parent() {
    const cur = this.current()
    if (!cur.parentId) return null
    const p = this._nodes.get(cur.parentId)
    if (p) this._currentId = p.id
    return p
  }

  /** 前进一步：进入当前节点的主线子节点 */
  stepForward() {
    const cur = this.current()
    if (!cur.children.length) return null
    this._currentId = cur.children[0].id
    return cur.children[0]
  }

  /** 后退一步：回到父节点 */
  stepBack() {
    return this.parent()
  }

  /* --------------------------------------------------------- 节点级缓存 */

  _indexFen(node) {
    if (!this._byFen.has(node.fen)) this._byFen.set(node.fen, node.id)
  }

  findNodeByFen(fen) {
    const id = this._byFen.get(normalizeFenFields(fen || ''))
    return id ? this._nodes.get(id) || null : null
  }

  cacheAnalysis(id, analysis) {
    const node = this._nodes.get(id)
    if (node) node.analysis = analysis
    return !!node
  }

  getAnalysis(id) {
    const node = this._nodes.get(id)
    return node ? node.analysis : null
  }

  /** 按 FEN 写入分析缓存（重访同一局面不重算） */
  cacheAnalysisForFen(fen, analysis) {
    const node = this.findNodeByFen(fen)
    if (node) node.analysis = analysis
    return !!node
  }

  getAnalysisForFen(fen) {
    const node = this.findNodeByFen(fen)
    return node ? node.analysis : null
  }

  cacheCoach(id, coach) {
    const node = this._nodes.get(id)
    if (node) node.coach = coach
    return !!node
  }

  getCoach(id) {
    const node = this._nodes.get(id)
    return node ? node.coach : null
  }

  /* --------------------------------------------------------- PGN 边界 */

  /**
   * 从 PGN 载入（只在 import 边界转换一次）。
   * 当前 MVP：只重建主线（chess.js 的 history 不含变例）；变例后续阶段补齐。
   * 失败（无法解析）返回 false，会话保持原状。
   * @returns {boolean}
   */
  loadPgn(pgn) {
    if (typeof pgn !== 'string' || !pgn.trim()) return false
    const fenMatch = pgn.match(/\[\s*FEN\s+"([^"]+)"\s*\]/i)
    const rootFen = (fenMatch && fenMatch[1]) || START_FEN
    const chess = new Chess()
    let moves = []
    try {
      const ok = chess.load_pgn(pgn)
      if (ok) {
        moves = chess.history({ verbose: true }) || []
      }
    } catch (e) {
      moves = []
    }
    // 兜底：load_pgn 不支持或失败，按 SAN 序列手动重放（去除 PGN 头与回合号）
    if (!moves.length) {
      moves = this._parseSansFallback(pgn)
      if (!moves.length) return false
    }
    this._reset(rootFen)
    let okAll = true
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i]
      const node = this.applyMove(m.from, m.to, m.promotion)
      if (!node) { okAll = false; break }
    }
    return okAll
  }

  /**
   * 从 PGN 载入**完整走法树**（主线 + 圆括号变例）。
   *
   * 与 loadPgn 的区别：loadPgn 走 chess.js 的 history，只能重建主线（0.10.3 会删掉 RAV）；
   * 打谱模式需要变例树，所以改由 pgn-tree 在边界解析成 move 树再灌进来。
   * 两者都只在 import 边界做一次 PGN→FEN+UCI 转换，内部状态永远是 FEN+UCI。
   *
   * @param {string} pgn
   * @returns {object} 解析结果（ok/headers/plyCount/variationCount/error…）；失败时会话保持原状
   */
  loadPgnTree(pgn) {
    const parsed = pgnTree.parsePgn(pgn)
    if (!parsed.ok) return parsed
    const built = pgnTree.buildInto(this, parsed)
    if (!built) {
      // 走到这里说明「合法走法」在树上落地失败（理论不发生），退回根局面避免半个残树
      this._reset(parsed.rootFen)
      parsed.ok = false
      parsed.error = parsed.error || '走法树构建失败'
      return parsed
    }
    this._currentId = this._root.id
    return parsed
  }

  _parseSansFallback(pgn) {
    // 去掉被 [ ] 包裹的 PGN 头，去掉回合号 "1." / "12..." 等，按空白切分
    const fenMatch = pgn.match(/\[\s*FEN\s+"([^"]+)"\s*\]/i)
    const startFen = fenMatch ? fenMatch[1] : START_FEN
    const bodies = pgn.replace(/\[[^\]]*\]/g, ' ')
      .replace(/\d+\s*\.{1,3}/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    const chess = new Chess()
    const check = chess.validate_fen(startFen)
    if (!check || check.valid !== true) return []
    chess.load(startFen)
    const out = []
    for (let i = 0; i < bodies.length; i++) {
      try {
        const mv = chess.move(bodies[i])
        if (!mv) break
        out.push(mv)
      } catch (e) {
        break
      }
    }
    return out
  }

  /**
   * 导出 PGN（只在 export 边界转换一次）。
   * @param {string} [id] 终点节点 id；默认当前节点
   */
  toPgn(id) {
    const path = this._pathTo(id || this._currentId)
    const sans = path.slice(1).map(n => n.san).filter(Boolean)
    if (!sans.length) return ''
    const chess = new Chess()
    const check = chess.validate_fen(this._root.fen)
    if (!check || check.valid !== true) return ''
    chess.load(this._root.fen)
    try {
      sans.forEach(s => chess.move(s))
      return chess.pgn()
    } catch (e) {
      return ''
    }
  }

  /* --------------------------------------------------------- 重置 / 序列化 */

  _reset(fen) {
    this._nodes = new Map()
    this._byFen = new Map()
    this._root = makeNode(null, normalizeFenFields(fen || START_FEN), null, null, null, null, null)
    this._nodes.set(this._root.id, this._root)
    this._indexFen(this._root)
    this._currentId = this._root.id
  }

  /** 重置为新的根局面（历史清空） */
  reset(fen) {
    this._reset(fen || START_FEN)
    return this._root
  }

  /** 序列化整棵会话树（用于阶段三跨设备存档 / 持久化） */
  serialize() {
    return {
      root: this._root.fen,
      currentId: this._currentId,
      nodes: Array.from(this._nodes.values()).map(n => ({
        id: n.id, parentId: n.parentId, fen: n.fen, uci: n.uci,
        san: n.san, from: n.from, to: n.to, color: n.color,
        analysis: n.analysis ? this._stripVolatile(n.analysis) : null,
        coach: n.coach || null
      }))
    }
  }

  /** 分析结果里带函数/循环引用之类不可序列化字段时剔除（如 onProgress 不会进 result） */
  _stripVolatile(analysis) {
    return analysis
  }

  /** 从序列化数据恢复（保留 children 顺序即保留主线/分支结构） */
  restore(data) {
    if (!data || !Array.isArray(data.nodes)) return false
    this._nodes = new Map()
    this._byFen = new Map()
    for (let i = 0; i < data.nodes.length; i++) {
      const raw = data.nodes[i]
      const node = {
        id: raw.id, parentId: raw.parentId, fen: raw.fen, uci: raw.uci,
        san: raw.san, from: raw.from, to: raw.to, color: raw.color,
        children: [], analysis: raw.analysis || null, coach: raw.coach || null
      }
      this._nodes.set(node.id, node)
      this._indexFen(node)
    }
    // 重建 children 指针（按 nodes 顺序保证 children[0] 为最先出现的子节点）
    const childrenOf = {}
    for (let i = 0; i < data.nodes.length; i++) {
      const raw = data.nodes[i]
      if (raw.parentId && this._nodes.has(raw.parentId)) {
        (childrenOf[raw.parentId] = childrenOf[raw.parentId] || []).push(this._nodes.get(raw.id))
      }
    }
    Object.keys(childrenOf).forEach(pid => {
      const parent = this._nodes.get(pid)
      if (parent) parent.children = childrenOf[pid]
    })
    this._root = this._nodes.get(data.nodes[0] && data.nodes[0].id) || this._root
    this._currentId = this._nodes.has(data.currentId) ? data.currentId : this._root.id
    return true
  }
}

module.exports = { Session, normalizeFenFields, START_FEN, DEFAULT_PROMOTION }
