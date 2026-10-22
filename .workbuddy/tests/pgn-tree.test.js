/**
 * pgn-tree.test.js
 * L0 PGN 边界解析（utils/pgn-tree.js）+ Session 接入（loadPgnTree / nodeCount / kingSquareUnderCheck）单测。
 *
 * 纯 Node 跑：node .workbuddy/tests/pgn-tree.test.js
 */
'use strict'

const H = require('./_harness')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const pt = require(path.join(ROOT, 'utils', 'pgn-tree.js'))
const { Session } = require(path.join(ROOT, 'utils', 'session.js'))

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const HEADER_PGN = [
  '[Event "示例对局"]',
  '[Site "黑白格大师"]',
  '[Date "2024.01.01"]',
  '[White "白方"]',
  '[Black "黑方"]',
  '[Result "1/2-1/2"]',
  '',
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 (3... Nf6 4. d3 Bc5) 4. c3 Nf6 5. d3 d6 1/2-1/2'
].join('\n')

function main() {
  H.section('1. 头部与主线')

  const p = pt.parsePgn(HEADER_PGN)
  H.eq(p.ok, true, '示例 PGN 解析成功')
  H.eq(p.error, '', '成功时没有错误信息')
  H.eq(p.headers.Event, '示例对局', '解析出 Event 头')
  H.eq(p.headers.White, '白方', '解析出 White 头')
  H.eq(p.result, '1/2-1/2', '结果取自 movetext/头部')
  H.eq(p.rootFen, INITIAL_FEN, '没有 [FEN] 时根局面是标准开局')
  H.eq(p.plyCount, 13, '总手数 13（含变例）')
  H.eq(p.variationCount, 1, '识别出 1 条变例')
  H.eq(p.moves.length, 10, '主线长度 10')
  H.eq(p.moves[0].san, 'e4', '第一步 e4')
  H.eq(p.moves[0].from, 'e2', 'e4 的起点是 e2')
  H.eq(p.moves[0].to, 'e4', 'e4 的终点是 e4')
  H.eq(p.moves[0].uci, 'e2e4', 'uci 字段与 FEN+UCI 内部约定一致')

  H.section('2. 变例（圆括号 RAV）')

  // (3... Nf6 ...) 替换的是 Bc5 这一步：挂在 Bc4 节点下，作为 Bc5 的兄弟
  const bc4 = p.moves[5]
  H.eq(bc4.san, 'Bc5', '主线第 6 手是 Bc5')
  H.eq(bc4.alts.length, 1, 'Bc5 带一条变例')
  H.eq(bc4.alts[0][0].san, 'Nf6', '变例首手是 Nf6')
  H.eq(bc4.alts[0].length, 3, '变例共 3 手')

  H.section('3. 注释 / NAG / 回合号 / 老式王车易位')

  const messy = [
    '[Event "test"]',
    '',
    '1. e4 {王兵开局} e5 $1 2. Nf3 Nc6!? 3. Bb5 a6 4. Ba4 Nf6 5. 0-0 Be7 *'
  ].join('\n')
  const pm = pt.parsePgn(messy)
  H.eq(pm.ok, true, '带注释/NAG/评注符号/0-0 的 PGN 可解析')
  H.eq(pm.moves.length, 10, '主线 10 手')
  H.eq(pm.moves[8].san, 'O-O', '0-0 归一为 O-O')

  H.section('4. 非法输入')

  H.eq(pt.parsePgn('').ok, false, '空文本解析失败')
  H.eq(pt.parsePgn('   ').error, 'PGN 为空', '空白文本给出明确原因')
  const badMove = pt.parsePgn('1. e4 e5 2. Qxf7')
  H.eq(badMove.ok, false, '非法走法解析失败')
  H.ok(badMove.error.indexOf('第 3 步') !== -1, '错误信息带步数：' + badMove.error)
  H.ok(badMove.error.indexOf('Qxf7') !== -1, '错误信息带 token')
  H.eq(pt.parsePgn('1. e4 e5 (').error, '变例括号不配对（少了右括号）', '少右括号被识别')
  H.eq(pt.parsePgn('1. e4 ) e5').error, '变例括号不配对（多了右括号）', '多右括号被识别')
  H.eq(pt.parsePgn('1. e4 ()').ok, false, '空变例被拒绝')
  H.eq(pt.parsePgn('这根本不是 PGN').ok, false, '纯文字解析失败')

  H.section('5. FEN 头与兵升变')

  const fromFen = [
    '[SetUp "1"]',
    '[FEN "7k/4P3/8/8/8/8/8/4K3 w - - 0 1"]',
    '',
    '1. e8=Q+ Kh7'
  ].join('\n')
  const pf = pt.parsePgn(fromFen)
  H.eq(pf.ok, true, '带 [FEN] 的 PGN 可解析')
  H.ok(pf.rootFen.indexOf('7k/4P3') === 0, '根局面取自 [FEN] 头')
  H.eq(pf.moves[0].san, 'e8=Q+', '升变走法 SAN 正确')
  H.eq(pf.moves[0].promotion, 'q', '升变类型为后')
  H.eq(pf.moves[0].uci, 'e7e8', 'uci 不含升变后缀（与 session 内部一致）')

  const badFen = pt.parsePgn('[FEN "not a fen"]\n\n1. e4')
  H.eq(badFen.ok, false, '非法 [FEN] 被拒绝')

  H.section('6. 灌入 Session（主线 + 变例树）')

  const s = new Session()
  const loaded = s.loadPgnTree(HEADER_PGN)
  H.eq(loaded.ok, true, 'loadPgnTree 成功')
  H.eq(s.mainLine().length, 11, '主线 11 个节点（根 + 10 步）')
  H.eq(s.nodeCount(), 14, '节点总数 14（含变例 3 步）')
  H.eq(s.current().id, s.root().id, '载入后停在起始局面')
  H.eq(s.root().fen, INITIAL_FEN, '根局面是标准开局（不是预置中局）')

  const afterBc4 = s.mainLine()[5] // [0]=root, [1]=e4 … [5]=Bc4；变例挂在 Bc4 下、与 Bc5 同级
  H.eq(afterBc4.san, 'Bc4', '主线第 5 个节点是 Bc4')
  H.eq(afterBc4.children.length, 2, 'Bc4 下既有主线 Bc5，也有变例 Nf6')
  H.eq(afterBc4.children[0].san, 'Bc5', 'children[0] 是主线')
  H.eq(afterBc4.children[1].san, 'Nf6', 'children[1] 是变例')
  H.eq(s.variationsOf(afterBc4.id).length, 1, 'variationsOf 返回 1 条变例')
  H.eq(s.isMainLine(afterBc4.children[1]), false, '变例节点 isMainLine=false')
  H.eq(s.turn(afterBc4.children[1].fen), 'w', '变例首手后轮到白方')

  H.section('7. 解析失败不破坏既有会话')

  const keep = new Session(INITIAL_FEN)
  keep.applyMove('e2', 'e4')
  const keepId = keep.currentId()
  const bad = keep.loadPgnTree('1. e4 e5 2. Qxf7')
  H.eq(bad.ok, false, '非法 PGN 返回 ok=false')
  H.eq(keep.currentId(), keepId, '会话仍停在被拒绝前的位置')
  H.eq(keep.current().san, 'e4', '既有走法没有被清掉')

  const bad2 = keep.loadPgn('<html>whatever</html>')
  H.eq(bad2, false, '旧的 loadPgn 行为不变（返回 boolean）')

  H.section('8. Session 辅助能力')

  H.eq(new Session(INITIAL_FEN).nodeCount(), 1, '新建会话只有根节点')
  const checkFen = '4k3/8/8/8/8/8/4r3/4K3 w - - 0 1'
  const sc = new Session(checkFen)
  H.eq(sc.status().inCheck, true, '该局面白方被将军')
  H.eq(sc.kingSquareUnderCheck(checkFen), 'e1', '被将军的王在 e1')
  H.eq(sc.kingSquareUnderCheck(INITIAL_FEN), null, '未被将军时返回 null')

  return H.summary('pgn-tree.test.js')
}

const green = main()
process.exit(green ? 0 : 1)
