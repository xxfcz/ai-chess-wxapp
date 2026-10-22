/**
 * navigation.test.js
 * utils/navigation.js 回归：url 候选形式自适配、丢 query 时参数经 store 补齐、
 * 全失败时显形上报（不静默）、缺 API 时给出可控错误。
 *
 * 背景（见 AGENTS.md §6 / 预览兼容笔记）：WorkBuddy 内置预览里
 * `navigateTo('/pages/placeholder/placeholder?title=…')` 会 fail「未找到页面」，
 * 连主包页面也找不到——所以导航层必须能换形式重试，而不是写死一种 url。
 *
 * 用 node 跑：
 *   node .workbuddy/tests/navigation.test.js
 */
'use strict'

const path = require('path')
const H = require('./_harness')

const ROOT = path.join(__dirname, '..', '..')
const navigation = require(path.join(ROOT, 'utils', 'navigation.js'))
const { sessionStore } = require(path.join(ROOT, 'utils', 'session-store.js'))

const PREVIEW_ERR = { errMsg: 'navigationTo: fail 未找到页面' }

/** 预览式桩：带 query 的 url 一律「未找到页面」，不带 query 的才成功（同步回调，最坏情况） */
function makePreviewWx() {
  const urls = []
  return {
    navigateTo(o) {
      urls.push(o.url)
      if (o.url.indexOf('?') >= 0) {
        if (o.fail) o.fail(PREVIEW_ERR)
      } else if (o.success) {
        o.success({})
      }
    },
    __urls: urls
  }
}

/** 全死桩：navigateTo / redirectTo / reLaunch 全部失败 */
function makeDeadWx() {
  const log = []
  const failAll = name => o => {
    log.push(name + ' ' + o.url)
    if (o.fail) o.fail(PREVIEW_ERR)
  }
  return {
    navigateTo: failAll('navigateTo'),
    redirectTo: failAll('redirectTo'),
    reLaunch: failAll('reLaunch'),
    __log: log
  }
}

