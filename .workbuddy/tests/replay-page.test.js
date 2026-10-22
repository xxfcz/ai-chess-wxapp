/**
 * replay-page.test.js
 * 打谱页（pages/replay/replay）页面层回归：PGN 导入、逐步回放（前进/后退/重置/跳末尾）、
 * 走法列表点击定位、分支切换、每步引擎标注与节点级缓存、手动 AI 点评与演示分支、
 * 跨页面恢复、加载失败不破坏现场、WXML 模板静态守卫 + app.json / Landing 配置守卫。
 *
 * 用 node 跑：
 *   node .workbuddy/tests/replay-page.test.js
 *
 * 与 analyze/play 两个页面测试一致：打桩环境刻意不提供 createSelectorQuery /
 * getWindowInfo / getSystemInfoSync / showToast，代码一旦重新依赖这些接口会当场报错。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const H = require('./_harness')

const ROOT = path.join(__dirname, '..', '..')
const REPLAY_PAGE = path.join(ROOT, 'pages', 'replay', 'replay.js')
const REPLAY_WXML = path.join(ROOT, 'pages', 'replay', 'replay.wxml')
const LANDING_PAGE = path.join(ROOT, 'pages', 'landing', 'landing.js')
const APP_JSON = path.join(ROOT, 'app.json')

const ai = require(path.join(ROOT, 'utils', 'ai-client.js'))
const coachRunner = require(path.join(ROOT, 'utils', 'coach-runner.js'))
const coachDemo = require(path.join(ROOT, 'utils', 'coach-demo.js'))
const debugLog = require(path.join(ROOT, 'utils', 'debug-log.js'))
const { sessionStore } = require(path.join(ROOT, 'utils', 'session-store.js'))

const sleep = ms => new Promise(r => setTimeout(r, ms))

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

function makeWx() {
  const calls = []
  const wx = {
    request() { calls.push('request') },
    setClipboardData(o) { calls.push('setClipboardData'); if (o && o.success) o.success() },
    getAccountInfoSync() { return { miniProgram: { appId: 'wxtest' } } },
    navigateTo(o) { calls.push('navigateTo'); this.__lastUrl = o && o.url }
  }
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

function loadPageModule(file) {
  delete require.cache[require.resolve(file)]
  captured = null
  require(file)
  if (!captured) throw new Error('页面没有调用 Page()：' + file)
  return captured
}

function createPage(wxStub, keepStore) {
  if (!keepStore) sessionStore.reset()
  installGlobals(wxStub)
  const opts = loadPageModule(REPLAY_PAGE)
  const page = Object.assign({}, opts)
  page.data = JSON.parse(JSON.stringify(opts.data))
  page.setData = function (patch) { Object.assign(this.data, patch) }
  opts.onLoad.call(page)
  // 本地引擎深度 2：让「每步标注」在测试里跑得动
  page.data.depthIndex = 0
  return page
}

const SAMPLE_PGN = [
  '[Event "示例对局"]',
  '[Site "黑白格大师"]',
  '[Date "2024.01.01"]',
  '[White "白方"]',
  '[Black "黑方"]',
  '[Result "1/2-1/2"]',
  '',
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 (3... Nf6 4. d3 Bc5) 4. c3 Nf6 5. d3 d6 1/2-1/2'
].join('\n')

function importSample(page) {
  page.onPgnInput({ detail: { value: SAMPLE_PGN } })
  return page.onImport()
}

/** 等「当前局面」的分析落地（analyzing 结束 且 _view 指向该局面） */
function waitAnalysis(page, fen) {
  return waitFor(() => !page.data.analyzing && page._view && page._view.fen === fen && page.data.analysisLines.length > 0)
}

function mainSans(page) {
  return page.session.mainLine().slice(1).map(n => n.san)
}

/* ------------------------------------------------------------ 主流程 */

