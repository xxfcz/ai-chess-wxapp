/**
 * agent-tools.test.js
 * 阶段一 · Candidate Grounding 回归：端上工具层 + 候选落地。
 *
 * 覆盖需求 R1~R10 与 §8.2 必测矩阵：
 *   - tools.legalMoves / expandLine 纯函数行为；
 *   - buildToolContext 候选表（成本/上限/劣手）；
 *   - groundDemoLines 把 cand+extend 落地为真实合法走法、就近纠正、兼容旧 moves、损坏 JSON、终局、_lastResult 缺失。
 *
 * 直接用 node 跑（零依赖，不依赖 wx / DOM / 网络）：
 *   node .workbuddy/tests/agent-tools.test.js
 */
'use strict'

const H = require('./_harness')
const { Chess } = require('../../utils/chess.js')
const engine = require('../../utils/engine.js')
const tools = require('../../utils/tools.js')
const ai = require('../../utils/ai-client.js')
const coachDemo = require('../../utils/coach-demo.js')
const { START_FEN } = require('../../utils/game.js')

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
// 学者将杀之后（黑被将死，无合法走法）
const CHECKMATE_FEN = 'r1bqkbnr/pppp1Qpp/2n5/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4'

/** 把一串 SAN 在 fen 上依次施加，任一非法返回 false */
function replayLegal(fen, sans) {
  const chess = new Chess()
  const check = chess.validate_fen(fen)
  if (!check || check.valid !== true) return false
  chess.load(fen)
  for (let i = 0; i < sans.length; i++) {
    try {
      if (!chess.move(sans[i])) return false
    } catch (e) {
      return false
    }
  }
  return true
}

