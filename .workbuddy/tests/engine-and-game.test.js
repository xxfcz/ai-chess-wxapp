/**
 * engine-and-game.test.js
 * 纯逻辑层回归：raw_* 接口一致性、规则层、终局判定、棋盘索引、引擎输出契约与超时降级。
 *
 * 不依赖 wx / DOM / Canvas，直接用 node 跑：
 *   node .workbuddy/tests/engine-and-game.test.js
 */
'use strict'

const H = require('./_harness')
const { Chess } = require('../../utils/chess.js')
const { Game, START_FEN, DEFAULT_PROMOTION } = require('../../utils/game.js')
const engine = require('../../utils/engine.js')
const boardModel = require('../../utils/board-model.js')
const geometry = require('../../utils/geometry.js')

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
// 学者将杀之后（轮黑走，黑已被将死）
const CHECKMATE_FEN = 'r1bqkbnr/pppp1Qpp/2n5/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4'
// 白 Qf7 + Kg6，黑王 h8 无子可动且未被将军
const STALEMATE_FEN = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'
// 光王对光王
const INSUFFICIENT_FEN = '8/8/8/4k3/8/8/8/4K3 w - - 0 1'
// 白车白王 对 光黑王：够将杀，不会被判 insufficient，适合测三次重复
const KR_VS_K_FEN = '8/8/8/4k3/8/8/8/R3K3 w - - 0 1'

/** 把 raw move 集合折算成 {from}{to}{promotion} 三元组串 */
function rawKeys(chess) {
  return chess.raw_moves().map(m => engine.squareOf(m.from) + engine.squareOf(m.to) + (m.promotion || ''))
}

/** 把高层 verbose move 折算成同样的三元组串 */
function verboseKeys(chess) {
  return chess.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''))
}

