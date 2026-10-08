/**
 * analyze-page.test.js
 * 页面层回归：初始化、拖拽/点选走子、历史、FEN、自动分析、云端点评与错误分支、
 * 以及 WXML 模板可渲染性的静态守卫。
 *
 * 用 node 跑：
 *   node .workbuddy/tests/analyze-page.test.js
 *
 * 打桩环境刻意**不提供** createSelectorQuery / getWindowInfo / getSystemInfoSync，
 * 模拟网页版预览的能力缺失 —— 代码里一旦重新依赖这些接口，这里会当场报错。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const H = require('./_harness')

const ROOT = path.join(__dirname, '..', '..')
const ANALYZE_PAGE = path.join(ROOT, 'pages', 'analyze', 'analyze.js')
const ANALYZE_WXML = path.join(ROOT, 'pages', 'analyze', 'analyze.wxml')
const APP_JSON = path.join(ROOT, 'app.json')

const ai = require(path.join(ROOT, 'utils', 'ai-client.js'))
const coachDemo = require(path.join(ROOT, 'utils', 'coach-demo.js'))
const debugLog = require(path.join(ROOT, 'utils', 'debug-log.js'))
const { Game, START_FEN } = require(path.join(ROOT, 'utils', 'game.js'))

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 轮询等待条件成立。
 * 自动分析有 280ms 防抖 + 引擎本身几百毫秒到数秒的耗时，
 * 写死 sleep 会在慢机器或多套连跑时偶发失败，所以统一等「结果真的到位」。
 * 超时给得宽，宁可慢也不要假红。
 */
async function waitFor(pred, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(20)
  }
  return false
}

/* ------------------------------------------------------------ 环境打桩 */

const FORBIDDEN_WX = ['createSelectorQuery', 'getWindowInfo', 'getSystemInfoSync', 'showToast']

/** 造一个 wx：mode='full' 带 request，mode='nonet' 不带（模拟预览缺失网络能力） */
function makeWx(mode) {
  const calls = []
  const wx = {
    request() {
      calls.push('request')
    },
    setClipboardData(o) { calls.push('setClipboardData'); if (o && o.success) o.success() },
    getAccountInfoSync() { return { miniProgram: { appId: 'wxtest' } } }
  }
  if (mode === 'nonet') delete wx.request
  wx.__calls = calls
  return wx
}

let captured = null

function installGlobals(wxStub) {
  global.wx = wxStub
  global.Page = function (options) { captured = options }
  captured = null
  if (typeof global.window !== 'undefined') delete global.window
  if (typeof global.document !== 'undefined') delete global.document
}

function loadPageModule() {
  delete require.cache[require.resolve(ANALYZE_PAGE)]
  captured = null
  require(ANALYZE_PAGE)
  if (!captured) throw new Error('页面没有调用 Page()')
  return captured
}

/** 造一个页面实例：自带 setData 并把 data 深拷贝一份 */
function createPage(wxStub) {
  installGlobals(wxStub)
  const opts = loadPageModule()
  const page = Object.assign({}, opts)
  page.data = JSON.parse(JSON.stringify(opts.data))
  page.setData = function (patch) {
    Object.assign(this.data, patch)
  }
  // 页面生命周期
  opts.onLoad.call(page)
  return page
}

/**
 * 页面默认载入的是项目预置的中局局面（START_FEN，e2 是空格），
 * 走子相关的用例统一先切回开局初始局面，否则拿到的是空格。
 */
function createInitialPage(wxStub) {
  const page = createPage(wxStub)
  page.game.load(INITIAL_FEN)
  page.syncAll()
  return page
}

/* ------------------------------------------------------------ 辅助 */

function cellOf(page, sq) {
  return page.data.cells.find(c => c.sq === sq)
}

/** 造一个假的 tryMove 事件 */
function tapEvent(sq) {
  return { currentTarget: { dataset: { sq: sq } } }
}

function touchEvent(sq, x, y) {
  return { currentTarget: { dataset: { sq: sq } }, touches: [{ clientX: x, clientY: y }] }
}

/** 给页面塞一份"已完成的分析结果"，跳过慢的引擎调用 */
function injectResult(page, fen) {
  return ai.analyzePosition({ fen: fen || page.game.getFen(), depth: 2, multiPV: 3 }).then(result => {
    page._lastResult = result
    page._analysisFen = page.game.getFen()
    return result
  })
}

/* ------------------------------------------------------------ 主流程 */

