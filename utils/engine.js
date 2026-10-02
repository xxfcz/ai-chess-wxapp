/**
 * engine.js
 * 小程序内运行的国际象棋分析引擎（Alpha-Beta + 静态评估 + 静态搜索 + MultiPV）。
 *
 * 对外契约与需求文档中的云函数 analyze 完全一致：
 *   analyze({ fen, depth, multiPV })
 *     → { lines: [{ uci, san, scoreCp, scoreMate, pv, pvSan }], terminal?, ... }
 *
 * 为什么是端上引擎而不是云端 Stockfish：
 *   - 微信原生小程序不能用 web-view（个人主体不支持，且需要备案域名）；
 *   - 端上也无法直接运行 Stockfish 原生二进制；
 *   - 因此用纯 JS 搜索实现同等输出的三条最佳路线，完全离线可用。
 *   字段与 UCI/Stockfish 输出保持同构，后续若接入真实引擎，
 *   只需替换本文件实现，上层 ai-client / 页面无需改动。
 *
 * 分数约定：scoreCp / scoreMate 以「当前行棋方」为参照（UCI 惯例），
 * 大于 0 表示行棋方占优；界面展示时再换算成白方视角。
 *
 * 性能：搜索树内部只使用 raw_moves / raw_board（不生成 SAN），
 * 避免 chess.js 的 make_pretty 在每一层造成的 O(n^2) 开销。
 */

const { Chess } = require('./chess.js')

const ENGINE_NAME = 'mini-ab'
const MATE_SCORE = 100000
const MATE_BOUND = MATE_SCORE - 1000
const INF = 1 << 28
const QUIESCE_DEPTH = 4
const PV_PLIES = 4
const PV_SUB_DEPTH = 2

const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 }

/* 棋子位置价值表：索引 0 = a8，行序与棋盘一致（白方视角） */
const PST = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20
  ],
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20
  ],
  kEnd: [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50
  ]
}

const FILES = 'abcdefgh'

/** 0x88 索引 → 棋格名 */
function squareOf(index) {
  return FILES[index & 15] + (8 - (index >> 4))
}

function uciOfRaw(move) {
  return squareOf(move.from) + squareOf(move.to) + (move.promotion || '')
}

/* ------------------------------------------------------------ 局面评估 */

/** 静态评估，白方视角（单位：厘兵） */
function evaluateWhite(chess) {
  const board = chess.raw_board()
  let material = 0
  let whiteBishops = 0
  let blackBishops = 0

  for (let i = 0; i < 128; i++) {
    if (i & 0x88) {
      i += 7
      continue
    }
    const p = board[i]
    if (!p) continue
    if (p.type !== 'p' && p.type !== 'k') material += VALUE[p.type]
    if (p.type === 'b') {
      if (p.color === 'w') whiteBishops++
      else blackBishops++
    }
  }

  const endgame = material <= 1400
  let score = 0

  for (let i = 0; i < 128; i++) {
    if (i & 0x88) {
      i += 7
      continue
    }
    const p = board[i]
    if (!p) continue
    const idx = (i >> 4) * 8 + (i & 15)
    const posIdx = p.color === 'w' ? idx : 63 - idx
    const table = p.type === 'k' ? (endgame ? PST.kEnd : PST.k) : PST[p.type]
    const value = VALUE[p.type] + table[posIdx]
    score += p.color === 'w' ? value : -value
  }

  if (whiteBishops >= 2) score += 30
  if (blackBishops >= 2) score -= 30
  return score
}

function evaluateSideToMove(chess) {
  const white = evaluateWhite(chess)
  return chess.turn() === 'w' ? white : -white
}

/* -------------------------------------------------------------- 搜索 */

function orderMoves(moves) {
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    let s = 0
    if (m.captured) s += VALUE[m.captured] * 8 - VALUE[m.piece]
    if (m.promotion) s += VALUE[m.promotion]
    m.__ord = s
  }
  moves.sort((a, b) => b.__ord - a.__ord)
  return moves
}

function timeUp(ctx) {
  return Date.now() > ctx.deadline
}

