/**
 * pgn-tree.js · PGN 边界解析（L0，只在 import 边界转换一次）
 *
 * 为什么不用 chess.js 的 load_pgn：
 *   0.10.3 的 load_pgn 会把 RAV（圆括号变例）**整段删掉**，只能重建主线。
 *   打谱模式的核心价值恰恰是「主线 + 变例」的走法树，所以这里自己解析 movetext。
 *
 * 输出结构与 session.js 的节点一致（只多一个 fenBefore，供变例回溯起点）：
 *   { ok, headers, rootFen, moves, plyCount, variationCount, result, error }
 *   moves = [ { san, from, to, promotion, uci, fenBefore, alts: [seq, ...] } ]
 *     - alts 是该步的「替代走法」序列，语义等价于 PGN 的 ( ... )：
 *       从**这一步之前**的局面开始，所以它是这一步的兄弟分支。
 *
 * 解析用真实规则校验（每一步都过 chess.js），因此非法 SAN 会在边界被拦住，
 * 不会把脏数据带进 session；错误信息带上步数与 token，方便用户自己定位。
 *
 * 不依赖 wx / DOM，可纯 Node 单测。
 */
'use strict'

const { Chess } = require('./chess.js')

/** 标准开局（PGN 没有 [FEN] 时的根局面；注意不能用 session/game 的预置中局） */
const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const RESULTS = ['1-0', '0-1', '1/2-1/2', '½-½', '*']

function fail(error, parsed) {
  return {
    ok: false,
    error: error,
    headers: (parsed && parsed.headers) || {},
    rootFen: (parsed && parsed.rootFen) || STANDARD_FEN,
    moves: [],
    plyCount: 0,
    variationCount: 0,
    result: ''
  }
}

/**
 * 拆出 PGN 头（[Key "Value"]）与 movetext。
 * 头与 movetext 之间允许有空行，也允许没有——按「连续以 [Key "Value"] 开头的行」收紧。
 */
function splitHeaders(text) {
  const lines = String(text).replace(/^\ufeff/, '').split(/\r?\n/)
  const headers = {}
  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const m = /^\[([A-Za-z][A-Za-z0-9_]*)\s+"([^"]*)"\]$/.exec(line)
    if (!m) break
    headers[m[1]] = m[2]
  }
  return { headers, movetext: lines.slice(i).join('\n') }
}

/**
 * movetext 切词：注释、回合号、NAG、结果、括号都归一成 token。
 * token 类型：{ type:'san', value } / { type:'open' } / { type:'close' } / { type:'result', value }
 */
function tokenize(movetext) {
  let s = String(movetext)
  s = s.replace(/;[^\n]*/g, ' ')            // 行注释（PGN 允许，虽少见）
  s = s.replace(/\{[^}]*\}/g, ' ')          // 花括号注释（不嵌套）
  s = s.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ')
  const raw = s.split(/\s+/).filter(Boolean)

  const out = []
  for (let i = 0; i < raw.length; i++) {
    let tok = raw[i]
    if (!tok) continue
    if (tok === '(') { out.push({ type: 'open' }); continue }
    if (tok === ')') { out.push({ type: 'close' }); continue }
    if (RESULTS.indexOf(tok) !== -1) { out.push({ type: 'result', value: tok }); continue }
    if (/^\$\d+$/.test(tok)) continue        // NAG
    tok = tok.replace(/^\d+\.+/, '')         // "1." / "12..." / "3.e4"
    if (!tok) continue
    tok = tok.replace(/[!?]+$/, '')          // 评注符号 e4!? → e4
    if (!tok || /^\d+$/.test(tok)) continue
    if (/^\.+$/.test(tok)) continue
    if (RESULTS.indexOf(tok) !== -1) { out.push({ type: 'result', value: tok }); continue }
    // 兼容用数字零写王车易位的老式 PGN
    tok = tok.replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O')
    out.push({ type: 'san', value: tok })
  }
  return out
}

/**
 * 解析 PGN 文本为走法树。
 * @param {string} text
 * @returns {object} 见文件头；解析失败时 ok=false 且 error 说明原因
 */
