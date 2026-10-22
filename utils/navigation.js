/**
 * utils/navigation.js · 页面跳转统一封装（带 url 形式自适配 + 失败显形）
 *
 * 为什么需要它：
 *   WorkBuddy 内置预览对小程序只实现 wx 接口的一个子集（见预览兼容笔记），
 *   实测在本项目里 `navigateTo({url:'/pages/placeholder/placeholder?title=…'})`
 *   会 fail「未找到页面」——**连主包页面也找不到**，因此不是分包问题，而是
 *   运行时对 url 形式的解析与微信原生不同（最可能是把整串 url 含 query 当页面 key，
 *   或只认不带前导 `/` 的形式）。
 *
 * 2026-10-22 晚更新：四种形式在预览里全部失败，项目已**放弃分包**，三个模式页
 * 移入主包 `pages`（`pages/analyze|play|replay`）。若单包下仍全部失败，则说明该
 * 宿主根本没有多页导航能力，代码侧无解 —— 只能换环境验证（微信开发者工具 / 真机）。
 * 候选形式与参数补齐逻辑保留：它不改变原生行为，且是「宿主差异」的显形抓手。
 *
 * 策略：不猜它到底认哪一种，改为「按候选形式依次尝试，任一成功即停」：
 *   1. 原样           /pages/play/play?mode=play
 *   2. 去掉 query     /pages/play/play
 *   3. 相对路径（去前导 /，保留 query）  pages/play/play?mode=play
 *   4. 相对路径 + 去 query                pages/play/play
 * 全部失败再退 redirectTo / reLaunch（页面栈满时本来也该这么做），
 * 仍失败则回调 onFail({ errMsg, tried }) 由页面显形——不许静默降级。
 *
 * 参数怎么不丢：一旦走的是「不带 query」的形式，query 解析结果写进
 * sessionStore.pendingParams，目标页 onLoad 用 mergeLaunchOptions(options) 取回。
 * 写在前置（点击时）而不是 success 里——微信新页面 onLoad 早于 success 回调。
 *
 * 不依赖 wx / DOM：host 可注入，纯 Node 可测（.workbuddy/tests/navigation.test.js）。
 */
const { sessionStore } = require('./session-store')

/**
 * 环境既不回调 success 也不回调 fail 时的上报时限。
 * 这时**不继续盲试下一个 url**：可能其实已经跳走了，再试会重复跳页。
 */
const NO_CALLBACK_MS = 1500

function stripQuery(url) {
  const i = url.indexOf('?')
  return i < 0 ? url : url.slice(0, i)
}

function hasQuery(url) {
  return url.indexOf('?') >= 0
}

function relativeUrl(url) {
  return url.replace(/^\/+/, '')
}

/** url 的 query → 普通对象（值已 decode；解析失败保留原文） */
function parseQuery(url) {
  if (!hasQuery(url)) return null
  const out = {}
  const raw = url.slice(url.indexOf('?') + 1)
  raw.split('&').forEach(pair => {
    if (!pair) return
    const eq = pair.indexOf('=')
    const key = eq < 0 ? pair : pair.slice(0, eq)
    const val = eq < 0 ? '' : pair.slice(eq + 1)
    if (!key) return
    let k = key
    let v = val
    try { k = decodeURIComponent(key) } catch (e) { /* 保留原文 */ }
    try { v = decodeURIComponent(val) } catch (e) { /* 保留原文 */ }
    out[k] = v
  })
  return Object.keys(out).length ? out : null
}

/** 候选 url 列表（去重，顺序即尝试顺序；参数完整的排前面） */
function candidates(url) {
  const list = []
  const push = u => { if (u && list.indexOf(u) < 0) list.push(u) }
  push(url)
  push(stripQuery(url))
  push(relativeUrl(url))
  push(relativeUrl(stripQuery(url)))
  return list
}

function errMsgOf(err) {
  if (!err) return ''
  if (typeof err === 'string') return err
  if (err.errMsg) return String(err.errMsg)
  if (err.message) return String(err.message)
  try { return JSON.stringify(err) } catch (e) { return '' }
}

function defaultHost() {
  return typeof wx !== 'undefined' ? wx : null
}

