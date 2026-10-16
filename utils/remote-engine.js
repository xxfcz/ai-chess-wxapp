/**
 * remote-engine.js
 * 远端引擎适配层（能力开关 `engine: remote`）。
 *
 * 职责：把自建 ai-chess-server（Stockfish）的 `POST /v1` 响应，
 * 映射成端上 `engine.js#analyze()` 的同一份契约；远端不可用时自动回落本地引擎，
 * 并把「这次结果到底来自哪里」写进结果里，供界面显形。
 *
 * 三条硬约束（docs/远端引擎接入方案-chess-api.md D15 / D16 + AGENTS.md §8）：
 *   1. **远端失败必须回落本地** —— 端上分析是「四条保底通道」之一，任何环境都要能出结果；
 *   2. **回落必须显形** —— 结果带 `source` / `degradedFrom`，界面据此标注，不许静默切换；
 *   3. **终局与非法局面本地前置拦截** —— 远端拿到终局只会回 400，不浪费这次往返。
 *
 * 判错一律看 `body.type === 'error'`（HTTP 200 也可能报错）。这条与 chess-api.com 同构，
 * 将来换上游不用改判错逻辑。
 *
 * 服务端字段口径见 E:\WorkBuddy\ai-chess-server\docs\05-小程序接入协议.md：
 *   - 顶层 `eval` / `centipawns` / `mate` 是**白方视角**，别用；
 *   - `lines[].scoreCp` / `scoreMate` 已是**行棋方视角**，直取不换算；
 *   - `lines[]` 没有 `captured`，只有顶层 `captured`（对应第 1 线）。
 */

const device = require('./device')
const { Chess } = require('./chess.js')
const localEngine = require('./engine')
const debugLog = require('./debug-log')
const engineConfig = require('./engine-config')

/**
 * 端点**不写死在这里**：由 `utils/engine-config.js` 解析，顺序是
 * 代码覆盖 > 本地缓存 > `.env`（编译进 engine-config.build.js）> 内置默认。
 * 换地址改 `.env` 后跑 `npm run config:engine` 即可，不用动本文件。
 *
 * 内置默认 = 正式环境 `https://chess.imex.de5.net`（https + 域名，满足小程序 request 合法域名要求）；
 * 开发版默认走 `.env` 里的 `ENGINE_ENDPOINT_DEV`（可以是 http + 裸 IP + 端口，
 * **只在「开发者工具 / 真机调试 + 不校验合法域名」下可用**，正式版不能用）。
 *
 * 换地址后针对旧地址的环境屏蔽判定会作废（见 configure()），熔断计数也会在下一次成功时清零。
 */
const RESOLVED = engineConfig.resolveEndpoint()
const DEFAULT_ENDPOINT = RESOLVED.endpoint
const DEFAULT_ENDPOINT_FROM = RESOLVED.from
/** 单次请求上限：正常端到端 0.3~1.0s，给到 10s 已经很宽；超时即回落本地 */
const REQUEST_TIMEOUT_MS = 10000
/** 兜底参数：UI 深度没给（或给了意外值）时用这一组 */
const DEFAULT_DEPTH = 14
const DEFAULT_THINK_MS = 500

/**
 * UI 深度 → 远端参数。端上深度只有 1~5 且棋力弱，不能直接搬给 Stockfish，
 * 这里做一次放大映射，保证「深度」选择器在远端模式下依然有可感知的差别。
 */
const DEPTH_LEVELS = {
  1: { depth: 10, think: 250 },
  2: { depth: 12, think: 300 },
  3: { depth: 14, think: 500 },
  4: { depth: 16, think: 800 },
  5: { depth: 18, think: 1200 }
}

/** 服务端参数上限（05-小程序接入协议.md §3） */
const MAX_DEPTH = 30
const MAX_THINK_MS = 5000
const MAX_VARIANTS = 5