function quiesce(chess, alpha, beta, qdepth, ply, ctx) {
  ctx.nodes++
  if ((ctx.nodes & 1023) === 0 && timeUp(ctx)) ctx.aborted = true
  if (ctx.aborted) return evaluateSideToMove(chess)

  const all = chess.raw_moves()
  if (all.length === 0) {
    return chess.in_check() ? -MATE_SCORE + ply : 0
  }

  const stand = evaluateSideToMove(chess)
  if (qdepth <= 0) return stand
  if (stand >= beta) return beta
  if (stand > alpha) alpha = stand

  const caps = []
  for (let i = 0; i < all.length; i++) {
    if (all[i].captured || all[i].promotion) caps.push(all[i])
  }
  if (!caps.length) return alpha
  orderMoves(caps)

  for (let i = 0; i < caps.length; i++) {
    chess.raw_move(caps[i])
    const s = -quiesce(chess, -beta, -alpha, qdepth - 1, ply + 1, ctx)
    chess.raw_undo()
    if (s >= beta) return beta
    if (s > alpha) alpha = s
  }
  return alpha
}

function negamax(chess, depth, alpha, beta, ply, ctx) {
  ctx.nodes++
  if ((ctx.nodes & 1023) === 0 && timeUp(ctx)) ctx.aborted = true
  if (ctx.aborted) return evaluateSideToMove(chess)

  if (depth <= 0) return quiesce(chess, alpha, beta, QUIESCE_DEPTH, ply, ctx)

  const moves = chess.raw_moves()
  if (moves.length === 0) {
    // 无子可动：将杀返回极值（越靠近根越大），逼和返回 0
    return chess.in_check() ? -MATE_SCORE + ply : 0
  }

  orderMoves(moves)
  let best = -INF
  for (let i = 0; i < moves.length; i++) {
    chess.raw_move(moves[i])
    const s = -negamax(chess, depth - 1, -beta, -alpha, ply + 1, ctx)
    chess.raw_undo()
    if (s > best) best = s
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return best
}

/** 枚举走法：raw 用于搜索，其中附带 SAN 供根节点与主变展示 */
function describeMoves(chess) {
  const pretty = chess.moves({ verbose: true })
  const byUci = new Map()
  for (let i = 0; i < pretty.length; i++) {
    const p = pretty[i]
    byUci.set(p.from + p.to + (p.promotion || ''), p.san)
  }
  const raw = chess.raw_moves()
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i]
    const uci = uciOfRaw(m)
    out.push({
      raw: m,
      uci: uci,
      san: byUci.get(uci) || uci,
      piece: m.piece,
      captured: m.captured || null,
      promotion: m.promotion || null
    })
  }
  return out
}

/**
 * 根节点搜索：返回按分数降序排列的 { entry, score }。
 * 用上一轮迭代的最优顺序做走法排序，提升剪枝效率。
 */
function searchRoot(chess, depth, ctx, prevOrder) {
  const moves = describeMoves(chess)
  if (!moves.length) return { complete: true, scored: [] }

  moves.sort((a, b) => {
    const ra = prevOrder && prevOrder.has(a.uci) ? prevOrder.get(a.uci) : -INF
    const rb = prevOrder && prevOrder.has(b.uci) ? prevOrder.get(b.uci) : -INF
    if (ra !== rb) return rb - ra
    let sa = 0
    let sb = 0
    if (a.captured) sa += VALUE[a.captured] * 8 - VALUE[a.piece]
    if (b.captured) sb += VALUE[b.captured] * 8 - VALUE[b.piece]
    return sb - sa
  })

  const scored = []
  let alpha = -INF
  let complete = true
  for (let i = 0; i < moves.length; i++) {
    if (timeUp(ctx)) {
      ctx.aborted = true
      complete = false
      break
    }
    const m = moves[i]
    chess.raw_move(m.raw)
    const s = -negamax(chess, depth - 1, -INF, -alpha, 1, ctx)
    chess.raw_undo()
    scored.push({ entry: m, score: s })
    if (s > alpha) alpha = s
  }
  if (!complete) {
    // 本轮未跑完，分数不完整，交给调用方沿用上一层结果
    return { complete: false, scored: [] }
  }
  scored.sort((a, b) => b.score - a.score)
  return { complete: true, scored }
}