async function main() {
  /* ----------------------------------------------- 1. tools.legalMoves */
  H.section('1. tools.legalMoves（端上合法走法候选池）')

  const all = tools.legalMoves(INITIAL_FEN, {})
  H.eq(all.length, 20, '起始局面有 20 个合法走法')
  const sample = all[0]
  H.ok(sample && sample.uci && sample.san && sample.from && sample.to && sample.piece,
    '每个候选含 uci/san/from/to/piece')
  H.ok('capture' in sample && 'check' in sample && 'mate' in sample,
    '每个候选含 capture/check/mate 字段')
  H.ok(all.every(m => typeof m.san === 'string' && m.san.length > 0), 'SAN 均为非空字符串')

  const onlyE4 = tools.legalMoves(INITIAL_FEN, { only: 'e4' })
  H.eq(onlyE4.length, 1, 'only:e4 只返回 1 个候选')
  H.eq(onlyE4[0] && onlyE4[0].san, 'e4', 'only:e4 命中的是 e4')

  const limited = tools.legalMoves(INITIAL_FEN, { limit: 5 })
  H.ok(limited.length <= 5, 'limit:5 不超过 5 条')

  const badFen = tools.legalMoves('这不是FEN', {})
  H.eq(badFen.length, 0, '非法 FEN 返回空数组，不抛错')

  /* ----------------------------------------------- 2. tools.expandLine */
  H.section('2. tools.expandLine（端上逐手展开 + 评估）')

  const ex1 = await tools.expandLine(INITIAL_FEN, ['e2e4'], { depth: 2, extend: 2 })
  H.eq(ex1.path.length, 3, 'R9 · extend=2 产出 3 手（1 首手 + 2 展开）')
  H.ok(ex1.complete === true, '合法 seed + 充足 extend → complete=true')
  H.ok(replayLegal(INITIAL_FEN, ex1.path.map(p => p.san)), 'R1 · 展开的每一步都是合法走法')
  const p0 = ex1.path[0]
  H.ok(p0 && typeof p0.ply === 'number' && p0.san && p0.uci && p0.fenAfter &&
    'whiteCp' in p0 && 'best' in p0, 'path 条目含 ply/san/uci/fenAfter/whiteCp/best')
  H.eq(p0.ply, 1, '首个 path 条目的 ply=1')

  const exBad = await tools.expandLine(INITIAL_FEN, ['e2e5'], { depth: 2, extend: 2 })
  H.eq(exBad.path.length, 0, '非法 seed → 路径为空')
  H.eq(exBad.complete, false, '非法 seed → complete=false')
  H.eq(exBad.failedAt, 0, '非法 seed → failedAt=0')

  const ex0 = await tools.expandLine(INITIAL_FEN, ['e2e4'], { depth: 2, extend: 0 })
  H.eq(ex0.path.length, 1, 'extend=0 只有候选首手自己')

  /* ------------------------------------------- 3. buildToolContext */
  H.section('3. buildToolContext（候选表 + 文本）')

  const result = await engine.analyze({ fen: START_FEN, depth: 2, multiPV: 3 })
  const toolCtx = await ai.buildToolContext(START_FEN, result, { topN: 6 })
  H.ok(Array.isArray(toolCtx.candidates) && toolCtx.candidates.length >= 1,
    '从引擎结果整理出候选')
  H.ok(toolCtx.candidates.length <= 6, 'R5 · 候选条目 ≤ topN(6)')
  H.ok(toolCtx.candidates.length <= 8, 'R5 · 候选条目 ≤ 8')
  H.ok(toolCtx.candidates.every(c => c.no != null && c.uci && c.san && 'whiteCp' in c && Array.isArray(c.next)),
    '每个候选含 no/uci/san/whiteCp/next')
  H.ok(toolCtx.candidates.some(c => c.no === 1 && c.whiteCp != null),
    '首选候选带有白方视角分数')
  H.ok(toolCtx.text.indexOf('#1') !== -1, '候选文本含 #1 编号')
  H.ok(toolCtx.text.indexOf('不确定能走到') === -1, '候选文本不含旧合法性教条（R2 已删除）')
  H.ok(toolCtx.text.length <= 400, 'R5 · 候选上下文 ≤ 400 字符（token 预算）')

  // 缺 results 时的轻量补跑兜底
  const fallback = await ai.buildToolContext(START_FEN, { lines: [], sideToMove: 'w' }, { topN: 6 })
  H.ok(fallback.candidates.length >= 1, '_lastResult 缺失时仍补跑产出候选')

  /* ------------------------------------------- 4. groundDemoLines 矩阵 */
  H.section('4. groundDemoLines（cand+extend 落地 / 就近纠正 / 兼容旧格式）')

  const demoBlock = (lines) =>
    '这个局面白方略优。\n===DEMO===\n' + JSON.stringify({ lines: lines }) + '\n===END===\n'

  // 4.1 合法 cand + extend → 真实合法走法
  {
    const c1 = toolCtx.candidates[0]
    const text = demoBlock([{ id: 'main', label: '主线', tone: 'good', desc: '稳住中心', base: 'root', cand: '#1', extend: 2 }])
    const ground = await ai.groundDemoLines(text, toolCtx.candidates, START_FEN, { depth: 2 })
    const parsed = coachDemo.parseDemo(ground.text, START_FEN)
    H.eq(parsed.lines.length, 1, '合法 cand 落地产出 1 条演示线')
    const mv = parsed.lines[0].moves
    H.eq(mv.length, 3, 'R9 · extend=2 → 3 手')
    H.ok(replayLegal(START_FEN, mv), 'R1 · 落地走法全部合法')
    H.eq(mv[0], c1.san, 'R10 · 首手是被点评局面下的合法候选首手')
    const legalUci = tools.legalMoves(START_FEN, {}).map(m => m.uci)
    H.ok(legalUci.indexOf(c1.uci) !== -1, 'R10 · 首手 uci 在合法走法集合中')
    H.ok(ground.warnings.length === 0, '合法落地无告警')
  }

  // 4.2 非法编号 → 该线降级丢弃，正文不受影响，其它线存活
  {
    const text = demoBlock([
      { id: 'main', label: '主线', tone: 'good', desc: '稳住中心', base: 'root', cand: '#1', extend: 0 },
      { id: 'bad', label: '瞎选', tone: 'bad', desc: '不存在的候选', base: 'root', cand: '#99', extend: 0 }
    ])
    const ground = await ai.groundDemoLines(text, toolCtx.candidates, START_FEN, { depth: 2 })
    const parsed = coachDemo.parseDemo(ground.text, START_FEN)
    H.eq(parsed.lines.length, 1, '非法候选线被丢弃，合法线保留')
    H.ok(ground.warnings.length > 0, '非法候选有告警留痕')
    H.ok(parsed.prose.indexOf('白方略优') !== -1, '正文（prose）不受影响')
    H.eq(parsed.lines[0].id, 'main', '存活的是合法线')
  }

  // 4.3 仍走旧 moves 格式 → 透传，交给 resolveMoves 截断容错（R3）
  {
    const text = demoBlock([{ id: 'legacy', label: '老格式', tone: 'good', desc: '稳住中心', base: 'root', moves: ['Nf3', 'Nc6'] }])
    const ground = await ai.groundDemoLines(text, toolCtx.candidates, INITIAL_FEN, { depth: 2 })
    const parsed = coachDemo.parseDemo(ground.text, INITIAL_FEN)
    H.eq(parsed.lines.length, 1, '旧 moves 格式仍产出 1 条线')
    H.eq(parsed.lines[0].moves.length, 2, '旧 moves 透传保留 2 手')
    H.ok(replayLegal(INITIAL_FEN, parsed.lines[0].moves), '旧 moves 透传后仍合法')
  }

  // 4.4 损坏的 JSON → 降级为无演示线，正文干净，不抛错
  {
    const text = '正文内容。\n===DEMO===\n{这不是 JSON\n===END==='
    let threw = false
    let ground
    try {
      ground = await ai.groundDemoLines(text, toolCtx.candidates, START_FEN, { depth: 2 })
    } catch (e) { threw = true }
    H.ok(!threw, '损坏 JSON 不抛错')
    const parsed = coachDemo.parseDemo(ground.text, START_FEN)
    H.eq(parsed.lines.length, 0, '损坏 JSON → 无演示线')
    H.ok(parsed.prose.indexOf('正文内容') !== -1, '正文保留')
  }

  // 4.5 终局（无合法走法）→ 候选为空，演示线落地失败但正文不受影响
  {
    const termResult = await engine.analyze({ fen: CHECKMATE_FEN, depth: 1, multiPV: 1 })
    const tctx = await ai.buildToolContext(CHECKMATE_FEN, termResult, { topN: 6 })
    H.eq(tctx.candidates.length, 0, '终局无合法走法 → 候选为空')
    const text = demoBlock([{ id: 'x', label: 'X', tone: 'good', desc: 'd', base: 'root', cand: '#1', extend: 0 }])
    const ground = await ai.groundDemoLines(text, tctx.candidates, CHECKMATE_FEN, { depth: 2 })
    const parsed = coachDemo.parseDemo(ground.text, CHECKMATE_FEN)
    H.eq(parsed.lines.length, 0, '终局下不产出演示线')
    H.ok(ground.warnings.length > 0, '终局落地有告警')
  }

  // 4.6 extend=0 → 只有候选首手
  {
    const text = demoBlock([{ id: 'm', label: '主线', tone: 'good', desc: 'd', base: 'root', cand: '#2', extend: 0 }])
    const ground = await ai.groundDemoLines(text, toolCtx.candidates, START_FEN, { depth: 2 })
    const parsed = coachDemo.parseDemo(ground.text, START_FEN)
    H.eq(parsed.lines[0].moves.length, 1, 'extend=0 只有候选首手')
  }

  /* ------------------------------------------- 5. resolveMoves whitelist 钩子 */
  H.section('5. coach-demo.resolveMoves（第六参 whitelist 前向兼容）')

  {
    const byId = {}
    const rootFen = INITIAL_FEN
    const item = { base: 'root', moves: ['Nf3', 'Nc6'], id: 't' }
    const visited = new Set()
    const r1 = coachDemo.resolveMoves(item, byId, rootFen, visited)
    H.ok(r1 && r1.applied && r1.applied.length === 2, '不传 whitelist 时行为不变（2 手合法）')
    const r2 = coachDemo.resolveMoves(item, byId, rootFen, new Set(), null)
    H.ok(r2 && r2.applied && r2.applied.length === 2, '显式传 null whitelist 行为不变')
  }

  H.summary('agent-tools.test.js')
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