/** 这几类是「请求本身有问题」，回落本地也救不了，直接抛给调用方 */
const LOCAL_BUG_CODES = ['INVALID_FEN', 'ILLEGAL_POSITION', 'INVALID_INPUT', 'PARAM_OUT_OF_RANGE', 'GAME_OVER']
/** 限流值得退避后再试一次；其余一次性回落 */
const RETRY_ONCE_CODES = ['RATE_LIMITED']
const RETRY_DELAY_MS = 400

/** 连续失败多少次就熔断：避免服务端挂掉时每次自动分析都干等一个超时 */
const CIRCUIT_FAILS = 2
const CIRCUIT_COOLDOWN_MS = 60000

/** 错误码 → 给用户看的原因短语（拼进 notice，不要写「云端故障」这类吓人的话） */
const REASON_TEXT = {
  RATE_LIMITED: '请求过于频繁',
  QUEUE_FULL: '排队已满',
  ENGINE_UNAVAILABLE: '暂时不可用',
  ANALYZE_TIMEOUT: '思考超时',
  BUSY: '正忙',
  TIMEOUT: '响应超时',
  NETWORK: '连接失败',
  ENV_NO_NETWORK: '当前环境不允许网络请求',
  BAD_RESPONSE: '返回内容异常',
  GATEWAY_BLOCK: '后端地址不可访问',
  CIRCUIT_OPEN: '暂时不可用'
}

let endpoint = DEFAULT_ENDPOINT
let endpointFrom = DEFAULT_ENDPOINT_FROM
let timeoutMs = engineConfig.resolveTimeoutMs() || REQUEST_TIMEOUT_MS
/** 回落实现：默认端上引擎；测试可替换成假实现，避免跑真搜索 */
let fallbackFn = null
let failStreak = 0
let circuitOpenUntil = 0
let lastCode = ''
/**
 * 环境级屏蔽：预览只允许 /.cloud/ 路径、真机微信 UA 被 CloudStudio 网关 403。
 * 这类失败不是服务端抖动，重试/熔断都没用，命中后本次会话内永久走本地，不再发请求。
 */
let permanentlyBlocked = false
let blockedNotified = false
/**
 * 引擎版本：`POST /v1` 的响应体**不带** engine 字段，只有 `GET /healthz` 给
 * （`{ engine: { version: 'Stockfish 15.1' } }`）。版本只用于徽标文案，
 * 所以只探一次、结果缓存；探测失败一律静默（徽标退化成「云端引擎」），**不影响分析**。
 */
let cachedVersion = ''
let versionProbe = null
/** 端点只在首次分析时记一条日志（来源写清楚，排查「到底连的哪个地址」就靠它） */
let endpointLogged = false

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/* ------------------------------------------------------------ 配置与状态 */

function configure(options) {
  const o = options || {}
  if (typeof o.endpoint === 'string' && o.endpoint.trim()) {
    endpoint = o.endpoint.trim().replace(/\/+$/, '')
    // 换了域名，之前针对旧域名的环境屏蔽判定作废（新域名也许能通）
    permanentlyBlocked = false
    blockedNotified = false
    // 换了服务端，版本要重新探
    cachedVersion = ''
    versionProbe = null
  }
  if (isFinite(Number(o.timeoutMs)) && Number(o.timeoutMs) > 0) {
    timeoutMs = Math.round(Number(o.timeoutMs))
  }
  if (typeof o.fallback === 'function') fallbackFn = o.fallback
}

function setFallback(fn) {
  fallbackFn = typeof fn === 'function' ? fn : null
}

/** 恢复出厂配置（自检用） */
function reset() {
  // 重新读一遍外部配置：换了生成文件或本地缓存后，reset 就能生效
  engineConfig.reload()
  const cfg = engineConfig.resolveEndpoint()
  endpoint = cfg.endpoint
  endpointFrom = cfg.from
  timeoutMs = engineConfig.resolveTimeoutMs() || REQUEST_TIMEOUT_MS
  failStreak = 0
  circuitOpenUntil = 0
  lastCode = ''
  permanentlyBlocked = false
  blockedNotified = false
  cachedVersion = ''
  versionProbe = null
}