async function main() {
  ai.setEngineMode('local')
  debugLog.clear()

  /* -------------------------------------------------- 1. 打桩环境自检 */
  H.section('1. 打桩环境自检')

  const wx = makeWx()
  FORBIDDEN_WX.forEach(name => {
    H.eq(typeof wx[name], 'undefined', `打桩 wx 不提供 ${name}`)
  })
  H.eq(typeof wx.request, 'function', 'wx.request 可用（云端点评有网络能力）')

  /* ------------------------------------------------------ 2. 空状态 */
  H.section('2. 空状态：未导入时只有导入卡')

  const p = createPage(wx)
  H.eq(p.data.hasGame, false, '没有棋谱时 hasGame=false')
  H.eq(p.data.pgnCollapsed, false, '导入卡默认展开')
  H.eq(p.data.cells.length, 0, '没有棋谱就不渲染棋盘')
  H.eq(p.data.tabs.length, 3, '提供引擎/点评/走子三个 Tab')
  H.eq(p.data.activeTabKey, 'engine', '默认落在「引擎分析」Tab')
  H.eq(p.data.cloudReady, true, '有 wx.request 时 cloudReady=true')
  H.eq(sessionStore.getSession(), null, '空状态没有遗留会话')

  /* -------------------------------------------------------- 3. 导入 */
  H.section('3. 导入 PGN')

  const g = createPage(wx)
  const imported = importSample(g)
  H.eq(imported, true, '示例 PGN 导入成功')
  H.eq(g.data.hasGame, true, '导入后显示棋盘')
  H.eq(g.data.cells.length, 64, '棋盘产出 64 个格子')
  H.eq(g.data.importError, '', '成功时没有错误信息')
  H.eq(g.data.pgnCollapsed, true, '导入成功后导入卡收起')
  H.eq(g.data.moveCount, 10, '主线共 10 步')
  H.eq(g.data.stepTotal, 10, '步进总数 = 主线步数')
  H.eq(g.data.stepNo, 0, '导入后停在起始局面')
  H.eq(g.data.stepLabel, '起始局面', '起始局面标签')
  H.eq(g.data.canUndo, false, '起始局面不能后退')
  H.eq(g.data.canRedo, true, '起始局面可以前进')
  H.eq(g.session.mainLine().length - 1, 10, 'Session 主线 10 步')
  H.ok(g.session.nodeCount() > 11, 'Session 里带出了变例节点（共 ' + g.session.nodeCount() + ' 个）')
  H.eq(g.data.moveRows.length, 5, '走子记录按回合折叠成 5 行')
  H.ok(g.data.moveRows.every(r => typeof r.key === 'string'), '走子记录每行自带字符串 key')
  H.ok(g.data.moveRows.every(r => typeof r.whiteKey === 'string' && typeof r.blackKey === 'string'),
    '走子记录每手都带节点 id（可点击定位）')
  H.eq(g.data.gameTitle, '白方 vs 黑方', '标题用 PGN 头里的双方')
  H.ok(g.data.gameMeta.indexOf('示例对局') !== -1, '副标题带 Event')
  H.ok(g.data.gameMeta.indexOf('1/2-1/2') !== -1, '副标题带结果')
  H.eq(g.data.inVariation, false, '起始局面不算变例')
  H.eq(g.data.branchPoint, false, '起始局面只有一条续着')
  H.eq(sessionStore.getSession(), g.session, '会话写入全局 store（跨页面保留）')
  H.eq(sessionStore.getMode(), 'replay', 'store 模式标为 replay')

  /* ---------------------------------------------------- 4. 逐步回放 */
  H.section('4. 逐步回放')

  g.onStepForward()
  H.eq(g.data.stepNo, 1, '前进一步到第 1 步')
  H.eq(g.session.current().san, 'e4', '第 1 步是 e4')
  H.eq(g.data.canUndo, true, '前进后可以后退')
  H.eq(g.data.stepLabel, '第 1 步 · e4', '步进标签带 SAN')
  H.eq(g.data.pathLine, 'e4', '路径行显示已走的手数')
  H.eq(g.data.moveRows[0].whiteActive, true, '走子记录高亮当前这一手')
  // 棋盘跟着局面走：e2 已空、e4 有白兵
  const cellE2 = g.data.cells.find(c => c.sq === 'e2')
  const cellE4 = g.data.cells.find(c => c.sq === 'e4')
  H.eq(cellE2.glyph, '', 'e2 格的兵已经走掉')
  H.eq(cellE4.glyph, '\u265F', 'e4 格出现白兵字形')
  H.eq(cellE4.color, 'w', 'e4 上的棋子是白方')

  g.onStepForward()
  H.eq(g.data.stepNo, 2, '再前进一步到第 2 步')
  H.eq(g.data.moveRows[0].blackActive, true, '高亮切到黑方这一手')

  g.onStepBack()
  H.eq(g.data.stepNo, 1, '后退一步回到第 1 步')
  H.eq(g.data.moveRows[0].whiteActive, true, '高亮回到白方这一手')

  g.onReset()
  H.eq(g.data.stepNo, 0, '重置回到起始局面')
  H.eq(g.data.canUndo, false, '起始局面不能后退')

  g.onGotoEnd()
  H.eq(g.data.stepNo, 10, '跳到末尾到第 10 步')
  H.eq(g.session.current().san, 'd6', '末尾一步是 d6')
  H.eq(g.data.canRedo, false, '末尾不能前进')

  /* ------------------------------------ 5. 走法列表定位 + 分支切换 */
  H.section('5. 走法列表定位与分支切换')

  const nc6 = g.session.mainLine()[4] // 1.e4 e5 2.Nf3 Nc6
  g.onGotoNode({ detail: { node: nc6.id } })
  H.eq(g.data.stepNo, 4, '点击走法列表跳到第 4 步（Nc6）')
  H.eq(g.session.current().san, 'Nc6', '当前节点是 Nc6')

  const bc4 = g.session.mainLine()[5] // 3.Bc4，其下挂着 Bc5（主线）与 Nf6（变例）
  g.onGotoNode({ currentTarget: { dataset: { node: bc4.id } } })
  H.eq(g.data.stepNo, 5, '也支持 dataset 形式的定位事件（分支 chips）')
  H.eq(g.data.branchPoint, true, 'Bc4 之后是分支点')
  H.eq(g.data.childOptions.length, 2, 'Bc4 有两条续着')
  H.ok(g.data.childOptions.every(o => typeof o.key === 'string'), '分支选项自带字符串 key')
  H.eq(g.data.childOptions[0].main, true, '第一条是主线')
  H.eq(g.data.childOptions[1].label.indexOf('分支') === 0, true, '第二条标为分支')

  const altId = g.data.childOptions[1].id
  g.onGotoNode({ detail: { node: altId } })
  H.eq(g.session.current().san, 'Nf6', '进入变例首手 Nf6')
  H.eq(g.data.stepNo, 6, '变例节点也算一步')
  H.eq(g.data.inVariation, true, '当前在变例中')
  H.eq(g.data.pathLine, 'e4 e5 Nf3 Nc6 Bc4 Nf6', '路径行跟着变例走')

  // 变例可以继续往回走回主线
  g.onStepBack()
  H.eq(g.session.current().san, 'Bc4', '从变例退回分支点')
  H.eq(g.data.inVariation, false, '分支点上不再标变例')

  /* ------------------------------------ 6. 每步引擎标注 + 节点级缓存 */
  H.section('6. 每步引擎标注与节点级缓存')

  const e = createPage(wx)
  e.data.depthIndex = 0
  importSample(e)
  const rootId = e.session.root().id
  const rootFen = e.session.current().fen
  const rootReady = await waitAnalysis(e, rootFen)
  H.ok(rootReady, '起始局面自动标注完成')
  H.ok(e.data.analysisLines.length > 0, '给出三条（或更少）候选路线')
  H.ok(e.data.evalLabel && e.data.evalLabel !== '—', '评估数值已就绪：' + e.data.evalLabel)
  H.ok(e.data.analysisMeta.indexOf('深度') !== -1, '元信息带引擎与深度')
  H.ok(!!e.session.getAnalysis(rootId), '分析结果写进 Session 节点级缓存（L0）')

  // 统计引擎调用：切到新节点才该请求，回到已分析过的节点必须命中缓存
  const originalAnalyze = ai.analyzePosition
  let calls = 0
  ai.analyzePosition = function (args) {
    calls += 1
    return originalAnalyze.call(ai, args)
  }

  e.onStepForward()
  const stepFen = e.session.current().fen
  const stepReady = await waitAnalysis(e, stepFen)
  H.ok(stepReady, '第 1 步的局面自动标注完成')
  H.eq(calls, 1, '新节点只请求一次引擎')

  e.onStepBack()
  await sleep(500)
  H.eq(calls, 1, '退回已分析过的节点命中缓存，不再请求引擎')
  H.eq(e._view.fen, rootFen, '画面恢复到起始局面的分析')

  e.onStepForward()
  await sleep(500)
  H.eq(calls, 1, '再次前进一步仍命中缓存（重访不重算）')
  H.eq(e._view.fen, stepFen, '画面恢复到第 1 步的分析')

  // 切深度：缓存判据带深度，应重新请求
  e.setData({ depthIndex: 1 })
  await e.runAnalyze()
  H.eq(calls, 2, '切深度会重新分析（缓存按深度区分）')
  ai.analyzePosition = originalAnalyze

  /* ------------------------------------- 7. 手动点评 + 演示分支 */
  H.section('7. 手动 AI 点评与分支演示')

  const c = createPage(wx)
  c.data.depthIndex = 0
  importSample(c)
  await waitAnalysis(c, c.session.current().fen)

  const demoText = '这步先占中心。\n===DEMO===\n' + JSON.stringify({
    lines: [{ id: 'main', label: '主线', tone: 'good', moves: ['e4', 'e5'] }]
  }) + '\n===END==='
  let coachCalled = 0
  const origRun = coachRunner.runCoachComment
  coachRunner.runCoachComment = function (params) {
    coachCalled += 1
    const parsed = coachDemo.parseDemo(demoText, params.fen)
    if (params.onModel) params.onModel({ label: 'test-model' })
    if (params.onResult) params.onResult({ coachText: parsed.prose, coachSegments: [], parsed: parsed })
    return Promise.resolve()
  }

  c.onCoach()
  await sleep(50)
  H.eq(coachCalled, 1, '点「AI 点评」触发一次生成')
  H.eq(c.data.commenting, false, '结果返回后退出生成中状态')
  H.ok(c.data.coachText.indexOf('占中心') !== -1, '点评正文显示出来')
  H.eq(c.data.coachModel, 'test-model', '显示本次使用的模型')
  H.eq(c.data.demoLines.length, 1, '演示线解析出来（分支可点）')

  // 点分支 → 进入演示；演示跑在临时副本上，不动棋谱位置
  c.onEnterDemo({ detail: { line: 'main' } })
  H.eq(c.data.demoActive, true, '进入演示')
  H.eq(c.data.cells.length, 64, '演示时棋盘照常渲染')
  H.eq(c.data.stepNo, 0, '演示不影响棋谱当前步')
  c.onDemoStep({ detail: { dir: 1 } })
  H.eq(c.data.demoCanBack, true, '演示可以后退（说明已走了一步）')
  c.onDemoStep({ detail: { dir: 1 } })
  c.onDemoExit()
  H.eq(c.data.demoActive, false, '退出演示')
  H.eq(c.session.current().id, c.session.root().id, '退出演示后棋谱仍停在原节点')

  // 取消：生成中可以主动放弃，不把中断当失败
  coachRunner.runCoachComment = function () { return Promise.resolve() }
  c._lastCoachAt = 0
  c.onCoach()
  H.eq(c.data.commenting, true, '请求发出后处于生成中')
  c.cancelCoach()
  H.eq(c.data.commenting, false, '取消后不再生成')
  H.eq(c.data.coachError, '', '取消不是失败（不显示错误）')

  // 演示中按「下一步」：先退出演示，再前进棋谱（不用点两次）
  // 先重新生成一次点评——取消会清掉演示线（点评属于当前局面）
  coachRunner.runCoachComment = function (params) {
    const parsed = coachDemo.parseDemo(demoText, params.fen)
    if (params.onResult) params.onResult({ coachText: parsed.prose, coachSegments: [], parsed: parsed })
    return Promise.resolve()
  }
  c._lastCoachAt = 0
  c.onCoach()
  H.eq(c.data.demoLines.length, 1, '重新生成后演示线恢复')
  c.onEnterDemo({ detail: { line: 'main' } })
  H.eq(c.data.demoActive, true, '可以重新进入演示')
  c.onStepForward()
  H.eq(c.data.demoActive, false, '演示中按「下一步」先退出演示')
  H.eq(c.data.stepNo, 1, '并且在同一次操作里前进一步')
  coachRunner.runCoachComment = origRun

  // 无网络环境：不发起请求，给明确提示而不是静默
  const cNoNet = createPage(makeWx())
  cNoNet.data.cloudReady = false
  cNoNet.data.depthIndex = 0
  importSample(cNoNet)
  await waitAnalysis(cNoNet, cNoNet.session.current().fen)
  const beforeNoNet = coachCalled
  cNoNet.onCoach()
  H.eq(coachCalled, beforeNoNet, '无网络时不发起点评请求')
  H.eq(cNoNet.data.commenting, false, '无网络时不会卡在生成中')

  /* ------------------------------------------- 8. 导入失败不破坏现场 */
  H.section('8. 导入失败不破坏现场')

  const badPage = createPage(wx)
  const okBad = badPage.onImport()
  H.eq(okBad, false, '空输入不导入')
  badPage.onPgnInput({ detail: { value: '1. e4 e5 2. Qxf7' } })
  const badResult = badPage.onImport()
  H.eq(badResult, false, '非法 PGN 导入失败')
  H.ok(badPage.data.importError.indexOf('第 3 步') !== -1, '错误信息指出出错步数：' + badPage.data.importError)
  H.eq(badPage.data.hasGame, false, '失败时不会显示空棋盘')

  const keepPage = createPage(wx)
  importSample(keepPage)
  keepPage.onStepForward()
  const keepId = keepPage.session.currentId()
  keepPage.onPgnInput({ detail: { value: '乱码不是 PGN' } })
  keepPage.onImport()
  H.eq(keepPage.data.hasGame, true, '已有棋谱仍在')
  H.eq(keepPage.session.currentId(), keepId, '失败的导入没有改动当前节点')
  H.eq(keepPage.data.stepNo, 1, '步进也没有被重置')

  /* -------------------------------------------- 9. 跨页面恢复现场 */
  H.section('9. 跨页面恢复（退出再进入不丢棋谱）')

  const r1 = createPage(wx)
  r1.data.depthIndex = 0
  importSample(r1)
  r1.onGotoEnd()
  const r2 = createPage(wx, true) // keepStore：模拟从 Landing 再次进入打谱页
  H.eq(r2.data.hasGame, true, '重进页面仍有棋谱')
  H.eq(r2.data.stepNo, 10, '恢复到上次停的那一步')
  H.eq(r2.data.moveCount, 10, '走法记录恢复')
  H.eq(r2.data.gameTitle, '白方 vs 黑方', '标题从元信息恢复')
  H.ok(r2.data.pgnInput.indexOf('Bc4') !== -1, '导入框里的 PGN 也恢复（可直接再复制/改）')
  H.eq(r2.session, r1.session, '复用的是同一个 Session 实例')

  /* ------------------------------------- 10. WXML 模板静态守卫 */
  H.section('10. WXML 模板静态守卫（AGENTS.md §6.4）')

  function collectWxml(dir, acc) {
    if (!fs.existsSync(dir)) return acc
    fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
      const full = path.join(dir, d.name)
      if (d.isDirectory()) collectWxml(full, acc)
      else if (d.isFile() && d.name.endsWith('.wxml')) acc.push(full)
    })
    return acc
  }
  const appJsonForScan = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'))
  const wxmlFiles = []
  collectWxml(path.join(ROOT, 'pages'), wxmlFiles)
  collectWxml(path.join(ROOT, 'components'), wxmlFiles)
  // 官方字段是 subPackages，小写 subpackages 为等价写法；两种都认，避免改名后守卫静默漏扫
  const scanSubs = appJsonForScan.subPackages || appJsonForScan.subpackages
  if (Array.isArray(scanSubs)) {
    scanSubs.forEach(sp => {
      if (sp && sp.root) collectWxml(path.join(ROOT, sp.root), wxmlFiles)
    })
  }
  const uniqueWxml = Array.from(new Set(wxmlFiles))
  H.ok(uniqueWxml.indexOf(REPLAY_WXML) !== -1, '扫描集合包含 pages/replay/replay.wxml')
  const wxml = uniqueWxml.map(f => fs.readFileSync(f, 'utf8')).join('\n').replace(/<!--[\s\S]*?-->/g, '')

  const tags = []
  const tagRe = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let m
  while ((m = tagRe.exec(wxml))) tags.push({ name: m[1], attrs: m[2] })
  const forTags = tags.filter(t => /\bwx:for\s*=/.test(t.attrs))
  H.ok(forTags.length > 0, `找到 ${forTags.length} 处 wx:for`)

  const leaningIndex = attrs => (attrs.match(/\{\{[^}]*\}\}/g) || []).filter(e => /\bindex\b/.test(e))
  H.eq(forTags.filter(t => leaningIndex(t.attrs).length > 0).length, 0,
    'wx:for 元素自身属性里没有引用循环变量 index')

  const allKeyValues = []
  const keyRe = /wx:key\s*=\s*"([^"]*)"/g
  while ((m = keyRe.exec(wxml))) allKeyValues.push(m[1])
  H.ok(allKeyValues.length > 0, `收集到 ${allKeyValues.length} 个 wx:key`)
  const badKeys = allKeyValues.filter(k => !/^[a-zA-Z_][\w]*$/.test(k))
  H.eq(badKeys.length, 0, '所有 wx:key 都是字符串字段名')
  H.eq(/<block[\s>]/.test(wxml), false, '没有使用 <block>')

  /* ------------------------------------- 11. 配置守卫 */
  H.section('11. app.json / Landing 配置守卫')

  H.eq(appJsonForScan.lazyCodeLoading, 'requiredComponents', 'app.json 保留了 lazyCodeLoading')
  // 2026-10-22 晚：放弃分包，模式页移入主包 pages
  H.ok(Array.isArray(appJsonForScan.pages) && appJsonForScan.pages.indexOf('pages/replay/replay') !== -1,
    '主包 pages 包含 pages/replay/replay（已改单包，L2-T7）')
  H.ok(!appJsonForScan.subPackages && !appJsonForScan.subpackages,
    '不再声明 subPackages（单包结构）')

  installGlobals(wx)
  const landingOpts = loadPageModule(LANDING_PAGE)
  const cards = landingOpts.data.cards
  H.eq(cards.length, 4, 'Landing 仍是四张模式卡片')
  const replayCard = cards.find(cd => cd.mode === 'replay')
  H.ok(replayCard && replayCard.ready === true, '打谱卡片已就绪')
  H.ok(replayCard && replayCard.url.indexOf('/pages/replay/replay?mode=replay') === 0, '打谱卡片指向 replay 页')
  H.eq(cards.filter(cd => !cd.ready).length, 1, '只剩「学习」一张即将上线')

  sessionStore.reset()
  ai.setEngineMode('local')

  return H.summary('replay-page.test.js')
}

main().then(green => {
  if (!green) process.exit(1)
}).catch(err => {
  console.error('\n测试脚本自身异常：', err)
  process.exit(1)
})
