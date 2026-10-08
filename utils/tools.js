/**
 * tools.js
 * 端上确定性工具层（Agent 化阶段一 · Candidate Grounding）。
 *
 * 设计铁律（见 agent-plan.md §4.1 / §5）：
 *   - 走法只能由 chess.js 产生，本层是模型与「真实走法」之间的唯一闸门；
 *   - 内部一律用 raw_*，SAN 只在返回值处生成一次（避免搜索树内 O(n^2) 的 make_pretty）；
 *   - 纯逻辑，无 wx / DOM / 页面依赖，可单独单测、零成本、离线可用。
 *
 * 本文件刻意**不** import ai-client（避免循环依赖，也避免牵动云服务/云 SDK）。
 * 白方视角分数换算与 ai-client#formatScore 保持同构（见 toWhiteCp 注释），
 * 不要在这里另起一套语义。
 */
'use strict'

const { Chess } = require('./chess.js')
const engine = require('./engine.js')

const FILES = 'abcdefgh'
const MAX_LINE_MOVES = 8

/** 0x88 索引 → 棋格名（与 engine.squareOf 一致） */
function squareOf(index) {
  return FILES[index & 15] + (8 - (index >> 4))
}

/** 判断字符串是否为 UCI 着法（e2e4 / e7e8q） */
function looksUci(str) {
  return /^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/.test(str)
}

/**
 * 在 chess 实例上施加一步走法。chess.js 的 move() 只接受 SAN 字符串或
 * {from,to,promotion} 对象，不接受 UCI 字符串，这里做一层兼容：
 * UCI 串转成对象形式，SAN 串原样传入。任一非法返回 null（不抛错）。
 */
function applyMove(chess, str) {
  if (typeof str !== 'string') return null
  if (looksUci(str)) {
    try {
      return chess.move({ from: str.slice(0, 2), to: str.slice(2, 4), promotion: str.length > 4 ? str[4] : undefined })
    } catch (e) {
      return null
    }
  }
  try {
    return chess.move(str)
  } catch (e) {
    return null
  }
}

/**
 * 把引擎输出的一行换算成白方视角的 cp（与 ai-client#formatScore.whiteCp 同构）。
 * 模型/界面只用白方视角分数，避免 Loss vs 用户视角不一致（agent-plan.md §9）。
 */
function toWhiteCp(line, sideToMove) {
  const sign = sideToMove === 'w' ? 1 : -1
  if (line && line.scoreMate !== null && line.scoreMate !== undefined) {
    const mate = line.scoreMate * sign
    return mate > 0 ? 99999 : -99999
  }
  return ((line && line.scoreCp) || 0) * sign
}

/**
 * 合法走法候选池。
 * @param {string} fen
 * @param {object} [opts]
 *   - only: 只看某一个 SAN（用于候选就近纠正时的精确匹配）
 *   - limit: 最多返回多少条
 * @returns {Array<{uci, san, from, to, piece, capture, check, mate}>}
 *
 * 实现：raw_moves() 取走法集合（O(n)），moves({verbose:true}) 只在返回边界生成一次 SAN，
 * 按 UCI 字符串把两者对应起来。搜索树内严禁调用本函数。
 */
function legalMoves(fen, opts) {
  opts = opts || {}
  const chess = new Chess()
  const check = chess.validate_fen(fen)
  if (!check || check.valid !== true) return []
  chess.load(fen)

  const raw = chess.raw_moves()
  const pretty = chess.moves({ verbose: true })
  const byUci = {}
  for (let i = 0; i < pretty.length; i++) {
    const p = pretty[i]
    byUci[p.from + p.to + (p.promotion || '')] = p
  }

  const only = typeof opts.only === 'string' && opts.only ? opts.only.trim() : null
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : null

  const out = []
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i]
    const uci = squareOf(m.from) + squareOf(m.to) + (m.promotion || '')
    const v = byUci[uci]
    if (!v) continue // 理论上不会，防御性
    if (only && v.san !== only) continue
    const san = v.san
    out.push({
      uci: uci,
      san: san,
      from: v.from,
      to: v.to,
      piece: v.piece,
      capture: !!v.captured,
      check: /[+#]$/.test(san),
      mate: san.slice(-1) === '#'
    })
    if (limit && out.length >= limit) break
  }
  return out
}

