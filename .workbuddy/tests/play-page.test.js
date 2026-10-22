/**
 * play-page.test.js
 * 对弈分包（pkg-play/play）页面层回归：初始化、走子护栏（只能动己方棋子、myTurn 门控）、
 * sparrer 引擎自动回着、自动点评门控（autoCoach × playCoachScope 关键步判定）、
 * undo 回退保持玩家掌控、以及 WXML 模板静态守卫 + app.json 配置守卫。
 *
 * 用 node 跑：
 *   node .workbuddy/tests/play-page.test.js
 *
 * 同 analyze-page 一样，打桩环境刻意不提供 createSelectorQuery / getWindowInfo /
 * getSystemInfoSync，模拟网页版预览能力缺失 —— 代码一旦重新依赖这些接口会当场报错。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const H = require('./_harness')

const ROOT = path.join(__dirname, '..', '..')
const PLAY_PAGE = path.join(ROOT, 'pkg-play', 'play', 'play.js')
const PLAY_WXML = path.join(ROOT, 'pkg-play', 'play', 'play.wxml')
const APP_JSON = path.join(ROOT, 'app.json')

const ai = require(path.join(ROOT, 'utils', 'ai-client.js'))
const coachRunner = require(path.join(ROOT, 'utils', 'coach-runner.js'))
const coachDemo = require(path.join(ROOT, 'utils', 'coach-demo.js'))
const debugLog = require(path.join(ROOT, 'utils', 'debug-log.js'))
const settings = require(path.join(ROOT, 'utils', 'settings.js'))
const { Game, START_FEN } = require(path.join(ROOT, 'utils', 'game.js'))
const { sessionStore } = require(path.join(ROOT, 'utils', 'session-store.js'))

// game.js 不导出 INITIAL_FEN；这里与 analyze-page 测试保持一致，用字面量（即起始局面）
const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const INITIAL_FEN_START = INITIAL_FEN
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

function makeWx(mode) {
  const calls = []
  const wx = {
    request() { calls.push('request') },
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
  delete require.cache[require.resolve(PLAY_PAGE)]
  captured = null
  require(PLAY_PAGE)
  if (!captured) throw new Error('页面没有调用 Page()')
  return captured
}

function createPage(wxStub, keepStore) {
  if (!keepStore) sessionStore.reset()
  installGlobals(wxStub)
  const opts = loadPageModule()
  const page = Object.assign({}, opts)
  page.data = JSON.parse(JSON.stringify(opts.data))
  page.setData = function (patch) {
    Object.assign(this.data, patch)
  }
  opts.onLoad.call(page)
  return page
}

function createInitialPage(wxStub) {
  const page = createPage(wxStub)
  page.game.load(INITIAL_FEN_START)
  page.syncAll()
  return page
}

/* ------------------------------------------------------------ 辅助 */