/** 熔断是否生效：生效期间直接走本地，不再发请求 */
function circuitOpen() {
  return Date.now() < circuitOpenUntil
}

function state() {
  return {
    endpoint: endpoint,
    endpointFrom: endpointFrom,
    timeoutMs: timeoutMs,
    failStreak: failStreak,
    circuitOpen: circuitOpen(),
    lastCode: lastCode,
    permanentlyBlocked: permanentlyBlocked
  }
}

/* -------------------------------------------------------- 本地前置判定 */

/** FEN 是否不合法；合法返回 '' */
function fenError(fen) {
  try {
    const chess = new Chess()
    const check = chess.validate_fen(fen)
    if (check && check.valid === true) return ''
    return (check && check.error) || 'FEN 不合法'
  } catch (e) {
    return 'FEN 不合法'
  }
}

/**
 * 终局描述对象；未终局或 FEN 非法返回 null。
 * 复用端上引擎的判定，保证与本地路径口径一致（规则层是事实，不受开关影响）。
 */
function terminalOf(fen) {
  try {
    const chess = new Chess()
    const check = chess.validate_fen(fen)
    if (!check || check.valid !== true) return null
    chess.load(fen)
    return localEngine.describeTerminal(chess)
  } catch (e) {
    return null
  }
}

/** 终局局面直接走本地，不打扰远端 */
function isTerminalFen(fen) {
  return !!terminalOf(fen)
}

/* -------------------------------------------------------------- 请求 */

function wrapError(code, message, statusCode) {
  const err = new Error(message || REASON_TEXT[code] || '远端引擎不可用')
  err.code = code || 'UNKNOWN'
  if (statusCode !== undefined) err.statusCode = statusCode
  return err
}

/** wx.request 的 fail：errMsg 里带 timeout 才算超时，其余一律当网络失败 */
function normalizeFail(err) {
  const msg = String((err && (err.errMsg || err.message)) || 'request fail')
  const code = /timeout/i.test(msg) ? 'TIMEOUT' : 'NETWORK'
  return wrapError(code, msg)
}

function post(payload) {
  return new Promise((resolve, reject) => {
    const host = typeof wx !== 'undefined' ? wx : null
    if (!host || typeof host.request !== 'function') {
      reject(wrapError('ENV_NO_NETWORK', '当前环境不支持网络请求'))
      return
    }
    host.request({
      url: endpoint + '/v1',
      method: 'POST',
      header: { 'content-type': 'application/json' },
      // 显式序列化：不依赖运行时对对象 data 的隐式转换
      data: JSON.stringify(payload),
      timeout: timeoutMs,
      success: res => resolve(res || {}),
      fail: err => reject(normalizeFail(err))
    })
  })
}

/** 探测一次引擎版本（GET /healthz）。不抛错、不阻塞：失败返回 '' */
function get(url) {
  return new Promise(resolve => {
    const host = typeof wx !== 'undefined' ? wx : null
    if (!host || typeof host.request !== 'function') {
      resolve(null)
      return
    }
    host.request({
      url: url,
      method: 'GET',
      timeout: Math.min(timeoutMs, 3000),
      success: res => resolve(res && res.data ? res.data : null),
      fail: () => resolve(null)
    })
  })
}

function fetchEngineVersion() {
  if (versionProbe) return versionProbe
  versionProbe = get(endpoint + '/healthz').then(data => {
    const body = typeof data === 'string' ? parseBody({ data: data }) : data
    const v = body && body.engine && typeof body.engine.version === 'string'
      ? body.engine.version
      : ''
    cachedVersion = v
    return v
  }).catch(() => '')
  return versionProbe
}

/* ------------------------------------------------------------ 响应映射 */

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return isFinite(n) ? n : null
}

/** 顶层字段是白方视角，要换算成行棋方视角；只在没有 lines[] 时（兼容 chess-api.com）才走这条路 */
function scoreFromBody(body, key) {
  if (!body || body[key] === null || body[key] === undefined || body[key] === '') return null
  const n = Number(body[key])
  if (!isFinite(n)) return null
  return n * (body.turn === 'b' ? -1 : 1)
}