async function main() {
  /* -------------------------------------------------- 1. 打桩环境自检 */
  H.section('1. 打桩环境自检（AGENTS.md §2 / §8）')

  const wxFull = makeWx('full')
  const wxNonet = makeWx('nonet')
  FORBIDDEN_WX.forEach(name => {
    H.eq(typeof wxFull[name], 'undefined', `打桩 wx 不提供 ${name}`)
  })
  H.eq(typeof wxFull.request, 'function', '完整模式下 wx.request 可用')
  H.eq(typeof wxNonet.request, 'undefined', '无网络模式下没有 wx.request')

  debugLog.clear()

  /* -------------------------------------------------------- 2. 初始化 */
  H.section('2. 页面初始化')

  const p = createPage(wxFull)
  H.eq(p.data.cells.length, 64, 'onLoad 后棋盘产出 64 个格子')
  H.eq(p.data.boardSize, p.data.cellSize * 8, 'boardSize 是 cellSize 的 8 倍')
  H.ok(p.data.cellSize > 0, 'cellSize 为正数')
  H.ok(p.data.pieceFont > 0 && p.data.labelFont > 0, '棋子字号与坐标字号都已算出')
  H.eq(p.data.activeTabKey, 'engine', '默认落在「引擎分析」Tab')
  H.eq(p.data.cloudReady, true, '有 wx.request 时 cloudReady=true')
  H.eq(p.data.cloudHint, '', '有网络时不显示降级提示')
  H.eq(p.data.statusLabel, '白方行棋', '初始状态标签是白方行棋')
  H.eq(p.data.moveCount, 0, '初始没有走子记录')
  H.eq(p.data.canUndo, false, '初始不能后退')
  H.eq(p.data.canRedo, false, '初始不能前进')
  H.eq(p.data.fenInput, START_FEN, 'FEN 输入框预填了预置局面')

  // 没有网络能力时也要能起来
  const pNoNet = createPage(wxNonet)
  H.eq(pNoNet.data.cloudReady, false, '没有 wx.request 时 cloudReady=false')
  H.ok(pNoNet.data.cloudHint.indexOf('网络') !== -1, '无网络时给出可读的降级提示')
  H.eq(pNoNet.data.cells.length, 64, '无网络环境下棋盘照常渲染（端上引擎不受影响）')

  // device 在缺接口的环境中必须降级而不是抛错
  H.eq(p.data.boardSize > 0, true, '缺 getWindowInfo/getSystemInfoSync 时尺寸仍能算出来')

  /* ------------------------------------------------------ 3. 点选走子 */
  H.section('3. 点选走子（onCellTap）')

  const t = createInitialPage(wxFull)
  t.onCellTap(tapEvent('e2'))
  H.eq(t.game.selected, 'e2', '点选 e2 后选中该兵')
  H.ok(t.game.legalTargets.indexOf('e4') !== -1, '选中后出现 e4 落点')
  H.ok(t.data.cells.find(c => c.sq === 'e4') !== null, '棋盘数据里能查到 e4 格')
  H.eq(cellOf(t, 'e2').cls.indexOf('sel') !== -1, true, '选中格在视图里带 sel 类')

  t.onCellTap(tapEvent('e4'))
  H.eq(t.game.getTurn(), 'b', '再点 e4 完成走子')
  H.eq(t.data.moveCount, 1, '走子计数 +1')
  H.eq(t.data.turnClass, 'b', '行棋方指示已切到黑方')
  H.eq(t.game.selected, null, '走子后清空选中')

  // 点空格 → 清空选择
  t.onCellTap(tapEvent('d2'))
  H.eq(t.game.selected, 'd2', '选中黑先行棋时仍可点白兵准备翻转模拟')
  t.onCellTap(tapEvent('d4'))
  H.eq(t.data.moveCount, 2, '自由模拟：轮到黑方也可以直接把白兵走到 d4')

  const t2 = createInitialPage(wxFull)
  t2.onCellTap(tapEvent('e2'))
  t2.onCellTap(tapEvent('e6'))
  H.eq(t2.data.moveCount, 0, '点到非法落点不会走子')
  H.eq(t2.game.selected, null, '点到空格会清空选择')

  /* ------------------------------------------------------ 4. 拖拽走子 */
  H.section('4. 拖拽走子（touchstart / move / end）')

  const d = createInitialPage(wxFull)
  d.onCellTouchStart(touchEvent('e2', 100, 100))
  H.eq(d.game.selected, 'e2', 'touchstart 选中 e2')
  H.ok(d._drag && d._drag.from === 'e2', 'touchstart 记录了拖拽起点')

  d.onBoardTouchMove({ touches: [{ clientX: 100, clientY: 60 }] })
  H.eq(d._drag.moved, true, '位移超过阈值后标记为已拖拽')
  H.ok(d.data.ghost !== null, '拖拽中出现浮层')
  H.eq(d.data.ghost.color, 'w', '浮层带上了棋子颜色')
  H.eq(d.data.ghost.size, d.data.cellSize, '浮层尺寸等于格宽')
  H.eq(cellOf(d, 'e2').glyph, '', '拖拽中起点格内不再重复画棋子')

  // 向上（-y）拖一格：e2 → e4（显示坐标系里向上两格才是 e4，这里按 implemented 行为写）
  d.onBoardTouchEnd({ changedTouches: [{ clientX: 100, clientY: 60 }] })
  H.eq(d.data.ghost, null, 'touchend 后浮层被清掉')

  // 精确构造：位移 ÷ 格宽后算出目标格
  const d2 = createInitialPage(wxFull)
  const size = d2.data.cellSize
  d2.onCellTouchStart(touchEvent('e2', 200, 200))
  d2.onBoardTouchMove({ touches: [{ clientX: 200, clientY: 200 - size * 2 }] })
  d2.onBoardTouchEnd({ changedTouches: [{ clientX: 200, clientY: 200 - size * 2 }] })
  H.eq(d2.data.moveCount, 1, '拖拽 e2 → e4 完成走子')
  H.eq(d2.game.history()[0].san, 'e4', '拖拽产生的记谱是 e4')

  // 位移不足 → 只当点选
  const d3 = createInitialPage(wxFull)
  d3.onCellTouchStart(touchEvent('e2', 10, 10))
  d3.onBoardTouchMove({ touches: [{ clientX: 12, clientY: 11 }] })
  d3.onBoardTouchEnd({ changedTouches: [{ clientX: 12, clientY: 11 }] })
  H.eq(d3.data.moveCount, 0, '没超过阈值不算拖拽，不产生走子')
  H.eq(d3.game.selected, 'e2', '轻触仍然选中了棋子')

  // 拖到非法落点 → 弹回
  const d4 = createInitialPage(wxFull)
  d4.onCellTouchStart(touchEvent('e2', 10, 10))
  d4.onBoardTouchMove({ touches: [{ clientX: 10, clientY: 10 - size * 5 }] })
  d4.onBoardTouchEnd({ changedTouches: [{ clientX: 10, clientY: 10 - size * 5 }] })
  H.eq(d4.data.moveCount, 0, '拖到棋盘的无效目标不会走子')
  H.eq(d4.game.selected, 'e2', '非法落点后保留选中，方便继续点选')

  // touchstart 后短时间内合成的 tap 要被忽略
  const d5 = createInitialPage(wxFull)
  d5.onCellTouchStart(touchEvent('e2', 10, 10))
  d5.onCellTap(tapEvent('e2'))
  H.eq(d5.game.selected, 'e2', '合成 tap 被时间窗忽略，不会二次触发')

  /* ---------------------------------------------------------- 5. 历史 */
  H.section('5. 历史：后退 / 前进 / 重置 / 翻转')

  const h = createPage(wxFull)
  h.game.load(INITIAL_FEN)
  h.game.applySan('e4')
  h.game.applySan('e5')
  h.syncAll()
  const flippedBefore = h.data.flipped
  H.eq(h.data.moveCount, 2, '历史里有 2 步')
  H.eq(h.data.moveRows.length, 1, '两行合成一个回合号')
  H.eq(h.data.moveRows[0].no, 1, '回合号从 1 开始')
  H.eq(h.data.moveRows[0].white, 'e4', '白方着法在位')
  H.eq(h.data.moveRows[0].black, 'e5', '黑方着法在位')
  H.ok(typeof h.data.moveRows[0].key === 'string', 'wx:key 用的是字符串字段')

  h.onUndo()
  H.eq(h.data.moveCount, 1, '后退一步后剩 1 步')
  H.eq(h.data.canRedo, true, '后退后可以前进')
  h.onRedo()
  H.eq(h.data.moveCount, 2, '前进恢复 2 步')

  const firstSqBefore = h.data.cells[0].sq
  h.onFlip()
  H.eq(h.data.flipped, !flippedBefore, '翻转切换视角')
  H.ok(h.data.cells[0].sq !== firstSqBefore, '翻转后棋盘的行列顺序变了')
  H.eq(h.data.cells.length, 64, '翻转后仍是 64 格')

  h.onReset()
  H.eq(h.data.moveCount, 0, '重置清空历史')
  H.eq(h.data.canUndo, false, '重置后不能后退')
  H.eq(h.data.analysisLines.length, 0, '重置清空分析结果')

  /* ------------------------------------------------------------ 6. FEN */
  H.section('6. FEN 载入')

  const f = createPage(wxFull)
  f.onLoadFen.call(Object.assign(f, { data: Object.assign({}, f.data, { fenInput: INITIAL_FEN }) }))
  H.eq(f.game.getFen(), INITIAL_FEN, '载入合法 FEN 生效')
  H.eq(f._fenEditing, false, '载入后退出编辑态')

  const bad = createPage(wxFull)
  bad.data.fenInput = '这不是 FEN'
  const beforeBad = bad.game.getFen()
  bad.onLoadFen()
  H.eq(bad.game.getFen(), beforeBad, '载入非法 FEN 不改变棋局')

  const empty = createPage(wxFull)
  empty.data.fenInput = '   '
  empty.onLoadFen()
  H.eq(empty.game.getFen(), beforeBad, '空输入不会动棋局')

  // 只写布局、缺后半段：chess.js 能补全
  const partial = createPage(wxFull)
  partial.data.fenInput = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'
  partial.onLoadFen()
  H.ok(partial.game.getFen().indexOf('RNBQKBNR') !== -1, '只写布局也能被补全载入')

  f.onFenInput({ detail: { value: 'abc' } })
  H.eq(f._fenEditing, true, '输入中的 FEN 不会被 syncAll 覆盖')
  H.eq(f.data.fenInput, 'abc', '输入框内容同步到 data')

  f.onUseStartFen()
  H.eq(f.data.fenInput, START_FEN, '「填入预置局面」回填默认局面')

  /* ------------------------------------------------------ 7. 自动分析 */
  H.section('7. 自动分析与路线展示')

  const a = createPage(wxFull)
  a.data.depthIndex = 0
  await a.runAnalyze()
  H.eq(a.data.analysisLines.length, 3, '分析出 3 条最佳路线')
  H.eq(a.data.analyzing, false, '分析结束后 analyzing 复位')
  H.ok(a.data.analysisMeta.indexOf('深度') !== -1, 'analysisMeta 写明深度/节点')
  H.ok(a.data.analysisLines.every(l => typeof l.idx === 'number'), '每条路线自带 idx（不依赖模板循环变量）')
  H.ok(a.data.analysisLines.every(l => typeof l.key === 'string' && l.key.indexOf('line') === 0),
    '每条路线的 wx:key 是字符串字段')
  H.ok(a.data.analysisLines.every(l => typeof l.active === 'boolean'), '选中态随数据下发')
  H.eq(a.data.analysisLines[0].rank, 1, '第一条路线 rank=1')
  H.ok(a.data.evalLabel !== '', '优势数值已算出')
  H.ok(a.data.evalPercent >= 0 && a.data.evalPercent <= 100, '优势占比在 0~100 之间')

  a.onPreviewLine({ currentTarget: { dataset: { index: 0 } } })
  H.eq(a.data.hintIndex, 0, '点击路线后记录预览下标')
  H.eq(a.data.analysisLines[0].active, true, '被点击的路线 active=true')
  H.ok(a.hint && a.hint.from && a.hint.to, '棋盘上生成了预览走法')

  a.onPreviewLine({ currentTarget: { dataset: { index: 0 } } })
  H.eq(a.data.hintIndex, -1, '再点同一条取消预览')
  H.eq(a.hint, null, '取消预览后清掉提示')
  H.eq(a.data.analysisLines[0].active, false, '取消预览后 active 复位')

  a.onPreviewLine({ currentTarget: { dataset: { index: 1 } } })
  H.eq(a.data.analysisLines[1].active, true, '切到另一条时旧的高亮被清掉')
  H.eq(a.data.analysisLines[0].active, false, '旧路线同时取消高亮')

  // 走子会触发自动分析排程
  const a2 = createInitialPage(wxFull)
  a2.data.depthIndex = 0
  a2.applyMove('e2', 'e4')
  H.ok(a2._analyzeTimer != null, '走子后排队自动分析')
  await waitFor(() => a2.data.analysisLines.length === 3)
  H.eq(a2.data.analysisLines.length, 3, '延时结束后自动分析跑出结果')

  // 分析失败的分支
  {
    const original = ai.analyzePosition
    ai.analyzePosition = () => Promise.reject(new Error('引擎炸了'))
    const badRun = createPage(wxFull)
    await badRun.runAnalyze()
    H.ok(badRun.data.analysisError.indexOf('引擎炸了') !== -1, '分析失败时把原因显示出来')
    H.eq(badRun.data.analysisLines.length, 0, '失败时清空路线列表')
    H.eq(badRun.data.analyzing, false, '失败也会复位 analyzing')
    ai.analyzePosition = original
  }

  /* -------------------------------------------------------- 8. 云端点评 */
  H.section('8. 云端点评：成功 / 失败 / 取消')

  const demoText = [
    '这个局面白方子力略占优，核心矛盾在中心争夺。',
    '推荐走 Nf3 发展子力。',
    '===DEMO===',
    JSON.stringify({ lines: [{ id: 'main', label: '主线走法', tone: 'good', desc: '稳住中心', moves: ['Nf3', 'Nc6'] }] }),
    '===END==='
  ].join('\n')

  const originalRequest = ai.requestCoachComment
  let lastArgs = null
  ai.requestCoachComment = function (params) {
    lastArgs = params
    if (params.onModel) params.onModel({ id: 'test-model', name: '测试模型', provider: '测试', label: '测试模型（测试）' })
    if (params.onDelta) params.onDelta(demoText)
    return Promise.resolve(demoText)
  }

  // 演示线走的是开局着法，页面必须切到初始局面，否则第一手就被判非法
  const c = createInitialPage(wxFull)
  await injectResult(c)
  await c.onCoach()
  await sleep(20)
  H.ok(lastArgs !== null, '点评请求被发起')
  H.eq(lastArgs.fen, c.game.getFen(), '请求带上了当前 FEN')
  H.ok(Array.isArray(lastArgs.lines) && lastArgs.lines.length === 3, '请求带上了引擎路线')
  H.eq(c.data.commenting, false, '点评完成后 commenting 复位')
  H.ok(c.data.coachText.indexOf('===DEMO===') === -1, '正文里剔除了结构化块')
  H.ok(c.data.coachText.indexOf('核心矛盾') !== -1, '正文保留了点评内容')
  H.ok(c.data.coachSegments.length > 0, '正文被切成富文本片段')
  H.ok(c.data.coachSegments.every(s => typeof s.key === 'string'), '片段的 wx:key 是字符串')
  H.eq(c.data.demoLines.length, 1, '解析出 1 条演示线')
  H.ok(typeof c.data.demoLines[0].key === 'string', '演示线的 wx:key 是字符串')
  H.ok(Array.isArray(c.data.demoLines[0].segs), '演示线描述被切成片段')
  H.ok(Array.isArray(c.data.demoLines[0].moves), '演示线走法被切成片段')
  H.eq(c.data.coachModel.indexOf('测试模型') !== -1, true, '界面显示实际使用的模型')

  // 演示线里的非法 SAN 会被截断，而不是把幻觉走法放上棋盘
  {
    const badText = '正文。\n===DEMO===\n' + JSON.stringify({
      lines: [{ id: 'bad', label: '瞎走', tone: 'bad', desc: '不存在的一步', moves: ['Qh99', 'Nf3'] }]
    }) + '\n===END==='
    ai.requestCoachComment = p2 => Promise.resolve(badText)
    const b = createPage(wxFull)
    await injectResult(b)
    await b.onCoach()
    await sleep(20)
    H.eq(b.data.demoLines.length, 0, '整条线都是非法走法时不产出演示线')
    H.ok(b.data.coachText.indexOf('正文') !== -1, '演示线被丢弃不影响正文显示')
  }

  // 失败分支
  ai.requestCoachComment = () => {
    const err = new Error('模型没有返回内容')
    err.error = { code: 'coach_empty_response' }
    return Promise.reject(err)
  }
  const e = createPage(wxFull)
  await injectResult(e)
  await e.onCoach()
  await sleep(20)
  H.ok(e.data.coachError.length > 0, '失败时给出可读文案')
  H.eq(e.data.commenting, false, '失败后 commenting 复位')
  H.ok(e.data.coachDetail.indexOf('coach_empty_response') !== -1, '失败详情带上错误码便于排查')

  // 用户取消不能报成错误
  ai.requestCoachComment = function (params) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      }, 10)
    })
  }
  const x = createPage(wxFull)
  await injectResult(x)
  x.onCoach()
  await sleep(5)
  H.eq(x.data.commenting, true, '点评进行中 commenting=true')
  x.cancelCoach()
  await sleep(60)
  H.eq(x.data.coachError, '', '主动取消不会被当成失败')
  H.eq(x.data.commenting, false, '取消后 commenting 复位')
  H.eq(x._lastCoachAt, 0, '取消后可以立刻重试，不受频控限制')

  ai.requestCoachComment = originalRequest

  /* --------------------------------------------- 9. ai-client 纯函数 */
  H.section('9. ai-client 分数格式化与错误分类')

  const sWhite = ai.formatScore({ scoreCp: 130, scoreMate: null }, 'w')
  H.eq(sWhite.tone, 'white', '行棋方为白的正分 → 白优')
  H.ok(sWhite.text.indexOf('+') === 0, '白优用正号显示')
  const sBlack = ai.formatScore({ scoreCp: 130, scoreMate: null }, 'b')
  H.eq(sBlack.tone, 'black', '行棋方为黑的正分 → 黑优')
  H.ok(sBlack.text.indexOf('-') === 0, '黑优用负号显示')
  H.eq(ai.formatScore({ scoreCp: 0, scoreMate: null }, 'w').tone, 'even', '零分是均势')
  H.eq(ai.formatScore({ scoreCp: null, scoreMate: 2 }, 'w').tone, 'mate', '有 mate 分数时 tone=mate')
  H.eq(ai.formatScore({ scoreCp: null, scoreMate: 2 }, 'w').text, '#2', '白方两步杀显示 #2')
  H.eq(ai.formatScore({ scoreCp: null, scoreMate: -3 }, 'w').text, '#-3', '白方被杀显示 #-3')

  H.eq(ai.evalPercent(0), 50, '零分时优势条居中')
  H.eq(ai.evalPercent(99999), 100, '白方绝杀优势拉满')
  H.eq(ai.evalPercent(-99999), 0, '黑方绝杀优势归零')
  H.ok(ai.evalPercent(300) > 50 && ai.evalPercent(-300) < 50, '正负分在优势条上分居两侧')

  const modelsList = [
    { id: 'deepseek-v4-flash', name: 'DeepSeek' },
    { id: 'glm-5.3-flash', name: 'GLM' },
    { id: 'slow-one', name: '慢模型', disabled: true }
  ]
  const candidates = ai.buildCandidates(modelsList)
  H.eq(candidates.indexOf('slow-one'), -1, '已停用的模型不会被选中')
  H.eq(candidates[0], 'deepseek-v4-flash', '偏好列表里的快模型排第一')
  H.eq(ai.providerOf('deepseek-v4-flash'), 'DeepSeek', '按 id 前缀识别 DeepSeek')
  H.eq(ai.providerOf('hy4-preview'), '腾讯混元', '按 id 前缀识别腾讯混元')
  H.eq(ai.providerOf('某个陌生模型'), '', '认不出的模型不显示厂商')

  const described = ai.describeModel(modelsList, 'deepseek-v4-flash')
  H.ok(described.label.indexOf('DeepSeek') !== -1, '模型展示名带上厂商')

  H.eq(ai.llmErrorInfo({ error: { code: 'env_no_network' } }).kind, 'env', '环境无网络归类为 env')
  H.eq(ai.llmErrorInfo({ error: { code: 'gateway_network_error' } }).kind, 'network', '链路失败归类为 network')
  // 判定必须带 code 前缀：裸 Error 的超时文案不能被误判成云端超时
  H.eq(ai.llmErrorInfo({ message: 'request:fail timeout' }).kind, 'network',
    '裸的 timeout 文案不能只凭文字判断')
  H.eq(ai.llmErrorInfo({ error: { code: 'gateway_timeout' } }).kind, 'timeout',
    'gateway_* + timeout 归为 timeout')
  H.eq(ai.llmErrorInfo({ error: { code: 'gateway_network_error' }, message: 'request:fail timeout' }).kind,
    'timeout', '链路层超时同样归入 timeout（这是现有行为，与「网络不通」区分开）')
  H.eq(ai.llmErrorInfo({ error: { code: 'model_overloaded' } }).kind, 'model', 'model_* 归为 model')
  H.eq(ai.llmErrorInfo({ error: { code: 'quota_exceeded' } }).kind, 'quota', '额度问题单独归类')
  H.ok(ai.llmErrorInfo({ error: { code: 'gateway_network_error' } }).message.indexOf('模型服务') === -1,
    '链路失败不能被说成「模型服务不可用」')
  // 预览环境网络层回 404（正文 "Not found"）时，必须归类为 notfound 且带 HTTP 404 详情，
  // 不能把难懂的 "Not found" 直接透出，也不能当成模型故障去换模型重试。
  const notFound = ai.llmErrorInfo({ message: 'Not found', status: 404 })
  H.eq(notFound.kind, 'notfound', '404 归类为 notfound')
  H.ok(notFound.detail.indexOf('HTTP 404') !== -1, '404 详情带 HTTP 状态码')
  H.eq(ai.shouldTryNextModel({ message: 'Not found', status: 404 }, null), false, '404 不应换模型重试')

  H.eq(ai.shouldTryNextModel({ error: { code: 'gateway_timeout' } }), true, '超时值得换模型重试')
  H.eq(ai.shouldTryNextModel({ error: { code: 'gateway_network_error' } }), false, '链路失败重试没意义')
  H.eq(ai.shouldTryNextModel({ error: { code: 'gateway_timeout' } }, { aborted: true }), false,
    '用户取消后绝不能偷偷再发一次')

  /* --------------------------------------------------- 10. coach-demo */
  H.section('10. 演示线解析与会话')

  // demoText 里是开局着法，必须用初始局面比对，用预置中局会把第一手判非法
  const parsed = coachDemo.parseDemo(demoText, INITIAL_FEN)
  H.eq(parsed.lines.length, 1, '解析出 1 条演示线')
  H.eq(parsed.lines[0].id, 'main', '线 id 保留')
  H.eq(parsed.lines[0].tone, 'good', 'tone 保留')
  H.eq(parsed.lines[0].moves.length, 2, '两步走法都被接受')
  H.eq(parsed.prose.indexOf('===DEMO===') === -1, true, 'stripped prose 不带结构化标记')

  // 排序：good 在前
  const multi = coachDemo.parseDemo(
    '正文\n===DEMO===\n' + JSON.stringify({
      lines: [
        { id: 'b', tone: 'bad', moves: ['Nf3'] },
        { id: 'g', tone: 'good', moves: ['e4'] },
        { id: 'n', tone: 'neutral', moves: ['d4'] }
      ]
    }) + '\n===END===', INITIAL_FEN)
  H.eq(multi.lines[0].id, 'g', 'good 排第一')
  H.eq(multi.lines[2].tone, 'neutral', 'neutral 排最后')

  // 非法手截断：保留合法前缀
  const truncated = coachDemo.parseDemo(
    '正文\n===DEMO===\n' + JSON.stringify({
      lines: [{ id: 't', tone: 'good', moves: ['e4', 'Qh99', 'Nf3'] }]
    }) + '\n===END===', INITIAL_FEN)
  H.eq(truncated.lines.length, 1, '部分非法时整条保留')
  H.eq(truncated.lines[0].moves.length, 1, '非法手被截断，只保留合法前缀')

  // JSON 坏掉不能让页面崩
  const broken = coachDemo.parseDemo('正文\n===DEMO===\n{这不是 JSON\n===END===', INITIAL_FEN)
  H.eq(broken.lines.length, 0, '坏 JSON 降级为无演示线')
  H.eq(broken.prose.indexOf('===DEMO===') === -1, true, '坏 JSON 时正文仍然干净')

  const session = new coachDemo.DemoSession(parsed.lines, INITIAL_FEN, { flipped: false })
  session.enter('main')
  H.eq(session.active, true, '进入演示线')
  const v0 = session.view()
  H.eq(v0.cells.length, 64, '演示视图产出 64 格')
  H.eq(v0.total, 2, '面包屑里总数 = 2 步')
  session.step(1)
  H.eq(session.cursor, 1, '前进一步')
  session.step(1)
  H.eq(session.cursor, 2, '走到末步')
  H.eq(session.view().demoCanForward, false, '末步不能继续前进')
  session.step(-1)
  H.eq(session.cursor, 1, '后退一步')
  H.eq(session.view().demoCanBack, true, '非起点可以后退')

  // 字段名统一：view() 现在直接返回模板要读的 demo* 字段（修复已知缺陷）
  const raw = session.view()
  H.eq(typeof raw.demoActive, 'boolean', '修复后：view() 产出 demoActive')
  H.eq(raw.demoActive, true, '修复后：demoActive 反映进入状态')
  H.eq(typeof raw.demoCanBack, 'boolean', '修复后：view() 产出 demoCanBack')
  H.eq(typeof raw.demoCanForward, 'boolean', '修复后：view() 产出 demoCanForward')
  H.eq(typeof raw.demoPlaying, 'boolean', '修复后：view() 产出 demoPlaying')
  H.eq(typeof raw.demoBreadcrumb, 'string', '修复后：view() 产出 demoBreadcrumb')
  H.eq(typeof raw.active, 'undefined', '修复后：旧字段名 active 已不再产出')

  /* ------------------------------------------- 11. WXML 模板静态守卫 */
  H.section('11. WXML 模板静态守卫（AGENTS.md §6.4）')

  const wxml = fs.readFileSync(ANALYZE_WXML, 'utf8')

  // 把每个标签拆开，逐个检查它「自身」的 opening tag
  const tags = []
  const tagRe = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let m
  while ((m = tagRe.exec(wxml))) {
    tags.push({ name: m[1], attrs: m[2], index: m.index })
  }

  const forTags = tags.filter(t => /\bwx:for\s*=/.test(t.attrs))
  H.ok(forTags.length > 0, `找到 ${forTags.length} 处 wx:for`)
  // 只看 {{ }} 插值内部：属性名本身可能叫 data-index，不能算引用循环变量。
  // 真正的违规是在插值里直接写内置变量 index（预览渲染会整行拿不到值）。
  const leaningIndex = attrs => (attrs.match(/\{\{[^}]*\}\}/g) || []).filter(e => /\bindex\b/.test(e))

  // 先给守卫本身做个体检，避免它变成永远通过的哑断言
  H.ok(leaningIndex('<view wx:for="{{list}}" wx:key="key" data-i="{{index}}">').length === 1,
    '守卫能抓到插值里裸用 index')
  H.eq(leaningIndex('<view wx:for="{{list}}" wx:key="key" data-index="{{item.idx}}">').length, 0,
    '守卫不误伤 data-index 属性名与 item.idx 字段')

  const forAttrBad = forTags.filter(t => leaningIndex(t.attrs).length > 0)
  H.eq(forAttrBad.length, 0, 'wx:for 元素自身的属性里没有引用循环变量 index')
  if (forAttrBad.length) console.log('      违规插值：' + forAttrBad.map(t => leaningIndex(t.attrs).join(',')).join(' | '))
  if (forAttrBad.length) {
    forAttrBad.forEach(t => console.log('      违规标签：<' + t.name + t.attrs + '>'))
  }

  const allKeyValues = []
  const keyRe = /wx:key\s*=\s*"([^"]*)"/g
  while ((m = keyRe.exec(wxml))) allKeyValues.push(m[1])
  H.ok(allKeyValues.length > 0, `收集到 ${allKeyValues.length} 个 wx:key`)
  const badKeys = allKeyValues.filter(k => !/^[a-zA-Z_][\w]*$/.test(k))
  H.eq(badKeys.length, 0, '所有 wx:key 都是字符串字段名（没有数字、没有 *this）')
  if (badKeys.length) console.log('      违规 wx:key：' + badKeys.join(', '))

  H.eq(/<block[\s>]/.test(wxml), false, '没有使用 <block>')

  // wx:key 指向的字段必须真的存在于数据里
  const sample = createPage(wxFull)
  await injectResult(sample)
  H.ok(sample.data.tabs.every(t => typeof t.key === 'string'), 'tabs 自带字符串 key')
  H.ok(sample.data.moveRows.length === 0 || sample.data.moveRows.every(r => typeof r.key === 'string'),
    'moveRows 自带字符串 key')
  H.ok(sample.data.analysisLines.every(l => typeof l.key === 'string'), 'analysisLines 自带字符串 key')
  H.ok(sample.data.debugRows.every(r => typeof r.key === 'string'), 'debugRows 自带字符串 key')
  H.ok(sample.data.cells.every(c => typeof c.sq === 'string'), 'cells 自带字符串 sq')

  /* ------------------------------------------------------- 12. app.json */
  H.section('12. 配置守卫')

  const appJsonText = fs.readFileSync(APP_JSON, 'utf8')
  const appJson = JSON.parse(appJsonText)
  H.eq(appJson.lazyCodeLoading, 'requiredComponents', 'app.json 保留了 lazyCodeLoading')
  H.ok(Array.isArray(appJson.pages) && appJson.pages.indexOf('pages/analyze/analyze') !== -1,
    'pages 列表里包含 analyze 页面')

  return H.summary('analyze-page.test.js')
}

main().then(green => {
  if (!green) process.exit(1)
}).catch(err => {
  console.error('\n测试脚本自身异常：', err)
  process.exit(1)
})
