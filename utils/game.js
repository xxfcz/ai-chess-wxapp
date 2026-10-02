/**
 * game.js
 * 棋局状态管理（纯逻辑，无 DOM / Canvas 依赖，可单独单测）。
 *
 * 职责：
 *   - FEN 载入与校验
 *   - 合法落点查询、走子（含兵升变默认升后）
 *   - 自由模拟双方：拖动对方棋子自动翻转行棋方
 *   - 前进 / 后退 / 重置（基于局面快照，天然支持悔棋与重做）
 *   - 终局判断（将杀 / 逼和 / 子力不足 / 三次重复 / 50 回合）
 *   - SAN 走子记录
 */
const { Chess } = require('./chess.js')
const { cellToSquare } = require('./geometry')

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const DEFAULT_PROMOTION = 'q'

class Game {
  constructor(fen) {
    this.selected = null
    this.legalTargets = []
    this.flipped = false
    this._chess = new Chess()
    this._states = []
    this._cursor = 0
    this.load(fen || START_FEN)
  }

  /* ---------------------------------------------------------------- 载入 */

  /**
   * 载入 FEN 并重置历史。
   * @throws {Error} code = 'BAD_FEN' 时表示 FEN 非法
   */
  load(fen) {
    if (typeof fen !== 'string' || !fen.trim()) {
      const err = new Error('FEN 不能为空')
      err.code = 'BAD_FEN'
      throw err
    }
    const normalized = fen.trim()
    const next = new Chess()
    const check = next.validate_fen(normalized)
    if (!check || check.valid !== true) {
      const err = new Error((check && check.error) || 'FEN 不合法')
      err.code = 'BAD_FEN'
      throw err
    }
    // validate_fen 只做校验，不会载入，必须显式 load
    next.load(normalized)
    this._chess = next
    this._states = [{ fen: next.fen(), san: null, from: null, to: null, color: null }]
    this._cursor = 0
    this.selected = null
    this.legalTargets = []
    return this
  }

  reset() {
    return this.load(START_FEN)
  }

  flip() {
    this.flipped = !this.flipped
    this.selected = null
    this.legalTargets = []
    return this.flipped
  }

  /* ------------------------------------------------------------ 只读查询 */

  getFen() {
    return this._chess.fen()
  }

  getTurn() {
    return this._chess.turn()
  }

  getBoard() {
    return this._chess.board()
  }

  pieceAt(square) {
    return this._chess.get(square)
  }

  /** 当前行棋方的全部合法走法（verbose） */
  getMoves() {
    return this._chess.moves({ verbose: true })
  }

  /** 指定棋子的全部合法走法（verbose） */
  movesFrom(square) {
    const piece = this._chess.get(square)
    if (!piece) return []
    return this._chess.moves({ verbose: true }).filter(m => m.from === square)
  }

  isLegalTarget(square) {
    return this.legalTargets.indexOf(square) !== -1
  }

  /**
   * 指定棋子的合法落点。
   * 棋子不属于当前行棋方时（自由模拟），在副本上翻转行棋方后再计算，
   * 不改动真实棋局状态。
   */
  legalTargetsFrom(square) {
    const piece = this._chess.get(square)
    if (!piece) return []
    if (piece.color === this._chess.turn()) {
      return this.movesFrom(square).map(m => m.to)
    }
    const probe = this.buildProbe(piece.color)
    if (!probe) return []
    return probe
      .moves({ verbose: true })
      .filter(m => m.from === square)
      .map(m => m.to)
  }

  /** 生成一个把行棋方切换为 color 的棋局副本；FEN 第三段同步清空 */
  buildProbe(color) {
    const parts = this._chess.fen().split(' ')
    if (parts.length < 4) return null
    parts[1] = color
    parts[3] = '-'
    const fen = parts.join(' ')
    const probe = new Chess()
    const check = probe.validate_fen(fen)
    if (!check || check.valid !== true) return null
    probe.load(fen)
    return probe
  }