/** 服务端响应 → 端上 engine.js 契约（只多 source / engineVersion / remote，不改既有字段） */
function normalize(body, requested, multiPV, startedAt) {
  const b = body || {}
  // 有 lines[] 时它就是权威（服务端已换成行棋方视角）；没有才退回顶层字段自己换算
  const hasLines = Array.isArray(b.lines) && b.lines.length > 0
  const raw = hasLines ? b.lines : [b]
  const lines = raw.slice(0, multiPV).map((l, i) => {
    const line = l || {}
    return {
      rank: Number(line.rank) || i + 1,
      uci: line.uci || line.move || '',
      san: line.san || '',
      from: line.from || '',
      to: line.to || '',
      // lines[] 没有 captured，只有顶层 captured 且只对应第 1 线
      captured: i === 0 ? (b.captured || null) : null,
      scoreCp: hasLines ? numOrNull(line.scoreCp) : scoreFromBody(b, 'centipawns'),
      scoreMate: hasLines ? numOrNull(line.scoreMate) : scoreFromBody(b, 'mate'),
      pv: Array.isArray(line.pv) ? line.pv : (Array.isArray(line.continuationArr) ? line.continuationArr : []),
      pvSan: Array.isArray(line.pvSan) ? line.pvSan : []
    }
  })

  const engineInfo = b.engine || {}
  return {
    engine: 'stockfish',
    // /v1 不带 engine 字段时，用 healthz 探到的版本（没有就留空，徽标退化成「云端引擎」）
    engineVersion: typeof engineInfo.version === 'string' ? engineInfo.version : cachedVersion,
    fen: b.fen || requested.fen,
    depth: Number(b.depth) || 0,
    nodes: Number(b.nodes) || 0,
    elapsedMs: Date.now() - startedAt,
    sideToMove: b.turn || b.sideToMove || 'w',
    lines: lines,
    terminal: null,
    source: 'remote',
    remote: {
      engineMs: Number(b.elapsedMs) || 0,
      seldepth: Number(b.seldepth) || 0,
      timedOut: !!b.timedOut
    }
  }
}

/** 解析响应体：wx.request 默认按 json 解析，个别环境可能给字符串 */
function parseBody(res) {
  const data = res && res.data
  if (!data) return null
  if (typeof data === 'object') return data
  if (typeof data === 'string') {
    try {
      return JSON.parse(data)
    } catch (e) {
      return null
    }
  }
  return null
}

/* ------------------------------------------------------------ 回落本地 */

function localAnalyze(opts) {
  return fallbackFn ? fallbackFn(opts) : localEngine.analyze(opts)
}

/** 包一层本地结果，标上来源（非降级路径只用 source） */
async function asLocal(opts, extra) {
  const local = await localAnalyze(opts)
  return Object.assign({}, local, { source: 'local' }, extra || {})
}

function detailOf(err) {
  if (!err) return ''
  const parts = []
  if (err.statusCode !== undefined && err.statusCode !== null) parts.push('HTTP ' + err.statusCode)
  if (err.code) parts.push(String(err.code))
  const msg = err.message ? String(err.message) : ''
  if (msg && msg !== REASON_TEXT[err.code]) parts.push(msg)
  return parts.join(' · ').slice(0, 160)
}

/**
 * 记一次失败 + 必要时熔断，然后回落本地。
 * 熔断期间（cooldown 内）后续请求直接走本地，不再让用户干等一个网络超时。
 */
async function degrade(opts, err) {
  const code = (err && err.code) || 'UNKNOWN'
  const reason = reasonText(code)
  lastCode = code
  failStreak++

  if (failStreak >= CIRCUIT_FAILS && !circuitOpen()) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS
    debugLog.push('warn', '[引擎] 云端连续失败 ' + failStreak + ' 次，' +
      Math.round(CIRCUIT_COOLDOWN_MS / 1000) + ' 秒内改走本地引擎')
  }
  debugLog.push('warn', '[引擎] 云端不可用（' + detailOf(err) + '），已回落本地引擎')

  return await asLocal(opts, {
    degradedFrom: code,
    degradedReason: reason,
    degradedDetail: detailOf(err)
  })
}

