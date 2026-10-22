/**
 * session.test.js
 * L0 走子树（utils/session.js）单测：树操作、导航、分支、节点级缓存、PGN 边界、序列化。
 *
 * 纯 Node 跑：node .workbuddy/tests/session.test.js
 */
'use strict'

const H = require('./_harness')
const { Session, normalizeFenFields, START_FEN } = require('../../utils/session')

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function main() {
  H.section('1. 初始化与基本规则层')

  const s = new Session(INITIAL_FEN)
  H.eq(s.current().fen, INITIAL_FEN, '根局面等于构造时传入的 FEN')
  H.eq(s.currentId(), s.root().id, '当前节点即根')
  H.eq(s.pathToCurrent().length, 1, '初始路径只有根')
  H.eq(s.turn(), 'w', '初始行棋方为白')
  H.eq(typeof s.board(), 'object', 'board() 返回棋盘数组')
  H.eq(s.status().label, '白方行棋', '初始状态标签')
  H.ok(Array.isArray(s.legalMoves()) && s.legalMoves().length === 20, '开局有 20 种合法走法')

  H.section('2. 走子建立主线')

  const e4 = s.applyMove('e2', 'e4')
  H.eq(s.current().san, 'e4', '第一步记为 e4')
  H.eq(s.current().uci, 'e2e4', '节点 uci 为 e2e4')
  H.eq(s.current().parentId, s.root().id, '父节点是根')
  H.eq(s.pathToCurrent().length, 2, '路径变长 2')
  H.eq(s.mainLine().length, 2, '主线长度 2')

  // 同一步重复走 → 命中已有节点，不新建
  s.gotoRoot()
  const e4again = s.applyMove('e2', 'e4')
  H.eq(e4again.id, e4.id, '再次走同一 UCI 命中同一节点')
  H.eq(s.current().children.length, 0, '仍没有子节点（未重复建）')

  H.section('3. 分支（variations）')

  s.gotoRoot()
  s.applyMove('e2', 'e4')
  s.applyMove('e7', 'e5')
  const mainMid = s.current() // e5 节点，此时还没有子节点
  // 先在主线下走一步形成主线子节点，再开分支才有「children[1]」
  s.applyMove('g1', 'f3')
  H.eq(s.isMainLine(s.current()), true, 'g1f3 成为 mainMid 的主线子节点')
  s.goto(mainMid.id)
  const branch = s.addVariation(mainMid.id, 'c2', 'c4')
  H.ok(branch && branch.id !== mainMid.id, 'addVariation 在主线下新增分支节点')
  H.eq(s.variationsOf(mainMid.id).length, 1, 'mainMid 多了一条分支')
  H.eq(s.isMainLine(mainMid), true, '主线节点 isMainLine = true')
  H.eq(s.isMainLine(branch), false, '分支节点 isMainLine = false')

  // 删除分支
  H.eq(s.deleteVariation(branch.id), true, '可以删除分支')
  H.eq(s.variationsOf(mainMid.id).length, 0, '分支已删除')
  H.eq(s.deleteVariation(mainMid.id), false, '不能删除主线')

  H.section('4. 提升分支为变例')

  s.goto(mainMid.id)
  const v = s.addVariation(mainMid.id, 'c2', 'c4')
  s.addVariation(mainMid.id, 'g1', 'f3')
  H.eq(s.promoteVariation(v.id), true, '提升分支成功')
  H.eq(s.get(mainMid.id).children[0].id, v.id, 'v 成为父节点的 children[0]（主线）')

  H.section('5. 导航')

  s.gotoRoot()
  s.applyMove('e2', 'e4')
  s.applyMove('e7', 'e5')
  s.applyMove('g1', 'f3')
  const leaf = s.current()
  H.eq(s.pathToCurrent().length, 4, '主线 4 个节点')
  s.stepBack()
  H.eq(s.current().san, 'e5', 'stepBack 回到 e5')
  s.gotoRoot()
  H.eq(s.stepForward().san, 'e4', 'stepForward 进入主线第一步')
  H.eq(s.goto(leaf.id).san, 'Nf3', 'goto 跳到叶子')

  H.section('6. 节点级缓存')

  s.gotoRoot()
  s.applyMove('e2', 'e4')
  const node = s.current()
  const fakeAnalysis = { lines: [{ rank: 1, san: 'e5' }], depth: 4 }
  H.eq(s.cacheAnalysis(node.id, fakeAnalysis), true, '写入分析缓存')
  H.eq(s.getAnalysis(node.id), fakeAnalysis, '读回分析缓存')
  H.eq(s.getAnalysisForFen(node.fen), fakeAnalysis, '按 FEN 也能命中缓存')
  const coach = { prose: '好棋' }
  H.eq(s.cacheCoach(node.id, coach), true, '写入点评缓存')
  H.eq(s.getCoach(node.id).prose, '好棋', '读回点评缓存')

  H.section('7. PGN 边界转换（内部一律 FEN+UCI）')

  const testPgn = [
    '[Event "test"]',
    '[FEN "' + INITIAL_FEN + '"]',
    '',
    '1. e4 e5 2. Nf3 Nc6'
  ].join('\n')
  const s2 = new Session(START_FEN)
  H.eq(s2.loadPgn(testPgn), true, '载入合法 PGN 成功')
  H.eq(s2.mainLine().length, 5, '主线 5 个节点（根 + 4 步）')
  H.eq(s2.mainLine()[4].san, 'Nc6', '最后一步是 Nc6')
  const outPgn = s2.toPgn()
  H.ok(typeof outPgn === 'string' && outPgn.indexOf('e4') !== -1, '导出 PGN 含首步')
  H.ok(outPgn.indexOf('Nc6') !== -1, '导出 PGN 含末步')

  // 非法 PGN 不破坏会话
  const s3 = new Session(INITIAL_FEN)
  H.eq(s3.loadPgn('这根本不是 PGN @@'), false, '非法 PGN 返回 false')

  // 空 PGN
  H.eq(new Session(START_FEN).loadPgn('   '), false, '空白 PGN 返回 false')

  H.section('8. FEN 规整与序列化')

  H.eq(normalizeFenFields('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'),
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1', '只写布局能补全尾部字段（缺省无王车易位）')
  H.eq(normalizeFenFields(INITIAL_FEN), INITIAL_FEN, '已满 6 段原样返回')

  const s4 = new Session(INITIAL_FEN)
  s4.applyMove('e2', 'e4')
  s4.applyMove('e7', 'e5')
  const snap = s4.serialize()
  H.ok(Array.isArray(snap.nodes) && snap.nodes.length === 3, '序列化得到 3 个节点')
  const s5 = new Session(START_FEN)
  H.eq(s5.restore(snap), true, '从快照恢复成功')
  H.eq(s5.mainLine().length, 3, '恢复后主线长度一致')
  H.eq(s5.current().san, 'e5', '恢复后当前节点正确')

  return H.summary('session.test.js')
}

const green = main()
process.exit(green ? 0 : 1)
