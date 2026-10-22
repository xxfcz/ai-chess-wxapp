/**
 * comment-model.test.js
 * L0 点评协议层（utils/comment-model.js）单测：演示线解析/会话、富文本切片、内联标记协议。
 *
 * 纯 Node 跑：node .workbuddy/tests/comment-model.test.js
 */
'use strict'

const H = require('./_harness')
const cm = require('../../utils/comment-model')

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function main() {
  H.section('1. 演示线解析（迁移自 coach-demo，行为不变）')

  const demoText = [
    '这个局面白方子力略占优。',
    '推荐走 Nf3。',
    '===DEMO===',
    JSON.stringify({ lines: [{ id: 'main', label: '主线走法', tone: 'good', desc: '稳住中心', moves: ['Nf3', 'Nc6'] }] }),
    '===END==='
  ].join('\n')

  const parsed = cm.parseDemo(demoText, INITIAL_FEN)
  H.eq(parsed.lines.length, 1, '解析出 1 条演示线')
  H.eq(parsed.lines[0].id, 'main', '线 id 保留')
  H.eq(parsed.lines[0].tone, 'good', 'tone 保留')
  H.eq(parsed.lines[0].moves.length, 2, '两步走法都被接受')
  H.eq(parsed.prose.indexOf('===DEMO===') === -1, true, 'stripped prose 不带结构化标记')

  // 排序：good 在前
  const multi = cm.parseDemo(
    '正文\n===DEMO===\n' + JSON.stringify({
      lines: [
        { id: 'b', tone: 'bad', moves: ['Nf3'] },
        { id: 'g', tone: 'good', moves: ['e4'] },
        { id: 'n', tone: 'neutral', moves: ['d4'] }
      ]
    }) + '\n===END===', INITIAL_FEN)
  H.eq(multi.lines[0].id, 'g', 'good 排第一')
  H.eq(multi.lines[2].tone, 'neutral', 'neutral 排最后')

  // 非法手截断
  const truncated = cm.parseDemo(
    '正文\n===DEMO===\n' + JSON.stringify({
      lines: [{ id: 't', tone: 'good', moves: ['e4', 'Qh99', 'Nf3'] }]
    }) + '\n===END===', INITIAL_FEN)
  H.eq(truncated.lines.length, 1, '部分非法时整条保留')
  H.eq(truncated.lines[0].moves.length, 1, '非法手被截断，只保留合法前缀')

  // 坏 JSON 降级
  const broken = cm.parseDemo('正文\n===DEMO===\n{这不是 JSON\n===END===', INITIAL_FEN)
  H.eq(broken.lines.length, 0, '坏 JSON 降级为无演示线')

  H.section('2. 演示会话（DemoSession）')

  const session = new cm.DemoSession(parsed.lines, INITIAL_FEN, { flipped: false })
  session.enter('main')
  H.eq(session.active, true, '进入演示线')
  const v0 = session.view()
  H.eq(v0.cells.length, 64, '演示视图产出 64 格')
  H.eq(v0.total, 2, '面包屑里总数 = 2 步')
  session.step(1)
  H.eq(session.cursor, 1, '前进一步')
  session.step(1)
  H.eq(session.view().demoCanForward, false, '末步不能继续前进')
  const raw = session.view()
  H.eq(typeof raw.demoActive, 'boolean', 'view() 产出 demoActive')
  H.eq(typeof raw.active, 'undefined', 'view() 不再产出旧字段 active')

  H.section('3. 富文本切片（tokenizeText）')

  const segs = cm.tokenizeText('白方走 e4，黑方应以 e5。', { lines: [], rootTurn: 'w' })
  H.ok(Array.isArray(segs), '返回片段数组')
  // e4 / e5 命中棋盘格子记号（边界检查）
  const squares = segs.filter(s => s.kind === 'sq').map(s => s.sq)
  H.ok(squares.indexOf('e4') !== -1, 'e4 被识别为格子记号')
  H.ok(squares.indexOf('e5') !== -1, 'e5 被识别为格子记号')

  // 棋子记号
  const pieceSegs = cm.tokenizeText('黑后很活跃。', { lines: [], rootTurn: 'w' })
  const piece = pieceSegs.find(s => s.kind === 'piece')
  H.ok(piece && piece.piece === 'bq', '「黑后」解析为 bq（黑后）')

  H.section('4. 平台级内联标记协议（新增）')

  const inline = cm.parseComment('请考虑 [move:e2e4] 这步，或看 [branch:main] 的讲解。', INITIAL_FEN)
  H.ok(inline.tokens && inline.tokens.length > 0, '解析出内联 token 流')
  const moveTok = inline.tokens.find(t => t.kind === 'move')
  H.ok(moveTok && moveTok.uci === 'e2e4', 'move 标记的 uci 正确')
  H.eq(moveTok.sq, 'e4', 'move 标记带落点（用于 focus 高亮）')
  const branchTok = inline.tokens.find(t => t.kind === 'branch')
  H.ok(branchTok && branchTok.branchId === 'main', 'branch 标记的 id 正确')

  // 带 ;FEN 的 move 标记：指定目标局面
  const inline2 = cm.tokenizeInline('对比 [move:e7e5;rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1]。')
  const mt2 = inline2.find(t => t.kind === 'move')
  H.eq(mt2.uci, 'e7e5', '带 FEN 的 move 标记 uci 正确')
  H.ok(mt2.fen.indexOf('rnbqkbnr') === 0, 'move 标记带目标 FEN')

  // 无标记：整段作为 text
  const plain = cm.tokenizeInline('只是一段普通文字，没有标记。')
  H.eq(plain.length, 1, '无标记时合并为单个 text 片段')
  H.eq(plain[0].kind, 'text', 'kind = text')

  // parseComment 同时产出演示线与内联 token（平台契约）
  const full = cm.parseComment(demoText, INITIAL_FEN)
  H.eq(full.lines.length, 1, 'parseComment 仍解析演示线')
  H.ok(Array.isArray(full.tokens), 'parseComment 产出内联 token 流')

  return H.summary('comment-model.test.js')
}

const green = main()
process.exit(green ? 0 : 1)