/**
 * 跳转到目标页。
 * @param {string} url 绝对路径（可带 query），如 '/pages/play/play?mode=play'
 * @param {{host?:object, onFail?:function, onSuccess?:function}} [opts]
 *        host 缺省取全局 wx；onFail({reason,errMsg,tried}) 由页面负责显示；
 *        onSuccess({url,attempts,via}) 报告「第几种形式成功了」——排查环境差异时这是唯一证据
 * @returns {boolean} 是否至少发出了第一次跳转请求
 */
function navigate(url, opts) {
  opts = opts || {}
  const host = opts.host || defaultHost()
  const onFail = typeof opts.onFail === 'function' ? opts.onFail : function () {}
  const onSuccess = typeof opts.onSuccess === 'function' ? opts.onSuccess : function () {}

  if (!url) {
    onFail({ reason: 'empty-url', errMsg: '未提供跳转目标', tried: [] })
    return false
  }
  if (!host || typeof host.navigateTo !== 'function') {
    onFail({ reason: 'no-api', errMsg: '当前环境没有页面跳转能力', tried: [] })
    return false
  }

  const list = candidates(url)
  const params = parseQuery(url)
  const tried = []
  // 每次跳转前重置：即便这次全部失败，也不让上一次的参数残留到下一次
  if (typeof sessionStore.setPendingParams === 'function') sessionStore.setPendingParams(params)

  function finishFail(reason, errMsg) {
    onFail({ reason: reason, errMsg: errMsg, tried: tried.slice() })
  }

  function attempt(i) {
    if (i >= list.length) return fallback()

    const u = list[i]
    let settled = false
    let timer = null
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }

    const succeed = () => {
      if (settled) return
      settled = true
      clearTimer()
      onSuccess({ url: u, attempts: i + 1 })
    }
    const fail = err => {
      if (settled) return
      settled = true
      clearTimer()
      tried.push({ url: u, errMsg: errMsgOf(err) })
      attempt(i + 1)
    }

    try {
      host.navigateTo({ url: u, success: succeed, fail: fail })
    } catch (e) {
      fail(e)
      return true
    }

    timer = setTimeout(() => {
      if (settled) return
      settled = true
      // 只上报，不推进：无法区分「静默成功」与「静默失败」，宁可停在这里
      finishFail('no-callback', '点击后没有响应（' + u + '）')
    }, NO_CALLBACK_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return true
  }

  /** navigateTo 全形式失败：退 redirectTo（也解决页面栈满）→ reLaunch */
  function fallback() {
    const chain = ['redirectTo', 'reLaunch'].filter(fn => typeof host[fn] === 'function')
    if (!chain.length) return finishFail('all-failed', '未找到页面')

    let idx = 0
    const step = () => {
      if (idx >= chain.length) return finishFail('all-failed', '未找到页面')
      const fnName = chain[idx++]
      const u = list[0]
      let settled = false
      const next = err => {
        if (settled) return
        settled = true
        tried.push({ url: u, via: fnName, errMsg: errMsgOf(err) })
        step()
      }
      try {
        host[fnName]({
          url: u,
          success: () => {
            settled = true
            onSuccess({ url: u, attempts: tried.length + 1, via: fnName })
          },
          fail: next
        })
      } catch (e) {
        next(e)
      }
    }
    step()
    return true
  }

  return attempt(0)
}

/**
 * 目标页 onLoad 用：把导航层暂存的参数并入 options。
 * 页面显式收到的 query 优先于暂存值（原生环境走的是带 query 的 url，暂存一般为空）。
 */
function mergeLaunchOptions(options) {
  const base = options || {}
  const pending = typeof sessionStore.takePendingParams === 'function'
    ? sessionStore.takePendingParams()
    : null
  if (!pending) return base
  return Object.assign({}, pending, base)
}

/** 把 onFail 的回执整理成界面上可读、可复制的一行说明 */
function describeFailure(info) {
  info = info || {}
  const tried = Array.isArray(info.tried) ? info.tried : []
  const parts = tried.map(t => {
    const via = t.via ? t.via + ' ' : ''
    const msg = t.errMsg ? ' → ' + t.errMsg : ''
    return via + t.url + msg
  })
  const head = info.errMsg || '未找到页面'
  return parts.length ? head + '\n尝试过：\n' + parts.join('\n') : head
}

module.exports = {
  navigate,
  mergeLaunchOptions,
  describeFailure,
  // 以下导出给单测用
  candidates,
  parseQuery,
  NO_CALLBACK_MS
}