/** 对候选走法用全窗口重搜，得到精确分数，保证 MultiPV 排序准确 */
function refine(chess, candidates, depth, ctx) {
  const out = []
  for (let i = 0; i < candidates.length; i++) {
    if (timeUp(ctx)) break
    const m = candidates[i].entry
    chess.raw_move(m.raw)
    const s = -negamax(chess, depth - 1, -INF, INF, 1, ctx)
    chess.raw_undo()
    out.push({ entry: m, score: s })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

/** 从首选走法出发，贪心展开主变（PV） */
function buildPv(chess, firstEntry, plies, ctx) {
  const pv = [firstEntry.uci]
  const pvSan = [firstEntry.san]
  const made = []

  chess.raw_move(firstEntry.raw)
  made.push(true)

  for (let i = 1; i < plies; i++) {
    if (ctx.aborted || timeUp(ctx)) break
    const moves = describeMoves(chess)
    if (!moves.length) break
    orderMoves(moves.map(m => m.raw))
    moves.sort((a, b) => (b.raw.__ord || 0) - (a.raw.__ord || 0))
    let best = null
    let bestScore = -INF
    for (let j = 0; j < moves.length; j++) {
      chess.raw_move(moves[j].raw)
      const s = -negamax(chess, PV_SUB_DEPTH - 1, -INF, INF, 1, ctx)
      chess.raw_undo()
      if (s > bestScore) {
        bestScore = s
        best = moves[j]
      }
    }
    if (!best) break
    pv.push(best.uci)
    pvSan.push(best.san)
    chess.raw_move(best.raw)
    made.push(true)
  }

  for (let i = made.length - 1; i >= 0; i--) chess.raw_undo()
  return { pv, pvSan }
}

/* ------------------------------------------------------------- 分数换算 */

/** 引擎内部分数 → UCI 风格 scoreCp / scoreMate（行棋方视角） */
function toScore(score) {
  if (score >= MATE_BOUND) {
    return { scoreCp: null, scoreMate: Math.ceil((MATE_SCORE - score) / 2) }
  }
  if (score <= -MATE_BOUND) {
    return { scoreCp: null, scoreMate: -Math.ceil((MATE_SCORE + score) / 2) }
  }
  return { scoreCp: Math.round(score), scoreMate: null }
}

/** 终局描述；未终局返回 null */
function describeTerminal(chess) {
  const turn = chess.turn()
  if (chess.in_checkmate()) {
    return {
      over: true,
      reason: 'checkmate',
      winner: turn === 'w' ? 'b' : 'w',
      label: `将杀 · ${turn === 'w' ? '黑方' : '白方'}胜`
    }
  }
  if (chess.in_stalemate()) {
    return { over: true, reason: 'stalemate', winner: null, label: '逼和 · 无子可动' }
  }
  if (chess.insufficient_material()) {
    return { over: true, reason: 'insufficient', winner: null, label: '和棋 · 子力不足' }
  }
  if (chess.in_threefold_repetition()) {
    return { over: true, reason: 'threefold', winner: null, label: '和棋 · 三次重复局面' }
  }
  if (chess.in_draw()) {
    return { over: true, reason: 'fifty', winner: null, label: '和棋 · 50 回合规则' }
  }
  return null
}

/* ---------------------------------------------------------------- 对外 */

function clampNumber(v, min, max, fallback) {
  const n = Number(v)
  if (!isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function nextTick() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * 分析局面（异步，逐层加深，中途让出主线程避免界面卡死）。
 *
 * @param {object} input
 * @param {string} input.fen            待分析局面
 * @param {number} [input.depth=3]      最大搜索深度（1~5）
 * @param {number} [input.multiPV=3]    返回路线数量（1~5）
 * @param {number} [input.maxTimeMs=3000] 时间上限，超出则退回已完成深度的结果
 * @param {(info:object)=>void} [input.onProgress] 迭代进度回调
 * @returns {Promise<object>}
 */
async function analyze(input) {
  const opts = input || {}
  const fen = opts.fen
  const maxDepth = clampNumber(opts.depth, 1, 5, 3)
  const multiPV = clampNumber(opts.multiPV, 1, 5, 3)
  const maxTimeMs = clampNumber(opts.maxTimeMs, 300, 20000, 3000)
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null

  if (typeof fen !== 'string' || !fen.trim()) {
    throw new Error('缺少 FEN，无法分析')
  }

  const normalized = fen.trim()
  const chess = new Chess()
  const check = chess.validate_fen(normalized)
  if (!check || check.valid !== true) {
    throw new Error((check && check.error) || 'FEN 不合法')
  }
  // validate_fen 只做校验，必须显式 load 才真正落到棋盘上
  chess.load(normalized)

  const startedAt = Date.now()
  const terminal = describeTerminal(chess)
  if (terminal) {
    return {
      engine: ENGINE_NAME,
      fen: chess.fen(),
      depth: 0,
      nodes: 0,
      elapsedMs: 0,
      sideToMove: chess.turn(),
      lines: [],
      terminal
    }
  }

  const ctx = { nodes: 0, deadline: startedAt + maxTimeMs, aborted: false }
  let scored = []
  let reached = 0
  let prevOrder = null

  for (let d = 1; d <= maxDepth; d++) {
    // 已跑到第 1 层时必须拿到可用结果，因此只在第一层给最短预算保护
    const round = searchRoot(chess, d, ctx, prevOrder)
    if (round.complete && round.scored.length) {
      scored = round.scored
      reached = d
      prevOrder = new Map()
      for (let i = 0; i < round.scored.length; i++) {
        prevOrder.set(round.scored[i].entry.uci, round.scored[i].score)
      }
    }
    const done = ctx.aborted || timeUp(ctx)
    if (onProgress) onProgress({ depth: d, nodes: ctx.nodes, reached, timeout: done })
    if (done) break
    if (d < maxDepth) await nextTick()
  }

  if (!scored.length) {
    return {
      engine: ENGINE_NAME,
      fen: chess.fen(),
      depth: reached,
      nodes: ctx.nodes,
      elapsedMs: Date.now() - startedAt,
      sideToMove: chess.turn(),
      lines: [],
      terminal: null
    }
  }

  // 前若干候选做全窗口精确重搜，其余保持上界估计
  const wanted = Math.min(scored.length, multiPV + 2)
  ctx.aborted = false
  ctx.deadline = Date.now() + Math.max(500, Math.min(1500, Math.round(maxTimeMs * 0.4)))
  const candidates = refine(chess, scored.slice(0, wanted), Math.max(1, reached), ctx)

  // 重搜被时间截断时，用根节点已有序的走法补齐，保证始终返回 multiPV 条路线
  if (candidates.length < multiPV) {
    const seen = new Set()
    for (let i = 0; i < candidates.length; i++) seen.add(candidates[i].entry.uci)
    for (let i = 0; i < scored.length && candidates.length < multiPV; i++) {
      if (seen.has(scored[i].entry.uci)) continue
      candidates.push(scored[i])
    }
  }

  const chosen = candidates.slice(0, multiPV)
  // 主变展开单独给一点额外时间预算
  ctx.aborted = false
  ctx.deadline = Date.now() + 1200

  const lines = chosen.map((item, index) => {
    const pvInfo = buildPv(chess, item.entry, PV_PLIES, ctx)
    const score = toScore(item.score)
    return {
      rank: index + 1,
      uci: item.entry.uci,
      san: item.entry.san,
      from: squareOf(item.entry.raw.from),
      to: squareOf(item.entry.raw.to),
      captured: item.entry.captured,
      scoreCp: score.scoreCp,
      scoreMate: score.scoreMate,
      pv: pvInfo.pv,
      pvSan: pvInfo.pvSan
    }
  })

  return {
    engine: ENGINE_NAME,
    fen: chess.fen(),
    depth: reached,
    nodes: ctx.nodes,
    elapsedMs: Date.now() - startedAt,
    sideToMove: chess.turn(),
    lines,
    terminal: null
  }
}

module.exports = {
  analyze,
  evaluateWhite,
  toScore,
  describeTerminal,
  squareOf,
  ENGINE_NAME
}