function tapEvent(sq) {
  return { currentTarget: { dataset: { sq: sq } } }
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
  /**
   * 对弈页默认把引擎锁成 local：远端路径由 remote-engine.test.js 覆盖，
   * 这里若走 remote，打桩的 wx.request 永远不会回调，页面会挂在 await 上。
   */
  ai.setEngineMode('local')
  settings._reset()

  /* -------------------------------------------------- 1. 打桩环境自检 */
  H.section('1. 打桩环境自检')

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
  H.eq(p.data.playAs, 'w', '默认玩家执白')
  H.eq(p.data.sparrerColor, 'b', '对手（sparrer）执黑')
  H.eq(p.data.myTurn, true, '初始轮到玩家落子')
  H.eq(p.data.engineThinking, false, '初始 AI 不在思考')
  H.eq(p.data.sideOptions.length, 2, '执子方切换提供两个选项')
  H.eq(p.data.strengthOptions.length, 3, '陪练强度提供三档')
  H.ok(p.data.sideOptions.every(o => typeof o.key === 'string'), '执子方选项自带字符串 key')
  H.ok(p.data.strengthOptions.every(o => typeof o.key === 'string'), '强度选项自带字符串 key')
  H.eq(p.data.strengthKey, 'standard', '默认强度为「标准」')
  H.eq(p.data.sparrerDepth, 3, '标准强度对应深度 3')
  H.eq(p.data.cloudReady, true, '有 wx.request 时 cloudReady=true')
  H.eq(p.data.activeTabKey, 'engine', '默认落在「引擎分析」Tab')
  H.eq(p.data.flipped, false, '玩家执白时不翻转棋盘')
  H.eq(p.data.tabs.length, 3, '提供引擎/点评/走子三个 Tab')

  // 无网络环境也要能起来（端上保底通道）
  const pNoNet = createPage(wxNonet)
  H.eq(pNoNet.data.cloudReady, false, '没有 wx.request 时 cloudReady=false')
  H.eq(pNoNet.data.cells.length, 64, '无网络环境下棋盘照常渲染')

  /* ------------------------------------------- 3. 走子护栏（对弈专属） */
  H.section('3. 走子护栏：只能动己方棋子 + myTurn 门控')

  const g = createInitialPage(wxFull)
  H.eq(g.data.myTurn, true, '初始 myTurn=true 允许落子')
  // 选己方（白）棋子 → 选中
  g.onCellTap(tapEvent('e2'))
  H.eq(g.game.selected, 'e2', '玩家可以选中自己的白兵')
  H.ok(g.game.legalTargets.indexOf('e4') !== -1, '选中后出现合法落点')
  // 选对方（黑）棋子 → 拒绝（对弈模式禁止自由模拟对方）
  g.onCellTap(tapEvent('e7'))
  H.eq(g.game.selected, null, '玩家不能选中对方（黑）棋子（杜绝自由模拟）')

  // myTurn=false 时，点选/落子都应被护栏拦下
  const g2 = createInitialPage(wxFull)
  g2.data.myTurn = false
  g2.onCellTap(tapEvent('e2'))
  H.eq(g2.game.selected, null, 'myTurn=false 时落子护栏拦截点选')
  H.eq(g2.data.moveCount, 0, 'myTurn=false 时不会发生走子')

  // 正常走子：e2→e4 推动局面，轮到 sparrer
  const g3 = createInitialPage(wxFull)
  g3.data.depthIndex = 0 // 加速本地分析
  g3.onCellTap(tapEvent('e2'))
  g3.onCellTap(tapEvent('e4'))
  H.eq(g3.game.getTurn(), 'b', '玩家落子后行棋方切换到黑（sparrer）')
  H.eq(g3.data.moveCount, 1, '玩家走子计数 +1')
  H.eq(g3.game.selected, null, '走子后清空选中')

  /* ------------------------------------------- 4. sparrer 引擎自动回着 */
  H.section('4. sparrer 引擎自动回着（玩家落子后 AI 应着）')

  const e = createInitialPage(wxFull)
  e.data.depthIndex = 0
  e._sparrerDepth = 2 // 加速 sparrer 应着
  e.setData({ sparrerDepth: 2 })
  // 玩家先走一步
  e.onCellTap(tapEvent('e2'))
  e.onCellTap(tapEvent('e4'))
  H.eq(e.data.moveCount, 1, '玩家已落子（e4）')
  // 等待 sparrer 自动回着 + 收尾分析完成（myTurn 回到玩家才是"能再走"的真正信号）
  const settled = await waitFor(() => e.data.moveCount === 2 && e.data.engineThinking === false)
  H.ok(settled, '玩家走一步 + sparrer 自动回着 + 收尾分析，最终轮到玩家')
  H.eq(e.data.moveCount, 2, '总走子数 = 玩家 1 + sparrer 1')
  H.eq(e.data.myTurn, true, 'sparrer 回着后重新轮到玩家')
  H.eq(e.data.engineThinking, false, 'sparrer 落子后不再处于思考态')
  H.eq(e.game.getTurn(), e.data.playAs, '局面行棋方回到玩家执子方')

  // 引擎彻底失败时：sparrer 无法落子，行棋方仍停在 sparrer 一侧（玩家不能动是合理规则），
  // 但绝不能卡在"AI 思考中"的死状态。本地引擎是冻结基线不会失败，真实环境不进入此态。
  {
    const original = ai.analyzePosition
    ai.analyzePosition = () => Promise.reject(new Error('引擎炸了'))
    const bad = createInitialPage(wxFull)
    bad.data.depthIndex = 0
    bad._sparrerDepth = 2
    bad.onCellTap(tapEvent('e2'))
    bad.onCellTap(tapEvent('e4'))
    await sleep(700) // 等 sparrer 应着分支失败并复位思考态
    H.eq(bad.data.moveCount, 1, '引擎失败时 sparrer 没有凭空落子')
    H.eq(bad.data.engineThinking, false, '引擎失败后思考态复位（不在 AI 思考上卡死）')
    ai.analyzePosition = original
  }

  /* ------------------------------------- 5. 自动点评门控（autoCoach × playCoachScope） */
  H.section('5. 自动点评门控')

  // 替换 coachRunner，记录是否被调用，且不真的发起网络（避免挂起）
  let coachCalled = false
  const origRun = coachRunner.runCoachComment
  coachRunner.runCoachComment = function (params) {
    coachCalled = true
    // 不调用 onResult，保持 commenting=true 直到测试主动 cancel；定时器等 cancelCoach 清理
    return Promise.resolve()
  }
  function resetCoachState(page) {
    page.data.commenting = false
    page._coachCancelled = false
    page._coachController = null
    if (page._coachTimer) { clearInterval(page._coachTimer); page._coachTimer = null }
    coachCalled = false
  }
  function resetSettings() {
    settings._reset()
    settings.setSetting('autoCoach', 'on')
    settings.setSetting('playCoachScope', 'keySteps')
    settings.setSetting('playAs', 'w')
  }

  const c = createInitialPage(wxFull)
  c.data.depthIndex = 0

  // 5.1 autoCoach=off → 永不自动点评
  resetSettings()
  resetCoachState(c)
  settings.setSetting('autoCoach', 'off')
  await injectResult(c)
  c.maybeAutoCoach()
  H.eq(coachCalled, false, 'autoCoach=off 时不触发任何点评')

  // 5.2 autoCoach=on + playCoachScope=allSteps → 每步都点评（即便非关键步）
  resetSettings()
  resetCoachState(c)
  settings.setSetting('playCoachScope', 'allSteps')
  await injectResult(c)
  // 构造一个"非关键步"语境，allSteps 仍应点评（保留 _lastResult 走同步分支）
  c._lastPlayerMove = {}            // 无吃子
  c._gaveCheck = false
  c._inCheckBefore = false
  c._preMoveWhiteCp = null
  c.maybeAutoCoach()
  H.eq(coachCalled, true, 'allSteps 模式下即便非关键步也触发点评')
  c.cancelCoach()

  // 5.3 autoCoach=on + playCoachScope=keySteps + 吃子（关键步）→ 点评
  resetSettings()
  resetCoachState(c)
  settings.setSetting('playCoachScope', 'keySteps')
  await injectResult(c)
  c._lastPlayerMove = { captured: 'p', san: 'exd5' }
  c._gaveCheck = false
  c._inCheckBefore = false
  c._preMoveWhiteCp = null
  c.maybeAutoCoach()
  H.eq(coachCalled, true, 'keySteps 模式下吃子步（关键步）触发点评')
  c.cancelCoach()

  // 5.4 autoCoach=on + playCoachScope=keySteps + 非关键步 → 不点评
  resetSettings()
  resetCoachState(c)
  settings.setSetting('playCoachScope', 'keySteps')
  await injectResult(c) // 保证 _lastResult 已就绪，单纯看 keySteps 判定
  c._lastPlayerMove = {}            // 无吃子
  c._gaveCheck = false
  c._inCheckBefore = false
  c._preMoveWhiteCp = null
  c._lastResult = null              // 无 before/after 评分 → delta 为 null
  c.maybeAutoCoach()
  H.eq(coachCalled, false, 'keySteps 模式下非关键步（无吃子/将军/大幅分差）不点评')

  // 5.5 cloudReady=false → 即便 autoCoach=on 也不自动（避免每步刷错误）
  resetSettings()
  resetCoachState(c)
  settings.setSetting('playCoachScope', 'allSteps')
  await injectResult(c)
  c.data.cloudReady = false
  c.maybeAutoCoach()
  H.eq(coachCalled, false, '无网络（cloudReady=false）时不自动点评')
  c.data.cloudReady = true

  // 5.6 autoCoach=remoteOnly + cloudReady=true → 允许点评
  resetSettings()
  resetCoachState(c)
  settings.setSetting('autoCoach', 'remoteOnly')
  settings.setSetting('playCoachScope', 'allSteps')
  await injectResult(c)
  c.maybeAutoCoach()
  H.eq(coachCalled, true, 'remoteOnly 且云端可用时允许点评')
  c.cancelCoach()

  // 还原 coachRunner
  coachRunner.runCoachComment = origRun
  settings._reset()

  /* ------------------------------------- 6. undo 回退保持玩家掌控 */
  H.section('6. 撤销：连退两步让玩家重新掌控')

  const u = createInitialPage(wxFull)
  u.data.depthIndex = 0
  u._sparrerDepth = 2
  u.setData({ sparrerDepth: 2 })
  u.onCellTap(tapEvent('e2'))
  u.onCellTap(tapEvent('e4'))
  const undone = await waitFor(() => u.data.moveCount === 2 && u.data.myTurn === true)
  H.ok(undone, '对局推进到玩家 + sparrer 两步且轮回到玩家')
  u.onUndo()
  H.eq(u.data.moveCount, 0, '一次撤销连退两步（玩家 + sparrer），回到玩家刚要走的局面')
  H.eq(u.game.getTurn(), u.data.playAs, '撤销后行棋方回到玩家')
  H.eq(u.data.myTurn, true, '撤销后轮到玩家落子')
  H.eq(u.data.canRedo, true, '撤销后可前进')

  /* ------------------------------------- 7. 强度切换 + 换边开局 */
  H.section('7. 强度切换与换边')

  const s = createPage(wxFull)
  s.onStrengthChange({ currentTarget: { dataset: { level: 'easy' } } })
  H.eq(s._sparrerDepth, 2, '切到「入门」强度 → 深度 2')
  H.eq(settings.getSetting('sparrerLevel'), 'easy', '强度切换写入设置')
  s.onStrengthChange({ currentTarget: { dataset: { level: 'strong' } } })
  H.eq(s._sparrerDepth, 4, '切到「强」强度 → 深度 4')

  // 换边：玩家执黑（按国际象棋规则，白先走 → sparrer 先着，初始轮不到玩家）
  const n = createPage(wxFull)
  n.data.depthIndex = 0
  n._sparrerDepth = 2
  n.setData({ sparrerDepth: 2 })
  n.newGame('b')
  H.eq(n.data.playAs, 'b', '换边后玩家执黑')
  H.eq(n.data.sparrerColor, 'w', '对手执白')
  H.eq(n.data.flipped, true, '玩家执黑时棋盘翻转')
  H.eq(n.data.moveCount, 0, '新开局清空历史')
  H.eq(n.data.myTurn, false, '玩家执黑时由 sparrer（白）先走，初始轮不到玩家')
  // sparrer（白）应自动先走一步，之后轮到玩家
  const firstMoved = await waitFor(() => n.data.moveCount === 1 && n.data.myTurn === true)
  H.ok(firstMoved, '玩家执黑时 sparrer 先走一步，随后轮到玩家')

  /* ------------------------------------- 8. WXML 模板静态守卫 */
  H.section('8. WXML 模板静态守卫（AGENTS.md §6.4）')

  function collectWxml(dir, acc) {
    if (!fs.existsSync(dir)) return acc
    fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
      const full = path.join(dir, d.name)
      if (d.isDirectory()) collectWxml(full, acc)
      else if (d.isFile() && d.name.endsWith('.wxml')) acc.push(full)
    })
    return acc
  }
  const wxmlFiles = []
  collectWxml(path.join(ROOT, 'pages'), wxmlFiles)
  collectWxml(path.join(ROOT, 'components'), wxmlFiles)
  const appJsonForScan = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'))
  if (Array.isArray(appJsonForScan.subpackages)) {
    appJsonForScan.subpackages.forEach(sp => {
      if (sp && sp.root) collectWxml(path.join(ROOT, sp.root), wxmlFiles)
    })
  }
  const uniqueWxml = Array.from(new Set(wxmlFiles))
  H.ok(uniqueWxml.indexOf(PLAY_WXML) !== -1, '扫描集合包含 pkg-play/play/play.wxml')
  const wxml = uniqueWxml.map(f => fs.readFileSync(f, 'utf8')).join('\n').replace(/<!--[\s\S]*?-->/g, '')

  const tags = []
  const tagRe = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let m
  while ((m = tagRe.exec(wxml))) tags.push({ name: m[1], attrs: m[2] })
  const forTags = tags.filter(t => /\bwx:for\s*=/.test(t.attrs))
  H.ok(forTags.length > 0, `找到 ${forTags.length} 处 wx:for`)

  const leaningIndex = attrs => (attrs.match(/\{\{[^}]*\}\}/g) || []).filter(e => /\bindex\b/.test(e))
  H.ok(leaningIndex('<view wx:for="{{list}}" wx:key="key" data-i="{{index}}">').length === 1,
    '守卫能抓到插值里裸用 index')
  H.eq(leaningIndex('<view wx:for="{{list}}" wx:key="key" data-index="{{item.idx}}">').length, 0,
    '守卫不误伤 data-index 属性名与 item.idx 字段')
  H.eq(forTags.filter(t => leaningIndex(t.attrs).length > 0).length, 0,
    'wx:for 元素自身属性里没有引用循环变量 index')

  const allKeyValues = []
  const keyRe = /wx:key\s*=\s*"([^"]*)"/g
  while ((m = keyRe.exec(wxml))) allKeyValues.push(m[1])
  H.ok(allKeyValues.length > 0, `收集到 ${allKeyValues.length} 个 wx:key`)
  const badKeys = allKeyValues.filter(k => !/^[a-zA-Z_][\w]*$/.test(k))
  H.eq(badKeys.length, 0, '所有 wx:key 都是字符串字段名（没有数字、没有 *this）')
  if (badKeys.length) console.log('      违规 wx:key：' + badKeys.join(', '))

  H.eq(/<block[\s>]/.test(wxml), false, '没有使用 <block>')

  // 数据层：play 专属列表自带字符串 key
  const sample = createInitialPage(wxFull)
  H.ok(sample.data.tabs.every(t => typeof t.key === 'string'), 'tabs 自带字符串 key')
  H.ok(sample.data.sideOptions.every(o => typeof o.key === 'string'), 'sideOptions 自带字符串 key')
  H.ok(sample.data.strengthOptions.every(o => typeof o.key === 'string'), 'strengthOptions 自带字符串 key')
  H.ok(sample.data.moveRows.length === 0 || sample.data.moveRows.every(r => typeof r.key === 'string'),
    'moveRows 自带字符串 key')
  H.ok(sample.data.cells.every(c => typeof c.sq === 'string'), 'cells 自带字符串 sq')

  /* ------------------------------------- 9. app.json 配置守卫 */
  H.section('9. 配置守卫')

  const appJsonText = fs.readFileSync(APP_JSON, 'utf8')
  const appJson = JSON.parse(appJsonText)
  H.eq(appJson.lazyCodeLoading, 'requiredComponents', 'app.json 保留了 lazyCodeLoading')
  H.ok(Array.isArray(appJson.pages) && appJson.pages.indexOf('pages/landing/landing') !== -1,
    '主包 pages 包含 Landing 首页')
  H.ok(Array.isArray(appJson.subpackages) &&
    appJson.subpackages.some(sp => sp.root === 'pkg-analyze' && sp.pages.indexOf('analyze/analyze') !== -1),
    'subpackages 包含 pkg-analyze/analyze（分析已分包化）')
  H.ok(Array.isArray(appJson.subpackages) &&
    appJson.subpackages.some(sp => sp.root === 'pkg-play' && sp.pages.indexOf('play/play') !== -1),
    'subpackages 包含 pkg-play/play（对弈已分包化，L2-T6）')
  H.ok(!(appJson.pages || []).some(p => p.indexOf('pkg-play') === 0),
    '对弈分包页面不重复列在主包 pages 里')

  sessionStore.reset()
  ai.setEngineMode('local')

  return H.summary('play-page.test.js')
}

main().then(green => {
  if (!green) process.exit(1)
}).catch(err => {
  console.error('\n测试脚本自身异常：', err)
  process.exit(1)
})
