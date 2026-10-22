/**
 * landing.test.js
 * Landing 首页（主包）回归：四张模式卡片渲染与导航目标、卡片点击 navigateTo、
 * 剪贴板自动导入（onShow → 确认 → 跳 analyze 页并带 fen）、以及共享剪贴板纯函数。
 *
 * 用 node 跑：
 *   node .workbuddy/tests/landing.test.js
 */
'use strict'

const path = require('path')
const H = require('./_harness')

const ROOT = path.join(__dirname, '..', '..')
const LANDING_PAGE = path.join(ROOT, 'pages', 'landing', 'landing.js')

const { isValidFen, extractFen } = require(path.join(ROOT, 'utils', 'game.js'))
const debugLog = require(path.join(ROOT, 'utils', 'debug-log.js'))

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

let captured = null
function installGlobals(wxStub) {
  global.wx = wxStub
  global.Page = function (options) { captured = options }
  captured = null
  if (typeof global.window !== 'undefined') delete global.window
  if (typeof global.document !== 'undefined') delete global.document
}

function loadLanding() {
  delete require.cache[require.resolve(LANDING_PAGE)]
  captured = null
  require(LANDING_PAGE)
  if (!captured) throw new Error('Landing 没有调用 Page()')
  return captured
}

function createLanding(wxStub) {
  installGlobals(wxStub)
  const opts = loadLanding()
  const page = Object.assign({}, opts)
  page.data = JSON.parse(JSON.stringify(opts.data))
  page.setData = function (patch) { Object.assign(this.data, patch) }
  opts.onLoad.call(page)
  return page
}