  /** 上一次走子（用于高亮） */
  lastMove() {
    if (this._cursor <= 0) return null
    const s = this._states[this._cursor]
    return s && s.from ? { from: s.from, to: s.to } : null
  }

  /** SAN 走子记录（仅到当前游标为止） */
  history() {
    const out = []
    for (let i = 1; i <= this._cursor; i++) {
      out.push(this._states[i])
    }
    return out
  }

  cursor() {
    return this._cursor
  }

  canUndo() {
    return this._cursor > 0
  }

  canRedo() {
    return this._cursor < this._states.length - 1
  }

  /** 正在被将军的一方的王所在棋格；未被将军返回 null */
  kingSquareUnderCheck() {
    if (!this._chess.in_check()) return null
    return this.findKing(this._chess.turn())
  }

  findKing(color) {
    const board = this._chess.board()
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const p = board[row][col]
        if (p && p.type === 'k' && p.color === color) {
          return cellToSquare(col, row, false)
        }
      }
    }
    return null
  }

  /* -------------------------------------------------------------- 选择 */

  /** 选中棋格；返回是否选中成功（空格或非法棋格返回 false 并清空选择） */
  select(square) {
    const piece = this._chess.get(square)
    if (!piece) {
      this.clearSelection()
      return false
    }
    this.selected = square
    this.legalTargets = this.legalTargetsFrom(square)
    return true
  }

  clearSelection() {
    this.selected = null
    this.legalTargets = []
  }

  /* -------------------------------------------------------------- 走子 */

  /**
   * 执行走子。
   * @returns {object|null} chess.js 的 verbose move；非法走法返回 null
   */
  tryMove(from, to) {
    if (from === to) return null
    const piece = this._chess.get(from)
    if (!piece) return null

    // 自由模拟双方：拖动对方棋子时自动翻转行棋方。
    // 注意 _switchTurn 会替换 this._chess，之后必须重新取用实例。
    if (piece.color !== this._chess.turn()) {
      if (!this._switchTurn(piece.color)) return null
    }

    const chess = this._chess
    const move = chess.move({ from, to, promotion: DEFAULT_PROMOTION })
    if (!move) return null

    // 记录快照：截断当前游标之后的重做分支
    this._states = this._states.slice(0, this._cursor + 1)
    this._states.push({
      fen: chess.fen(),
      san: move.san,
      from: move.from,
      to: move.to,
      color: move.color,
      captured: move.captured || null
    })
    this._cursor = this._states.length - 1
    this.clearSelection()
    return move
  }

  undo() {
    if (!this.canUndo()) return false
    this._cursor -= 1
    this._restore(this._cursor)
    return true
  }

  redo() {
    if (!this.canRedo()) return false
    this._cursor += 1
    this._restore(this._cursor)
    return true
  }

  _restore(index) {
    const chess = new Chess()
    chess.load(this._states[index].fen)
    this._chess = chess
    this.clearSelection()
  }

  /** 把行棋方切换为指定颜色（FEN 第三段同步清空，避免吃过路兵状态不一致） */
  _switchTurn(color) {
    if (this._chess.turn() === color) return true
    const next = this.buildProbe(color)
    if (!next) return false
    this._chess = next
    return true
  }

  /* -------------------------------------------------------------- 终局 */

  /**
   * @returns {{ over:boolean, inCheck:boolean, winner:('w'|'b'|null), reason:string, label:string }}
   */
  status() {
    const chess = this._chess
    const turn = chess.turn()
    const turnLabel = turn === 'w' ? '白方' : '黑方'

    if (chess.in_checkmate()) {
      const winner = turn === 'w' ? 'b' : 'w'
      return {
        over: true,
        inCheck: true,
        winner,
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
}

module.exports = { Game, START_FEN, DEFAULT_PROMOTION }