/**
 * 从任意局面出发，逐手施加走法并返回每一步之后局面的评估。
 *
 * 两种用法：
 *   - 给定 seed 走法（moves 为 SAN/UCI 数组），先把它们落到棋盘上；
 *   - 再用引擎对该局面的最佳应对逐手展开 `extend` 步（不是随机合法走法——
 *     否则演示线会变成随机对局，讲解价值为零）。
 *
 * 任一手非法即停止，返回已成功施加的部分（complete=false, failedAt=该手序号）。
 *
 * @param {string} fen
 * @param {Array<string>} moves  SAN 或 UCI 数组（作为起点前缀）
 * @param {object} [opts] { depth, extend }
 * @returns {Promise<{ path: Array<{ply, san, uci, fenAfter, whiteCp, best}>,
 *                      complete: boolean, failedAt: number|null }>}
 */
async function expandLine(fen, moves, opts) {
  opts = opts || {}
  const depth = typeof opts.depth === 'number' && opts.depth > 0 ? opts.depth : 3
  const extend = typeof opts.extend === 'number' && opts.extend >= 0 ? Math.min(opts.extend, 4) : 0

  const chess = new Chess()
  const check = chess.validate_fen(fen)
  if (!check || check.valid !== true) {
    return { path: [], complete: false, failedAt: 0 }
  }
  chess.load(fen)

  const path = []
  let ply = 0

  // 1) 施加 seed 走法（模型/上层给定的前缀，必须是合法走法）
  const seed = Array.isArray(moves) ? moves : []
  for (let i = 0; i < seed.length; i++) {
    const mv = applyMove(chess, seed[i])
    if (!mv) return { path: path, complete: false, failedAt: ply }
    ply++
    const fenAfter = chess.fen()
    const evalRes = await evaluateAt(fenAfter, depth)
    path.push({
      ply: ply,
      san: mv.san,
      uci: uciOf(mv),
      fenAfter: fenAfter,
      whiteCp: evalRes.whiteCp,
      best: evalRes.bestSan
    })
  }

  // 2) 用引擎最佳应对逐手展开 extend 步
  for (let i = 0; i < extend; i++) {
    const curFen = chess.fen()
    const evalRes = await evaluateAt(curFen, depth)
    if (!evalRes || !evalRes.bestUci) break
    const mv = applyMove(chess, evalRes.bestUci)
    if (!mv) break
    ply++
    const fenAfter = chess.fen()
    const next = await evaluateAt(fenAfter, depth)
    path.push({
      ply: ply,
      san: mv.san,
      uci: uciOf(mv),
      fenAfter: fenAfter,
      whiteCp: next.whiteCp,
      best: next.bestSan
    })
  }

  return { path: path, complete: true, failedAt: null }
}

/** 着法 → UCI 串 */
function uciOf(mv) {
  return (mv.from || '') + (mv.to || '') + (mv.promotion || '')
}

/**
 * 对某一局面跑一次轻量引擎分析，取最佳路线换算成白方视角分数与最佳着法。
 * 仅供 expandLine 内部使用（演示线展开），不复用到正常的「三条路线」分析链路。
 */
async function evaluateAt(fen, depth) {
  try {
    const res = await engine.analyze({ fen: fen, depth: depth, multiPV: 1 })
    const line = res && res.lines && res.lines[0]
    if (!line) return { whiteCp: null, bestSan: null, bestUci: null }
    const sideToMove = res.sideToMove || 'w'
    return {
      whiteCp: toWhiteCp(line, sideToMove),
      bestSan: line.san || null,
      bestUci: line.uci || null
    }
  } catch (e) {
    return { whiteCp: null, bestSan: null, bestUci: null }
  }
}

module.exports = {
  legalMoves,
  expandLine,
  applyMove,
  squareOf,
  toWhiteCp,
  MAX_LINE_MOVES
}