/** 造一个带 getClipboardData + showModal + navigateTo 的 wx 桩 */
function makeWx(clipboardData, modalConfirm) {
  const calls = { navigateTo: 0, getClipboardData: 0, showModal: 0 }
  return {
    request() {},
    setClipboardData(o) { if (o && o.success) o.success() },
    getAccountInfoSync() { return { miniProgram: { appId: 'wxtest' } } },
    navigateTo(o) { calls.navigateTo++; this.__lastUrl = o && o.url },
    getClipboardData(o) { calls.getClipboardData++; if (o && o.success) o.success({ data: clipboardData }) },
    showModal(o) { calls.showModal++; if (o && o.success) o.success({ confirm: !!modalConfirm }) },
    __calls: calls
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  /* ------------------------------------------------- 1. 卡片渲染与导航目标 */
  H.section('1. Landing 卡片渲染与导航目标')

  const wxStub = makeWx('', false)
  const p = createLanding(wxStub)
  H.eq(p.data.cards.length, 4, '四张模式卡片')
  H.ok(p.data.cards.every(c => typeof c.key === 'string'), '每张卡片自带字符串 key（wx:key 合规）')
  const analyze = p.data.cards.find(c => c.mode === 'analyze')
  H.ok(analyze && analyze.ready === true, '分析棋局卡片已就绪')
  H.ok(analyze && analyze.url.indexOf('/pages/analyze/analyze?mode=analyze') === 0, '分析卡片指向 analyze 页')
  const notReady = p.data.cards.filter(c => !c.ready)
  H.eq(notReady.length, 1, '只剩「学习」一张仍为即将上线（对弈 L2-T6 / 打谱 L2-T7 已落地）')
  H.ok(notReady.every(c => c.url.indexOf('/pages/placeholder/placeholder') === 0), '未就绪卡片指向占位页')
  const play = p.data.cards.find(c => c.mode === 'play')
  H.ok(play && play.ready === true, '对弈卡片已就绪（L2-T6 落地）')
  H.ok(play && play.url.indexOf('/pages/play/play?mode=play') === 0, '对弈卡片指向 play 页')
  const replay = p.data.cards.find(c => c.mode === 'replay')
  H.ok(replay && replay.ready === true, '打谱卡片已就绪（L2-T7 落地）')
  H.ok(replay && replay.url.indexOf('/pages/replay/replay?mode=replay') === 0, '打谱卡片指向 replay 页')

  /* ------------------------------------------------- 2. 卡片点击 navigateTo */
  H.section('2. 卡片点击 navigateTo')

  const nav = makeWx('', false)
  const p2 = createLanding(nav)
  p2.onCardTap({ currentTarget: { dataset: { url: '/pages/analyze/analyze?mode=analyze' } } })
  H.eq(nav.__calls.navigateTo, 1, '点击分析卡片触发一次 navigateTo')
  H.ok(nav.__lastUrl.indexOf('/pages/analyze/analyze') === 0, '跳转到 analyze 页')
  p2.onSettingsTap()
  H.eq(nav.__calls.navigateTo, 2, '设置入口也触发 navigateTo')

  /* ------------------------------------- 3. 剪贴板自动导入（确认 → 跳 analyze 带 fen） */
  H.section('3. 剪贴板自动导入（onShow → 确认 → 跳 analyze 带 fen）')

  const clip = makeWx(INITIAL_FEN, true)
  const p3 = createLanding(clip)
  p3.onShow()
  await sleep(30) // autoImportFenFromClipboard 是异步链，等待 navigateTo 被调用
  H.eq(clip.__calls.showModal, 1, '检测到 FEN 弹一次确认框')
  H.eq(clip.__calls.navigateTo, 1, '确认后跳转到分析页')
  H.ok(clip.__lastUrl.indexOf('/pages/analyze/analyze?mode=analyze&fen=') === 0, '跳转带 fen 参数')
  H.ok(clip.__lastUrl.indexOf(encodeURIComponent(INITIAL_FEN)) !== -1, 'fen 经编码传入')

  /* --------------------------------------------- 4. 剪贴板无 FEN 不跳转 */
  H.section('4. 剪贴板无 FEN 不跳转')

  const clipNone = makeWx('闲聊文字，没有棋局', true)
  const p4 = createLanding(clipNone)
  p4.onShow()
  await sleep(30)
  H.eq(clipNone.__calls.navigateTo, 0, '剪贴板无 FEN 不跳转')
  H.eq(clipNone.__calls.showModal, 0, '剪贴板无 FEN 不弹窗')

  /* --------------------------------------------- 5. 剪贴板纯函数（复用 game.js） */
  H.section('5. 剪贴板导入纯函数（复用 game.js）')

  H.ok(isValidFen(INITIAL_FEN), 'isValidFen 接受完整 FEN')
  H.ok(!isValidFen('这不是 FEN'), 'isValidFen 拒绝乱码')
  H.ok(extractFen('前缀 ' + INITIAL_FEN + ' 后缀').indexOf('RNBQKBNR') !== -1, 'extractFen 从混排文本抽取')

  /* ---------------------------- 6. 跳转失败显形 + 复制反馈（预览没有剪贴板） */
  H.section('6. 跳转失败显形与复制反馈')

  const navFail = makeWx('', false)
  navFail.navigateTo = o => { if (o && o.fail) o.fail({ errMsg: 'navigationTo: fail 未找到页面' }) }
  const p6 = createLanding(navFail)
  p6.onCardTap({ currentTarget: { dataset: { url: '/pages/play/play?mode=play' } } })
  H.ok(p6.data.navError.indexOf('未找到页面') !== -1, '跳转全部失败时界面显示原因（不静默）')
  H.ok(p6.data.navError.indexOf('pages/play/play') !== -1, '显形文案里带上试过的 url')
  H.ok(p6.data.navError.indexOf('尝试过') !== -1, '显形文案里列出尝试清单')
  p6.onCopyNavError()
  H.eq(p6.data.copyHint, '已复制到剪贴板', '有剪贴板能力时给出复制成功反馈')

  const noClip = makeWx('', false)
  // 注意：这里必须让 navigateTo 明确失败，原版桩是「既不回调 success 也不回调 fail」的空实现，
  // 那种情况导航层会等看门狗超时才上报，同步断言拿不到 navError。
  noClip.navigateTo = o => { if (o && o.fail) o.fail({ errMsg: 'navigationTo: fail 未找到页面' }) }
  delete noClip.setClipboardData
  const p7 = createLanding(noClip)
  p7.onCardTap({ currentTarget: { dataset: { url: '/pages/play/play?mode=play' } } })
  p7.onCopyNavError()
  H.ok(p7.data.copyHint.indexOf('长按') !== -1, '没有剪贴板能力时改为提示长按选中（不再无反应）')
  p7.onDismissNavError()
  H.eq(p7.data.navError, '', '关闭后错误文案清空')
  H.eq(p7.data.copyHint, '', '关闭后提示一并清空')

  /* ------------------------------------- 7. 调试模式：运行日志 + 能力探测 */
  H.section('7. 调试模式（运行日志 + 环境能力探测）')

  const dbg = makeWx('', false)
  delete dbg.setEnableDebug
  const p8 = createLanding(dbg)
  H.eq(p8.data.debugOpen, false, '调试面板默认收起')
  p8.onToggleDebug()
  H.eq(p8.data.debugOpen, true, '点一下展开')
  H.eq(p8.data.envRows.length, 10, '列出 10 个宿主接口的探测结果')
  const navRow = p8.data.envRows.find(r => r.name === 'navigateTo')
  H.ok(navRow && navRow.ok === true, '已实现的接口标为可用')
  const missingRow = p8.data.envRows.find(r => r.name === 'setEnableDebug')
  H.ok(missingRow && missingRow.ok === false, '缺失的接口标为不可用（预览是子集实现）')
  H.ok(p8.data.envRows.every(r => typeof r.key === 'string'), '探测项自带字符串 key（wx:key 合规）')
  H.ok(p8.data.debugCount > 0, '运行日志里至少有 Landing 加载那条')
  H.ok(p8.data.debugText.indexOf('[页面] Landing 已加载') !== -1, '纯文本备份含加载日志（可长按选中）')
  H.ok(p8.data.debugRows.length === p8.data.debugCount, '列表与计数一致')
  H.ok(p8.data.debugRows.every(r => typeof r.levelClass === 'string'), '每条日志带等级样式类')
  p8.onCopyDebug()
  H.eq(p8.data.debugHint, '日志已复制', '复制日志给出反馈')
  p8.onClearDebug()
  H.eq(p8.data.debugCount, 0, '清空后计数归零')
  H.eq(p8.data.debugRows.length, 0, '清空后列表为空')

  /* ------------------------- 8. 导航过程进入运行日志（调试面板里能看到） */
  H.section('8. 导航过程进入运行日志')

  debugLog.clear()
  const okNav = makeWx('', false)
  okNav.navigateTo = o => { if (o && o.success) o.success({}) }
  const p9 = createLanding(okNav)
  p9.onCardTap({ currentTarget: { dataset: { url: '/pages/play/play?mode=play' } } })
  H.ok(debugLog.text().indexOf('[导航] 成功') !== -1, '成功时日志记下结论')
  H.ok(debugLog.text().indexOf('第 1 种形式') !== -1, '原生环境第一次就成功（参数完整）')

  debugLog.clear()
  const badNav = makeWx('', false)
  badNav.navigateTo = o => { if (o && o.fail) o.fail({ errMsg: 'navigationTo: fail 未找到页面' }) }
  const p10 = createLanding(badNav)
  p10.onCardTap({ currentTarget: { dataset: { url: '/pages/play/play?mode=play' } } })
  H.ok(debugLog.text().indexOf('[导航] 失败') !== -1, '失败时日志记下失败原因')
  H.ok(debugLog.text().indexOf('[导航] 试过') !== -1, '每一种失败的形式都逐条记进日志')

  /* ------------------------- 9. 引擎连通性探测（只读诊断） */
  H.section('9. 引擎连通性探测')

  const remoteEngine = require(path.join(ROOT, 'utils', 'remote-engine.js'))
  const engineBefore = remoteEngine.state()

  // 9a. 宿主收了请求却永不回调：必须靠自己的计时器兜底，界面不能一直「探测中」
  const hangWx = makeWx('', false)
  hangWx.request = function () { return {} }
  const p11 = createLanding(hangWx)
  p11._probeTimeoutMs = 60
  p11.onProbeEngine()
  H.ok(p11.data.probing === true, '先置「探测中」，重复点击会被挡掉')
  await sleep(300)
  H.ok(p11.data.probing === false, '超时后复位探测中状态（不会一直转）')
  H.ok(p11.data.engineHint.indexOf('不回调') !== -1, '宿主不回调时给出可读原因')
  H.eq(p11.data.engineRows.length, 3, '端点 + healthz + /v1 三行')
  H.ok(p11.data.engineRows.every(r => typeof r.levelClass === 'string'), '每行都带样式类（模板直接渲染）')
  H.ok(p11.data.engineRows.some(r => r.level === 'error'), '失败行标为错误')

  // 9b. 两条都通：healthz 与 /v1 都给出可核对的细节
  const goodWx = makeWx('', false)
  goodWx.request = function (o) {
    if (o.url.indexOf('/healthz') !== -1) {
      o.success({ statusCode: 200, data: { status: 'ok', engine: { version: 'Stockfish 15.1' }, pool: { size: 8, idle: 8 } } })
    } else {
      o.success({ statusCode: 200, data: { type: 'bestmove', lines: [{ rank: 1, san: 'd4', uci: 'd2d4', scoreCp: 20 }] } })
    }
  }
  const p12 = createLanding(goodWx)
  p12.onProbeEngine()
  await sleep(200)
  H.ok(p12.data.engineHint === '通', '两条都通时结论就是「通」')
  const goodText = JSON.stringify(p12.data.engineRows)
  H.ok(goodText.indexOf('Stockfish 15.1') !== -1, 'healthz 行带引擎版本（可直接核对连的是哪台）')
  H.ok(goodText.indexOf('d4') !== -1, 'v1 行带最佳着法（证明真的算了一步）')

  // 9c. 沙箱路径白名单：预览面板的典型失败
  const blockedWx = makeWx('', false)
  blockedWx.request = function (o) { o.fail({ errMsg: 'request:fail path not allowed' }) }
  const p13 = createLanding(blockedWx)
  p13.onProbeEngine()
  await sleep(200)
  H.ok(p13.data.engineHint.indexOf('只放行特定路径') !== -1, '识别为宿主路径白名单')

  // 9d. 域名白名单：真机 / 体验版的典型失败
  const domainWx = makeWx('', false)
  domainWx.request = function (o) { o.fail({ errMsg: 'request:fail url not in domain list' }) }
  const p14 = createLanding(domainWx)
  p14.onProbeEngine()
  await sleep(200)
  H.ok(p14.data.engineHint.indexOf('合法域名白名单') !== -1, '识别为域名白名单')

  // 9e. 探测必须只读：不得改动引擎的熔断/屏蔽状态
  const engineAfter = remoteEngine.state()
  H.eq(engineAfter.failStreak, engineBefore.failStreak, '探测不改熔断计数')
  H.eq(engineAfter.permanentlyBlocked, engineBefore.permanentlyBlocked, '探测不改永久屏蔽标记')

  return H.summary('landing.test.js')
}

main().then(green => {
  if (!green) process.exit(1)
}).catch(err => {
  console.error('\n测试脚本自身异常：', err)
  process.exit(1)
})