async function main() {
  sessionStore.reset()

  /* ---------------------------------------------------- 1. 候选 url 形式 */
  H.section('1. 候选 url 形式（顺序即尝试顺序）')

  const cands = navigation.candidates('/pages/play/play?mode=play')
  H.eq(cands.length, 4, '四种候选形式（绝对/去 query/相对/相对去 query）')
  H.eq(cands[0], '/pages/play/play?mode=play', '第 1 个原样：绝对路径 + query（原生首选，参数完整）')
  H.eq(cands[1], '/pages/play/play', '第 2 个去 query')
  H.eq(cands[2], 'pages/play/play?mode=play', '第 3 个相对路径（去前导 /，保留参数）')
  H.eq(cands[3], 'pages/play/play', '第 4 个相对路径 + 去 query')

  const noQuery = navigation.candidates('/pages/landing/landing')
  H.eq(noQuery.length, 2, '无 query 时候选去重为 2 个（不产生重复项）')

  /* ------------------------------------------------ 2. query 解析（含中文/编码） */
  H.section('2. query 解析')

  const q = navigation.parseQuery('/pages/placeholder/placeholder?title=%E5%AD%A6%E4%B9%A0&desc=a%26b')
  H.eq(q.title, '学习', '中文参数正确解码')
  H.eq(q.desc, 'a&b', '编码的 & 不被当成参数分隔')
  H.eq(navigation.parseQuery('/pages/landing/landing'), null, '无 query 返回 null')

  /* --------------------- 3. 预览式环境：带 query 失败 → 去 query 成功，参数不丢 */
  H.section('3. 预览式环境：换形式重试 + 参数经 store 补齐')

  sessionStore.reset()
  const preview = makePreviewWx()
  let failed = null
  let successInfo = null
  const ok1 = navigation.navigate('/pages/analyze/analyze?mode=analyze&fen=' + encodeURIComponent('8/8/8/8/8/8/8/K6k w - - 0 1'), {
    host: preview,
    onFail: info => { failed = info },
    onSuccess: info => { successInfo = info }
  })
  H.eq(ok1, true, '发出了跳转请求')
  H.eq(failed, null, '最终成功，不触发 onFail')
  H.eq(preview.__urls.length, 2, '先试带 query 再退到不带 query（共 2 次）')
  H.ok(preview.__urls[0].indexOf('?') > 0, '第 1 次带 query')
  H.ok(preview.__urls[1].indexOf('?') < 0, '第 2 次不带 query')
  H.eq(successInfo && successInfo.attempts, 2, 'onSuccess 报告「第 2 种形式成功」（排查宿主差异的关键证据）')
  H.eq(successInfo && successInfo.url, '/pages/analyze/analyze', 'onSuccess 报告实际生效的 url')

  const merged = navigation.mergeLaunchOptions({})
  H.eq(merged.mode, 'analyze', 'mode 参数经 store 补齐（页面行为不变）')
  H.eq(merged.fen, '8/8/8/8/8/8/8/K6k w - - 0 1', 'fen 参数（含空格）完整送达')
  H.eq(navigation.mergeLaunchOptions({}).mode, undefined, '参数是一次性送达，取后清空')

  /* ------------------------------------------- 4. 显式 options 优先于暂存参数 */
  H.section('4. 显式 options 优先于暂存参数')

  sessionStore.reset()
  const preview2 = makePreviewWx()
  navigation.navigate('/pages/placeholder/placeholder?title=%E5%AD%A6%E4%B9%A0', { host: preview2 })
  const merged2 = navigation.mergeLaunchOptions({ title: '显式标题' })
  H.eq(merged2.title, '显式标题', '页面真正收到的 query 优先')

  /* ------------------------------------------- 5. 全形式失败：显形上报 */
  H.section('5. 全形式失败：显形上报（不静默）')

  sessionStore.reset()
  const dead = makeDeadWx()
  let failInfo = null
  navigation.navigate('/pages/play/play?mode=play', {
    host: dead,
    onFail: info => { failInfo = info }
  })
  H.ok(!!failInfo, '全部失败时回调 onFail')
  H.eq(failInfo.reason, 'all-failed', 'reason 标明是全部形式都失败')
  H.eq(failInfo.errMsg, '未找到页面', 'errMsg 为可读文案')
  H.eq(failInfo.tried.length, 6, '记录了 4 次 navigateTo + 2 次兜底（redirectTo/reLaunch）')
  H.ok(failInfo.tried[0].errMsg.indexOf('未找到页面') !== -1, '逐条保留原始 errMsg')

  const text = navigation.describeFailure(failInfo)
  H.ok(text.indexOf('尝试过') !== -1, 'describeFailure 给出尝试清单（可直接复制排查）')
  H.ok(text.indexOf('redirectTo') !== -1, '清单里标出兜底通道')

  /* ------------------------------- 5.1 兜底通道成功时也要报告（via 标明走的哪条） */
  H.section('5.1 兜底通道（redirectTo）成功也报告')

  sessionStore.reset()
  const redirectOnly = {
    navigateTo(o) { if (o.fail) o.fail(PREVIEW_ERR) },
    redirectTo(o) { if (o.success) o.success({}) }
  }
  let viaInfo = null
  let redirectFailed = null
  navigation.navigate('/pages/placeholder/placeholder', {
    host: redirectOnly,
    onFail: info => { redirectFailed = info },
    onSuccess: info => { viaInfo = info }
  })
  H.eq(redirectFailed, null, 'navigateTo 全失败后由 redirectTo 接住，不算失败')
  H.eq(viaInfo && viaInfo.via, 'redirectTo', 'onSuccess 标明 via=redirectTo')

  /* --------------------------------------------------- 6. 缺能力/空目标 */
  H.section('6. 缺能力与空目标：可控错误，不抛异常')

  let noApi = null
  H.doesNotThrow(() => {
    navigation.navigate('/pages/landing/landing', { host: {}, onFail: info => { noApi = info } })
  }, '环境没有 navigateTo 时不抛错')
  H.eq(noApi && noApi.reason, 'no-api', '回调 reason=no-api')

  let empty = null
  navigation.navigate('', { host: makePreviewWx(), onFail: info => { empty = info } })
  H.eq(empty && empty.reason, 'empty-url', '空 url 直接回调 empty-url')

  /* ----------------------------- 7. 空实现（既不回调 success 也不回调 fail） */
  H.section('7. 空实现：不盲试下一个 url（避免重复跳页）')

  const silentUrls = []
  const silent = { navigateTo(o) { silentUrls.push(o.url) } }
  let silentFail = null
  navigation.navigate('/pages/play/play?mode=play', { host: silent, onFail: info => { silentFail = info } })
  H.eq(silentUrls.length, 1, '只发了一次请求，没有连发 4 次')
  H.eq(silentFail, null, '超时前不上报（交给 ' + navigation.NO_CALLBACK_MS + 'ms 看门狗）')

  /* ------------------------------- 8. store 每次跳转前重置，不残留上一次参数 */
  H.section('8. 参数不跨次残留')

  sessionStore.reset()
  navigation.navigate('/pages/play/play?mode=play', { host: makePreviewWx() })
  sessionStore.setPendingParams(null)          // 模拟目标页未取走就返回
  navigation.navigate('/pages/landing/landing', { host: makePreviewWx() })
  H.eq(sessionStore.takePendingParams(), null, '无 query 的跳转会把暂存参数清空，不串到下一次')

  return H.summary('navigation.test.js')
}

main().then(green => {
  if (!green) process.exit(1)
}).catch(err => {
  console.error('\n测试脚本自身异常：', err)
  process.exit(1)
})
