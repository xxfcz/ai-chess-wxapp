/**
 * landing.test.js
 * Landing 首页（主包）回归：四张模式卡片渲染与导航目标、卡片点击 navigateTo、
 * 剪贴板自动导入（onShow → 确认 → 跳 analyze 分包并带 fen）、以及共享剪贴板纯函数。
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
  H.ok(analyze && analyze.url.indexOf('/pkg-analyze/analyze/analyze?mode=analyze') === 0, '分析卡片指向 analyze 分包')
  const notReady = p.data.cards.filter(c => !c.ready)
  H.eq(notReady.length, 2, '打谱/学习 两张仍为即将上线（对弈已随 L2-T6 落地）')
  H.ok(notReady.every(c => c.url.indexOf('/pages/placeholder/placeholder') === 0), '未就绪卡片指向占位页')
  const play = p.data.cards.find(c => c.mode === 'play')
  H.ok(play && play.ready === true, '对弈卡片已就绪（L2-T6 落地）')
  H.ok(play && play.url.indexOf('/pkg-play/play/play?mode=play') === 0, '对弈卡片指向 play 分包')

  /* ------------------------------------------------- 2. 卡片点击 navigateTo */
  H.section('2. 卡片点击 navigateTo')

  const nav = makeWx('', false)
  const p2 = createLanding(nav)
  p2.onCardTap({ currentTarget: { dataset: { url: '/pkg-analyze/analyze/analyze?mode=analyze' } } })
  H.eq(nav.__calls.navigateTo, 1, '点击分析卡片触发一次 navigateTo')
  H.ok(nav.__lastUrl.indexOf('/pkg-analyze/analyze/analyze') === 0, '跳转到 analyze 分包')
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
  H.ok(clip.__lastUrl.indexOf('/pkg-analyze/analyze/analyze?mode=analyze&fen=') === 0, '跳转带 fen 参数')
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

  return H.summary('landing.test.js')
}

main().then(green => {
  if (!green) process.exit(1)
}).catch(err => {
  console.error('\n测试脚本自身异常：', err)
  process.exit(1)
})
