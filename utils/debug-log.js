/**
 * debug-log.js
 * 一个很小的运行日志缓冲：把 console 输出和未捕获错误收进内存环形队列，
 * 供页面上的「运行日志」卡片展示 / 一键复制。
 *
 * 为什么需要：网页版预览面板里没有可以翻看的控制台，真机上更看不到 console；
 * 但排查问题恰恰需要那几行细节（错误码、底层原因、请求耗时）。
 * 把日志放在界面里，用户可以自己看，也能直接复制出来贴给他人。
 *
 * 只保留最近 MAX_ENTRIES 条，每条截断长度，避免占内存。
 */

const MAX_ENTRIES = 60
const MAX_TEXT = 320

const entries = []
const listeners = []
let seq = 0
let installed = false
let originalConsole = null
const originalMethods = {}

function pad(value) {
  const n = String(value)
  return n.length >= 2 ? n : '0' + n
}

function nowText() {
  const d = new Date()
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

/** 把任意数量的参数拼成一行可读文本 */
function formatArgs(args) {
  const parts = []
  for (let i = 0; i < args.length; i++) {
    parts.push(formatValue(args[i]))
  }
  return parts.join(' ').slice(0, MAX_TEXT)
}

function formatValue(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const type = typeof value
  if (type === 'string') return value
  if (type === 'number' || type === 'boolean') return String(value)
  if (type === 'function') return '[function ' + (value.name || 'anonymous') + ']'
  if (value instanceof Error) return value.name + ': ' + value.message
  try {
    return JSON.stringify(value)
  } catch (e) {
    return '[unserializable ' + type + ']'
  }
}

function notify() {
  for (let i = 0; i < listeners.length; i++) {
    try {
      listeners[i]()
    } catch (e) {
      // 监听器异常不影响日志本身
    }
  }
}

/**
 * 记一条日志。
 * @param {'log'|'info'|'warn'|'error'} level
 * @param {string} text
 */
function push(level, text) {
  seq += 1
  entries.push({
    seq: seq,
    // wx:key 用字符串字段更稳
    key: 'log' + seq,
    time: nowText(),
    level: level,
    text: String(text === undefined || text === null ? '' : text).slice(0, MAX_TEXT)
  })
  while (entries.length > MAX_ENTRIES) entries.shift()
  notify()
}

function pushArgs(level, args) {
  push(level, formatArgs(args))
}

/** 订阅变化（页面据此刷新列表）；返回取消订阅函数 */
function subscribe(fn) {
  if (typeof fn !== 'function') return function () {}
  listeners.push(fn)
  return function () {
    const index = listeners.indexOf(fn)
    if (index !== -1) listeners.splice(index, 1)
  }
}

function list() {
  return entries.slice()
}

function text() {
  return entries.map(function (item) {
    return item.time + ' [' + item.level + '] ' + item.text
  }).join('\n')
}

function clear() {
  entries.length = 0
  notify()
}

function restore() {
  if (!originalConsole) return
  Object.keys(originalMethods).forEach(function (name) {
    originalConsole[name] = originalMethods[name]
  })
  installed = false
}

/**
 * 接管 console 与未捕获错误。重复调用安全（只装一次）。
 * @param {object} [options] { console, errorTarget }
 */
function install(options) {
  if (installed) return false
  const opts = options || {}
  const target = opts.console || (typeof console !== 'undefined' ? console : null)
  if (!target) return false
  installed = true
  originalConsole = target

  ;['log', 'info', 'warn', 'error'].forEach(function (name) {
    if (typeof target[name] !== 'function') return
    originalMethods[name] = target[name]
    target[name] = function () {
      try {
        pushArgs(name === 'info' ? 'info' : name, arguments)
      } catch (e) {
        // 记录日志本身不能影响主流程
      }
      return originalMethods[name].apply(this, arguments)
    }
  })

  // 未处理的 Promise 拒绝：小程序基础库 2.10.0+ 提供
  try {
    if (typeof wx !== 'undefined' && typeof wx.onUnhandledRejection === 'function') {
      wx.onUnhandledRejection(function (res) {
        const reason = res && res.reason
        push('error', '未处理的 Promise 拒绝：' + formatValue(reason))
      })
    }
  } catch (e) {
    // 环境不支持则忽略
  }

  return true
}

/** 记一条「给排查用的上下文」，统一成 error 级别便于一眼看到 */
function fail(scope, err, extra) {
  const parts = []
  if (scope) parts.push('[' + scope + ']')
  parts.push(formatValue(err))
  if (extra) parts.push(formatValue(extra))
  push('error', parts.join(' '))
}

module.exports = {
  install,
  restore,
  push,
  fail,
  list,
  text,
  clear,
  subscribe,
  formatArgs,
  MAX_ENTRIES
}