function reasonText(code) {
  return REASON_TEXT[code] || '暂时不可用'
}

/**
 * 环境级屏蔽判定：不是服务端抖动，而是「这个微信运行环境根本不允许访问该地址」。
 * 几种已实测的触发（均为平台/网关行为，重试一定得到同样结果）：
 *   1) H5 预览：wx.request 只允许 /.cloud/ 路径，其余一律 fail('...path not allowed')；
 *   2) 真机：域名未配进 request 合法域名，或前置网关识别到微信移动端 UA，
 *      返回 HTTP 403 + HTML「请在浏览器中打开」（CloudStudio 预览域名实测如此：
 *      裸 microMessenger UA 不拦，完整 iPhone MicroMessenger UA 才拦）。
 * 命中后本次会话不要再重试，否则只是把「返回内容异常」刷屏。
 */
function isEnvironmentBlock(err, res) {
  const msg = err && String(err.errMsg || err.message || '')
  if (/path not allowed/i.test(msg)) return true
  const status = res && res.statusCode
  if (status === 403) return true
  const data = res && res.data
  if (typeof data === 'string' && /<!doctype|请在浏览器中打开|CloudStudio/i.test(data)) return true
  return false
}

/**
 * 环境级屏蔽后的回落：走本地，并给出明确原因（不是「返回内容异常」那种吓人话）。
 * 同一会话只提示一次，避免多次分析刷屏。
 */
async function asBlockedLocal(opts) {
  const local = await localAnalyze(opts)
  if (!blockedNotified) {
    blockedNotified = true
    debugLog.push('info',
      '[引擎] 当前后端地址 ' + endpoint + ' 在这个环境里不可访问（预览只允许 /.cloud/ 路径、' +
      '真机被网关拦截、或地址未配进 request 合法域名）。已改用本地引擎（棋力较弱，评分仅供参考）。' +
      '正式版请改用自有已备案域名（https）部署引擎服务。')
  }
  return Object.assign({}, local, {
    source: 'local',
    degradedFrom: 'GATEWAY_BLOCK',
    degradedReason: reasonText('GATEWAY_BLOCK'),
    degradedDetail: ''
  })
}

/* -------------------------------------------------------------- 主流程 */

/** UI 深度 → 远端 depth / maxThinkingTime */
function remoteParams(depth) {
  const level = DEPTH_LEVELS[Number(depth)]
  return {
    depth: clamp(level ? level.depth : DEFAULT_DEPTH, 1, MAX_DEPTH, DEFAULT_DEPTH),
    think: clamp(level ? level.think : DEFAULT_THINK_MS, 50, MAX_THINK_MS, DEFAULT_THINK_MS)
  }
}

/**
 * 分析局面。与 `engine.analyze()` 同构，只多 `source` / `engineVersion` / `remote` 三个字段。
 *
 * 正常情况下不会抛错：远端挂了会自动回落本地（结果里带 degradedFrom）。
 * 只有「请求本身就是错的」才抛（见 LOCAL_BUG_CODES）——这类问题回落也修不好。
 *
 * @param {object} input { fen, depth, multiPV, maxTimeMs }
 * @returns {Promise<object>} 端上契约；`source` 为 'remote' 或 'local'
 */