function parsePgn(text) {
  if (typeof text !== 'string' || !text.trim()) return fail('PGN 为空')

  const split = splitHeaders(text)
  const headers = split.headers
  const fenHeader = (headers.FEN && String(headers.FEN).trim()) || ''
  const rootFen = fenHeader || STANDARD_FEN

  const rootProbe = new Chess()
  const check = rootProbe.validate_fen(rootFen)
  if (!check || check.valid !== true) {
    return fail('PGN 里的 FEN 不合法：' + (check && check.error ? check.error : rootFen), { headers, rootFen })
  }

  const tokens = tokenize(split.movetext)
  if (!tokens.length) return fail('没有找到走法', { headers, rootFen })

  rootProbe.load(rootFen)
  const rootCtx = { chess: rootProbe, seq: [], item: null }
  const stack = [rootCtx]
  let plyCount = 0
  let variationCount = 0
  let result = headers.Result || ''

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    const ctx = stack[stack.length - 1]

    if (tok.type === 'result') { result = tok.value; continue }

    if (tok.type === 'open') {
      // 变例替换的是「当前上下文的上一步」，所以起点是那一步之前的局面
      if (!ctx.item) return fail('变例括号前没有可替换的走法', { headers, rootFen })
      const altChess = new Chess()
      const altCheck = altChess.validate_fen(ctx.item.fenBefore)
      if (!altCheck || altCheck.valid !== true) return fail('变例起点局面不合法', { headers, rootFen })
      altChess.load(ctx.item.fenBefore)
      stack.push({ chess: altChess, seq: [], item: null })
      continue
    }

    if (tok.type === 'close') {
      if (stack.length <= 1) return fail('变例括号不配对（多了右括号）', { headers, rootFen })
      const closing = stack.pop()
      if (!closing.seq.length) return fail('变例里没有走法', { headers, rootFen })
      const parent = stack[stack.length - 1]
      parent.item.alts.push(closing.seq)
      variationCount += 1
      continue
    }

    const fenBefore = ctx.chess.fen()
    let mv = null
    try { mv = ctx.chess.move(tok.value) } catch (e) { mv = null }
    if (!mv) {
      return fail('第 ' + (plyCount + 1) + ' 步无法解析：' + tok.value, { headers, rootFen })
    }
    plyCount += 1
    ctx.item = {
      san: mv.san,
      from: mv.from,
      to: mv.to,
      promotion: mv.promotion || '',
      uci: mv.from + mv.to,
      fenBefore: fenBefore,
      alts: []
    }
    ctx.seq.push(ctx.item)
  }

  if (stack.length !== 1) return fail('变例括号不配对（少了右括号）', { headers, rootFen })
  if (!rootCtx.seq.length) return fail('没有找到走法', { headers, rootFen })

  return {
    ok: true,
    error: '',
    headers: headers,
    rootFen: rootFen,
    moves: rootCtx.seq,
    plyCount: plyCount,
    variationCount: variationCount,
    result: result
  }
}

/**
 * 把解析结果灌进 Session（调用方传入 Session 实例，避免 session.js ↔ pgn-tree.js 循环依赖）。
 * 主线先进 children[0]，变例再作为兄弟节点追加，这样后续 UI 读 children[0] 就是主线。
 * @returns {boolean} 全部走法都成功落地返回 true
 */
function buildInto(session, parsed) {
  if (!session || !parsed || !parsed.ok) return false
  session.reset(parsed.rootFen)
  const ok = applySequence(session, session.root().id, parsed.moves)
  session.gotoRoot()
  return ok
}

function applySequence(session, parentId, seq) {
  let curId = parentId
  for (let i = 0; i < seq.length; i++) {
    const item = seq[i]
    session.goto(curId)
    const node = session.applyMove(item.from, item.to, item.promotion || undefined)
    if (!node) return false

    for (let j = 0; j < item.alts.length; j++) {
      const alt = item.alts[j]
      const first = alt && alt[0]
      if (!first) continue
      session.goto(curId)
      const altNode = session.forkFrom(curId, first.from, first.to, first.promotion || undefined)
      if (!altNode) continue
      if (!applySequence(session, altNode.id, alt.slice(1))) return false
    }

    curId = node.id
  }
  session.goto(curId)
  return true
}

module.exports = { parsePgn, buildInto, tokenize, splitHeaders, STANDARD_FEN, RESULTS }