async function main() {
  /* ------------------------------------------------------- 1. raw 接口一致性 */
  H.section('1. raw_* 扩展与高层接口的一致性')

  // 起始局面
  const onInitial = new Chess(INITIAL_FEN)
  H.sameSet(rawKeys(onInitial), verboseKeys(onInitial), 'raw_moves 与 moves({verbose}) 走法集合一致（起始局面）')
  H.eq(rawKeys(onInitial).length, 20, '起始局面有 20 个合法走法')

  // 中局战术局面（含吃子、易位）
  const midGame = new Chess(START_FEN)
  H.sameSet(rawKeys(midGame), verboseKeys(midGame), 'raw_moves 与 moves({verbose}) 走法集合一致（中局局面）')

  // 升变局面：包含多种升变选择
  const promoChess = new Chess('8/4P3/8/8/8/8/8/4K2k w - - 0 1')
  H.sameSet(rawKeys(promoChess), verboseKeys(promoChess), 'raw_moves 与 moves({verbose}) 走法集合一致（含升变）')

  // raw_move / raw_undo 后局面必须能完整还原
  const before = midGame.fen()
  const rawList = promoChess.raw_moves()
  promoChess.raw_move(rawList[0])
  H.ok(promoChess.fen() !== '8/4P3/8/8/8/8/8/4K2k w - - 0 1', 'raw_move 之后局面发生变化')
  promoChess.raw_undo()
  H.eq(promoChess.fen(), '8/4P3/8/8/8/8/8/4K2k w - - 0 1', 'raw_undo 之后 FEN 完整还原')

  // raw_board 与高层 board 看到同样的子
  const rawBoard = midGame.raw_board()
  const highBoard = midGame.board()
  let mismatched = 0
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      // 0x88 索引的第 0 行同样是第 8 横线（a8=0，a1=112），与 board() 行序一致
      const idx = row * 16 + col
      const rawPiece = rawBoard[idx]
      const highPiece = highBoard[row][col]
      const rawSig = rawPiece ? rawPiece.color + rawPiece.type : ''
      const highSig = highPiece ? highPiece.color + highPiece.type : ''
      if (rawSig !== highSig) mismatched++
    }
  }
  H.eq(mismatched, 0, 'raw_board 与 board() 的棋子分布完全一致（第 0 行是第 8 横线）')

  H.eq(engine.squareOf(0), 'a8', 'squareOf 换算 0x88 索引 → a8')
  H.eq(engine.squareOf(112), 'a1', 'squareOf 换算 0x88 索引 → a1')

  /* ----------------------------------------------------------- 2. 规则层 */
  H.section('2. Game 规则层')

  const g = new Game(INITIAL_FEN)
  H.eq(g.getFen(), INITIAL_FEN, '载入 FEN 后 fen() 与原文一致')
  H.eq(g.getTurn(), 'w', '初始局面轮白方')
  H.eq(g.canUndo(), false, '刚载入时不能悔棋')
  H.eq(g.canRedo(), false, '刚载入时不能重做')

  H.throws(() => new Game('不是一个 FEN'), /FEN/, '载入非法 FEN 抛错')
  const badFenErr = H.throws(() => new Game('@@@'), null, '载入畸形 FEN 抛错')
  H.eq(badFenErr && badFenErr.code, 'BAD_FEN', '非法 FEN 的错误码是 BAD_FEN')

  // 缺字段自动补全：界面文案承诺了「只写棋子布局也能载入」
  const layoutOnly = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'
  const gPartial = new Game(layoutOnly)
  H.eq(gPartial.getFen(), layoutOnly + ' w - - 0 1', '只给布局段时补全为完整 FEN')
  H.eq(gPartial.history().length, 0, '补全载入后历史是空的')
  H.eq(new Game(layoutOnly + ' b').getFen(), layoutOnly + ' b - - 0 1', '给了行棋方时其余字段仍补全')
  H.eq(new Game(layoutOnly + ' w KQkq - 0 1').getFen(), layoutOnly + ' w KQkq - 0 1',
    '已满 6 段时原样载入，不被默认值覆盖')
  // 补全只在首段确实像布局时生效，否则要保持原样以免掩盖真正的错误
  const stillBad = H.throws(() => new Game('@@@ @@@'), null, '乱码仍按原样报错')
  H.eq(stillBad && stillBad.code, 'BAD_FEN', '乱码补全不及的仍是 BAD_FEN')

  // 注意：构造函数的 `fen || START_FEN` 会把空字符串静默吃掉、落到默认局面，
  // 只有直接调用 load('') 才会抛 BAD_FEN。两种行为都钉住，避免以后被"顺手修掉"。
  H.eq(new Game('').getFen(), START_FEN, '构造函数收到空串时落到默认局面（不抛错）')
  H.throws(() => new Game(INITIAL_FEN).load(''), /FEN/, 'load("") 直接调用会抛错')
  H.throws(() => new Game(INITIAL_FEN).load('   '), /FEN/, 'load 收到纯空白串会抛错')

  // validate_fen 只校验不载入：这是本项目反复踩过的坑，必须有回归
  const probeOnly = new Chess()
  const check = probeOnly.validate_fen(START_FEN)
  H.ok(check && check.valid === true, 'validate_fen 对合法 FEN 返回 valid=true')
  H.eq(probeOnly.fen(), INITIAL_FEN, 'validate_fen 之后棋盘仍是初始局面（证明它不载入）')

  // 走子
  const moved = g.tryMove('e2', 'e4')
  H.ok(moved !== null, '可以走 e2-e4')
  H.eq(g.getTurn(), 'b', '走子后轮到黑方')
  H.eq(g.history().length, 1, '历史记录了 1 步')
  H.eq(g.history()[0].san, 'e4', '历史里的 SAN 是 e4')
  H.eq(g.canUndo(), true, '走子后可以悔棋')

  // 同一个格子点两次 = 不改棋局
  H.eq(g.tryMove('e4', 'e4'), null, '起点终点相同不产生走子')

  // 空格无法作为起点
  H.eq(g.tryMove('e5', 'e6'), null, '空格作为起点返回 null')

  // 悔棋 / 重做
  g.undo()
  H.eq(g.getFen(), INITIAL_FEN, '悔棋回到初始局面')
  H.eq(g.canRedo(), true, '悔棋后可以重做')
  g.redo()
  H.eq(g.getFen(), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', '重做回到 e4 后的局面')

  // 走过的 Vacated 分支会被截断
  const g2 = new Game(INITIAL_FEN)
  g2.tryMove('e2', 'e4')
  g2.undo()
  g2.tryMove('d2', 'd4')
  H.eq(g2.canRedo(), false, '在新分支上走子会截断原来的重做分支')
  H.eq(g2.history()[0].san, 'd4', '历史里只剩新分支的一步')

  // applySan
  const g3 = new Game(INITIAL_FEN)
  H.ok(g3.applySan('e4') !== null, 'applySan("e4") 成功')
  H.eq(g3.applySan('这是一步瞎写的棋'), null, 'applySan 对非法 SAN 返回 null')
  H.eq(g3.applySan(''), null, 'applySan 对空字符串返回 null')

  // 自由模拟：拖对方的棋子要能拿到合法落点，且不能改动真实行棋方
  const g4 = new Game(INITIAL_FEN)
  const whiteTurnBefore = g4.getTurn()
  const blackTargets = g4.legalTargetsFrom('a7')
  H.ok(blackTargets.indexOf('a6') !== -1 && blackTargets.indexOf('a5') !== -1,
    '白方行棋时也能查到黑兵 a7 的合法落点（a6/a5）')
  H.eq(g4.getTurn(), whiteTurnBefore, '查询对方落点没有改动真实行棋方')
  H.ok(g4.pieceAt('a7') !== null, '查询对方落点没有改变棋盘内容')

  // pieceSquares 定位
  H.sameSet(new Game(INITIAL_FEN).pieceSquares('w', 'n'), ['b1', 'g1'], 'pieceSquares 找到白双马')
  H.sameSet(new Game(INITIAL_FEN).pieceSquares('b', 'r'), ['a8', 'h8'], 'pieceSquares 找到黑双车')

  // kingSquareUnderCheck：白王 e1 被黑后贴脸将军，但可以吃掉它，所以不是将杀
  const CHECK_NOT_MATE_FEN = '4k3/8/8/8/8/8/4q3/4K3 w - - 0 1'
  const checkGame = new Game(CHECK_NOT_MATE_FEN)
  H.eq(checkGame.kingSquareUnderCheck(), 'e1', '被将军时能定位到白王 e1')
  H.eq(new Game(INITIAL_FEN).kingSquareUnderCheck(), null, '未被将军时 kingSquareUnderCheck 返回 null')

  /* ------------------------------------------------------------- 3. 终局 */
  H.section('3. 终局判定')

  const mate = new Game(CHECKMATE_FEN)
  H.ok(mate.status().over === true, '将杀局面 over=true')
  H.eq(mate.status().reason, 'checkmate', '将杀局面 reason=checkmate')
  H.eq(mate.status().winner, 'w', '黑被将死，winner 是白方')

  const stale = new Game(STALEMATE_FEN)
  H.eq(stale.status().reason, 'stalemate', '逼和局面 reason=stalemate')
  H.eq(stale.status().winner, null, '逼和没有赢家')

  const insuf = new Game(INSUFFICIENT_FEN)
  H.eq(insuf.status().reason, 'insufficient', '光王对光王 reason=insufficient')

  // 三次重复：K+R vs K 来回摆动，同一局面出现三次
  const rep = new Game(KR_VS_K_FEN)
  const seq = ['Ra2', 'Ke6', 'Ra1', 'Ke5', 'Ra2', 'Ke6', 'Ra1', 'Ke5', 'Ra2', 'Ke6', 'Ra1', 'Ke5']
  let appliedAll = true
  for (let i = 0; i < seq.length; i++) {
    if (!rep.applySan(seq[i])) { appliedAll = false; break }
  }
  H.ok(appliedAll, '重复局面的 12 步序列全部合法')
  if (appliedAll) {
    H.eq(rep.status().reason, 'threefold', '同一局面出现三次 → threefold')
  }

  const normalGame = new Game(START_FEN)
  H.eq(normalGame.status().over, false, '普通中局 over=false')
  H.eq(normalGame.status().reason, 'normal', '普通中局 reason=normal')
  H.ok(normalGame.status().label.indexOf('白方行棋') !== -1, '普通中局 label 标注白方行棋')

  const checkStatus = new Game(CHECK_NOT_MATE_FEN)
  H.eq(checkStatus.status().over, false, '被将军但未终局时 over=false')
  H.eq(checkStatus.status().inCheck, true, '被将军时 inCheck=true')
  H.eq(checkStatus.status().label.indexOf('应将') !== -1, true, '将军时 label 提示应将')

  /* -------------------------------------------------- 4. 棋盘索引与视图数据 */
  H.section('4. 棋盘索引（AGENTS.md §6.2 镜像回归）与视图数据')

  const initialCells = boardModel.buildCells({ board: new Chess(INITIAL_FEN).board(), flipped: false })
  H.eq(initialCells.length, 64, 'buildCells 产出 64 个格子')
  H.eq(initialCells[0].sq, 'a8', '显示第 0 格是 a8')
  H.eq(initialCells[0].glyph, boardModel.GLYPHS.r, 'a8 是黑车字形')
  H.eq(initialCells[0].color, 'b', 'a8 是黑子')
  H.eq(initialCells[63].sq, 'h1', '显示第 63 格是 h1')
  H.eq(initialCells[63].glyph, boardModel.GLYPHS.r, 'h1 是白车字形')
  H.eq(initialCells[63].color, 'w', 'h1 是白子')
  H.eq(initialCells[8].glyph, boardModel.GLYPHS.p, '第 7 横线第一格是兵')
  H.eq(initialCells[8].color, 'b', '第 7 横线（a7）是黑兵')
  H.eq(initialCells[48].glyph, boardModel.GLYPHS.p, '第 2 横线第一格是兵')
  H.eq(initialCells[48].color, 'w', '第 2 横线（a2）是白兵')
  H.eq(initialCells[28].glyph, '', 'e4 是空格')

  // 非对称局面：写成 board[rank] 会整盘上下镜像，这里必须能抓出来
  const midCells = boardModel.buildCells({ board: midGame.board(), flipped: false })
  const bySq = {}
  for (let i = 0; i < midCells.length; i++) bySq[midCells[i].sq] = midCells[i]
  // START_FEN = r1b2rk1/ppp1p1pp/3b4/2qP4/8/2P2N1P/PP1B1P2/R1Q1RK2
  H.eq(bySq.a8.color, 'b', 'START_FEN 的 a8 是黑车')
  H.eq(bySq.b8.glyph, '', 'START_FEN 的 b8 是空格')
  H.eq(bySq.c8.glyph, boardModel.GLYPHS.b, 'START_FEN 的 c8 是黑象')
  H.eq(bySq.g8.glyph, boardModel.GLYPHS.k, 'START_FEN 的 g8 是黑王')
  H.eq(bySq.c1.glyph, boardModel.GLYPHS.q, 'START_FEN 的 c1 是白后')
  H.eq(bySq.a1.glyph, boardModel.GLYPHS.r, 'START_FEN 的 a1 是白车')
  H.eq(bySq.b1.glyph, '', 'START_FEN 的 b1 是空格')

  // flipped 时必须整体上下左右翻转
  const flippedFirst = boardModel.buildCells({ board: new Chess(INITIAL_FEN).board(), flipped: true })
  H.eq(flippedFirst[0].sq, 'h1', 'flipped 时第 0 格是 h1')
  H.eq(flippedFirst[0].glyph, boardModel.GLYPHS.r, 'flipped 时第 0 格仍是白车字形')

  // 高亮 / 选中标记
  const marked = boardModel.buildCells({
    board: new Chess(INITIAL_FEN).board(),
    flipped: false,
    selected: 'e2',
    legalTargets: ['e3', 'e4'],
    lastMove: { from: 'd2', to: 'd4' },
    hint: { from: 'b1', to: 'c3' },
    checkSquare: 'e1',
    focus: ['a1']
  })
  const e2 = marked.find(c => c.sq === 'e2')
  const e4 = marked.find(c => c.sq === 'e4')
  const d4 = marked.find(c => c.sq === 'd4')
  const e1 = marked.find(c => c.sq === 'e1')
  const a1 = marked.find(c => c.sq === 'a1')
  H.ok(e2.cls.indexOf('sel') !== -1, '选中格带 sel 类')
  H.eq(e4.mark, 'dot', '空格合法落点显示圆点')
  H.eq(e2.mark, '', '选中格本身不是自己的落点，不打点')
  H.ok(d4.cls.indexOf('last') !== -1, '上一手落点带 last 类')
  H.ok(e1.cls.indexOf('check') !== -1, '被将军的王带 check 类')
  H.ok(a1.cls.indexOf('focus') !== -1, '焦点格带 focus 类')
  H.ok(e2.cls.indexOf('light') !== -1 || e2.cls.indexOf('dark') !== -1, '格子始终带明暗底色类')

  // 落点上有对方棋子时为圆环（可吃子），这也是"打点不能盖掉棋子字形"的回归
  const captureTargets = boardModel.buildCells({
    board: new Chess(INITIAL_FEN).board(),
    flipped: false,
    legalTargets: ['e7']
  })
  H.eq(captureTargets.find(c => c.sq === 'e7').mark, 'ring', '有子的合法落点显示圆环')
  H.eq(captureTargets.find(c => c.sq === 'e7').glyph, boardModel.GLYPHS.p, '可吃子的格子依然画出棋子字形')

  // hiddenSquare：拖拽起点由浮层显示，格内不重复画
  const dragged = boardModel.buildCells({
    board: new Chess(INITIAL_FEN).board(),
    flipped: false,
    hiddenSquare: 'e2'
  })
  H.eq(dragged.find(c => c.sq === 'e2').glyph, '', '拖拽起点在格内不画字形')
  H.eq(dragged.find(c => c.sq === 'e2').color, 'w', '隐藏字形不影响格子的颜色信息')

  // geometry 换算自检
  H.eq(geometry.cellToSquare(0, 0, false), 'a8', 'cellToSquare(0,0) = a8')
  H.eq(geometry.cellToSquare(7, 7, false), 'h1', 'cellToSquare(7,7) = h1')
  H.eq(geometry.cellToSquare(0, 0, true), 'h1', 'flipped 时 cellToSquare(0,0) = h1')
  const cell = geometry.squareToCell('d5', false)
  H.eq(geometry.cellToSquare(cell.col, cell.row, false), 'd5', 'squareToCell / cellToSquare 互逆')

  // 棋盘尺寸
  const metrics = boardModel.boardMetrics(411)
  H.eq(metrics.boardSize, metrics.cellSize * 8, 'boardSize 一定是 cellSize 的 8 倍')
  H.ok(metrics.boardSize >= boardModel.MIN_BOARD, 'boardSize 不小于下限')
  H.ok(boardModel.boardMetrics(100000).boardSize <= boardModel.MAX_BOARD, '超大窗口也不会超过上限')

  /* ------------------------------------------------------------- 5. 引擎 */
  H.section('5. engine.analyze 输出契约')

  await H.throwsAsync(() => engine.analyze({}), /FEN/, 'analyze 缺少 FEN 时抛错')
  await H.throwsAsync(() => engine.analyze({ fen: '瞎写的' }), /FEN/, 'analyze 收到非法 FEN 时抛错')

  const res = await engine.analyze({ fen: START_FEN, depth: 3, multiPV: 3 })
  H.eq(res.engine, engine.ENGINE_NAME, '结果带引擎名')
  H.eq(res.sideToMove, 'w', 'sideToMove 与局面一致')
  H.ok(res.depth >= 1, '至少完成 1 层搜索')
  H.ok(res.lines.length === 3, 'multiPV=3 时返回 3 条路线')
  H.ok(typeof res.nodes === 'number' && res.nodes > 0, 'nodes 是正整数')
  H.ok(typeof res.elapsedMs === 'number' && res.elapsedMs >= 0, 'elapsedMs 是非负整数')
  H.eq(res.terminal, null, '非终局时 terminal 为 null')

  // 契约字段逐个核对
  const line = res.lines[0]
  H.eq(line.rank, 1, '第一条路线 rank=1')
  H.ok(typeof line.uci === 'string' && line.uci.length >= 4, 'uci 是合法的 UCI 串')
  H.ok(typeof line.san === 'string' && line.san.length > 0, 'san 非空')
  H.ok(/^[a-h][1-8]$/.test(line.from), 'from 是棋格名')
  H.ok(/^[a-h][1-8]$/.test(line.to), 'to 是棋格名')
  H.ok(line.scoreCp === null || typeof line.scoreCp === 'number', 'scoreCp 是数字或 null')
  H.ok(line.scoreMate === null || typeof line.scoreMate === 'number', 'scoreMate 是数字或 null')
  H.ok(line.scoreCp !== null || line.scoreMate !== null, 'cp 与 mate 至少有一个有值')
  H.ok(Array.isArray(line.pv) && line.pv.length >= 1, 'pv 至少包含首选走法')
  H.ok(Array.isArray(line.pvSan) && line.pvSan.length === line.pv.length, 'pvSan 与 pv 等长')
  H.eq(line.pvSan[0], line.san, 'pvSan 的第一手就是该线的 san')
  H.ok(res.lines[1].rank === 2 && res.lines[2].rank === 3, 'rank 连续递增')

  // 分数降序：行棋方视角下 rank 1 应当是分数最高的
  const cpValue = l => (l.scoreMate !== null && l.scoreMate !== undefined)
    ? (l.scoreMate > 0 ? 1e6 : -1e6)
    : l.scoreCp
  H.ok(cpValue(res.lines[0]) >= cpValue(res.lines[1]) || line.scoreMate !== null,
    '路线按行棋方视角分数降序排列')

  // 引擎给出的走法必须真的合法：用 Game 重放一遍
  const replay = new Game(START_FEN)
  H.ok(replay.applySan(line.san) !== null, '引擎首选走法能通过 Game 的合法性校验')

  const pvReplay = new Game(START_FEN)
  let pvAllLegal = true
  for (let i = 0; i < line.pvSan.length; i++) {
    if (!pvReplay.applySan(line.pvSan[i])) { pvAllLegal = false; break }
  }
  H.ok(pvAllLegal, '整条 PV 逐手回放全部合法')

  // multiPV 限制
  const single = await engine.analyze({ fen: START_FEN, depth: 2, multiPV: 1 })
  H.eq(single.lines.length, 1, 'multiPV=1 时只返回 1 条路线')

  // depth 钳制（引擎硬上限 5）
  const deep = await engine.analyze({ fen: START_FEN, depth: 99, multiPV: 1, maxTimeMs: 600 })
  H.ok(deep.depth <= 5, '请求的超深深度被钳制到引擎上限 5 以内')
  H.ok(deep.depth >= 1, '钳制后仍然完成了至少 1 层')

  // 终局直接返回，不进搜索
  const mateRes = await engine.analyze({ fen: CHECKMATE_FEN, depth: 3 })
  H.ok(mateRes.terminal !== null, '终局局面返回 terminal')
  H.eq(mateRes.terminal.reason, 'checkmate', 'terminal.reason=checkmate')
  H.eq(mateRes.terminal.winner, 'w', 'terminal.winner=w')
  H.eq(mateRes.lines.length, 0, '终局不返回任何路线')
  H.eq(mateRes.depth, 0, '终局时 depth=0')
  H.eq(mateRes.nodes, 0, '终局时 nodes=0')

  const insufRes = await engine.analyze({ fen: INSUFFICIENT_FEN, depth: 3 })
  H.eq(insufRes.terminal.reason, 'insufficient', '子力不足局面直接返回 terminal')

  // onProgress 必须被回调，且带 depth/nodes/reached
  const progress = []
  await engine.analyze({
    fen: START_FEN, depth: 3, multiPV: 3,
    onProgress: info => progress.push(info)
  })
  H.ok(progress.length >= 1, 'onProgress 至少被调用一次')
  H.ok(progress.every(p => typeof p.depth === 'number'), '每次进度回调都带 depth')
  H.ok(progress.every(p => typeof p.nodes === 'number'), '每次进度回调都带 nodes')
  H.eq(progress[progress.length - 1].depth, 3, '最后一次进度回调的 depth 与请求深度一致')

  /* --------------------------------------------------- 6. 超时降级 */
  H.section('6. 引擎超时降级')

  // 给极小的时间预算，看它是否仍能给出结构完整的可用结果
  const tightStart = Date.now()
  const tight = await engine.analyze({ fen: INITIAL_FEN, depth: 5, multiPV: 3, maxTimeMs: 300 })
  const tightMs = Date.now() - tightStart
  H.ok(tight.lines.length === 3, '极小时间预算下依然返回 3 条路线')
  H.ok(tight.depth >= 1, '极小时间预算下至少完成 1 层')
  H.ok(tightMs < 8000, `极小时间预算下总耗时受控（实测 ${tightMs}ms）`)
  H.ok(tight.lines.every(l => typeof l.san === 'string' && l.san.length > 0), '降级结果里每条路线都有 san')

  const tightReplay = new Game(INITIAL_FEN)
  let tightLegal = true
  for (let i = 0; i < tight.lines.length; i++) {
    const probe = new Game(INITIAL_FEN)
    if (!probe.applySan(tight.lines[i].san)) tightLegal = false
  }
  H.ok(tightLegal, '降级结果里的所有路线都合法')

  // maxTimeMs 也要被钳制在下限之上
  const clamped = await engine.analyze({ fen: START_FEN, depth: 1, multiPV: 1, maxTimeMs: 1 })
  H.ok(clamped.lines.length >= 1, 'maxTimeMs 被钳制到下限后仍给出结果')

  // toScore 换算：mate 分支
  const mated = engine.toScore(99000)
  H.ok(mated.scoreCp === null && mated.scoreMate > 0, '接近极值的正分换算成正的 mate 数')
  const losing = engine.toScore(-99000)
  H.ok(losing.scoreCp === null && losing.scoreMate < 0, '接近极值的负分换算成负的 mate 数')
  const normal = engine.toScore(137)
  H.eq(normal.scoreCp, 137, '普通分数按厘兵取整')
  H.eq(normal.scoreMate, null, '普通分数不带 mate')

  // describeTerminal
  H.eq(engine.describeTerminal(new Chess(INITIAL_FEN)), null, '起始局面 describeTerminal 返回 null')
  H.eq(engine.describeTerminal(new Chess(CHECKMATE_FEN)).reason, 'checkmate', 'describeTerminal 识别将杀')
  H.eq(engine.describeTerminal(new Chess(STALEMATE_FEN)).reason, 'stalemate', 'describeTerminal 识别逼和')

  return H.summary('engine-and-game.test.js')
}

main().then(green => {
  if (!green) process.exit(1)
}).catch(err => {
  console.error('\n测试脚本自身异常：', err)
  process.exit(1)
})