async function analyze(input) {
  const opts = input || {}
  const fen = typeof opts.fen === 'string' ? opts.fen.trim() : ''
  const multiPV = clamp(opts.multiPV, 1, MAX_VARIANTS, 3)

  // 非法 FEN 属于本地 bug：不打扰远端，直接让本地引擎给出它一贯的报错
  if (!fen || fenError(fen)) return await asLocal(opts)
  // 终局前置拦截（D16）
  if (isTerminalFen(fen)) return await asLocal(opts, { skipped: 'terminal' })
  if (!device.canRequest()) return await degrade(opts, wrapError('ENV_NO_NETWORK'))
  // 本会话已确认该域名在微信内不可访问：不再发请求，直接本地（避免反复刷屏）
  if (permanentlyBlocked) return await asBlockedLocal(opts)

  // 熔断期内直接用本地，等冷却结束再探一次
  if (circuitOpen()) {
    return await asLocal(opts, {
      degradedFrom: lastCode || 'CIRCUIT_OPEN',
      degradedReason: reasonText(lastCode || 'CIRCUIT_OPEN'),
      degradedDetail: ''
    })
  }

  const params = remoteParams(opts.depth)
  const payload = {
    fen: fen,
    depth: params.depth,
    maxThinkingTime: params.think,
    variants: multiPV
  }
  const startedAt = Date.now()

  // 版本探测与本次分析并行发出（不 await）：真机往返约 0.2s，分析回来时通常已经有结果了
  if (!cachedVersion && !permanentlyBlocked) fetchEngineVersion()

  if (!endpointLogged) {
    endpointLogged = true
    debugLog.push('info', '[引擎] 端点 ' + endpoint + '（来源：' + endpointFrom + '）')
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let res = null
    let err = null
    try {
      res = await post(payload)
    } catch (e) {
      err = e
    }

    // 环境级屏蔽（预览只允许 /.cloud/、真机微信 UA 被 CloudStudio 网关 403）：
    // 不是服务端抖动，重试/熔断都没用，标记后本次会话永久走本地。
    if (isEnvironmentBlock(err, res)) {
      permanentlyBlocked = true
      return await asBlockedLocal(opts)
    }

    if (!err) {
      const body = parseBody(res)
      const status = res && res.statusCode
      // 判错一律看 body.type（HTTP 200 也可能是错误体）
      if (!body || body.type === 'error') {
        err = wrapError(
          (body && body.error) || 'BAD_RESPONSE',
          (body && (body.text || body.error)) || '云端引擎返回内容异常',
          status
        )
      } else if (!Array.isArray(body.lines) || !body.lines.length) {
        err = wrapError('BAD_RESPONSE', '云端引擎没有返回任何路线', status)
      } else {
        const result = normalize(body, { fen: fen }, multiPV, startedAt)
        // 探测若已回来（多数情况），补上版本；没回来就等下一次，徽标不影响分析本身
        if (!result.engineVersion && cachedVersion) result.engineVersion = cachedVersion
        onSuccess(result)
        return result
      }
    }

    // 请求本身有问题：不重试、不回落，抛给调用方（改代码才能修）
    if (LOCAL_BUG_CODES.indexOf(err.code) !== -1 || (err.statusCode === 400)) throw err
    // 限流退避一次再试
    if (RETRY_ONCE_CODES.indexOf(err.code) !== -1 && attempt === 0) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
      continue
    }
    return await degrade(opts, err)
  }

  return await degrade(opts, wrapError('BAD_RESPONSE', '云端引擎返回内容异常'))
}

function onSuccess(result) {
  // /v1 自带版本就记下来，之后不必再探 healthz
  if (result.engineVersion) cachedVersion = result.engineVersion
  const wasBroken = failStreak > 0 || circuitOpen()
  failStreak = 0
  circuitOpenUntil = 0
  const version = result.engineVersion ? ' ' + result.engineVersion : ''
  debugLog.push('info', '[引擎] 云端' + version + ' · 深度 ' + result.depth +
    ' · ' + result.lines.length + ' 线 · ' + result.elapsedMs + 'ms')
  if (wasBroken) debugLog.push('info', '[引擎] 云端引擎已恢复')
}

module.exports = {
  analyze,
  configure,
  setFallback,
  reset,
  state,
  reasonText,
  remoteParams,
  isTerminalFen,
  normalize,
  DEFAULT_ENDPOINT,
  REQUEST_TIMEOUT_MS,
  REASON_TEXT,
  LOCAL_BUG_CODES
}
