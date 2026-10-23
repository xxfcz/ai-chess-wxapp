/**
 * engine-probe.js
 * 远端引擎连通性探测：把「这个宿主到底能不能连上云端引擎」变成界面上可直接读的几行结论。
 *
 * 存在意义：同一个包在四个宿主里跑（开发者工具模拟器 / 真机调试 / WorkBuddy 预览面板 /
 * WorkBuddy 真机试用），失败原因完全不是一类东西——域名白名单、沙箱路径白名单、
 * 网关 403、明文 HTTP 被中间设备重置、宿主压根不实现 wx.request、以及宿主收了请求却不回调。
 * 这些从界面上看都只是「引擎不可用」，所以必须能一条一条量出来。
 *
 * 三条约束：
 *   1. **只读** —— 不改引擎状态、不动熔断计数、不写 storage、不触发分析；
 *   2. **永不抛错** —— 任何失败都变成一行可读的 detail，界面不会因此崩；
 *   3. **自己带超时** —— 预览沙箱遇到过「既不 success 也不 fail」，不能指望宿主回调。
 */

const engineConfig = require('./engine-config')

const DEFAULT_TIMEOUT_MS = 6000
/** 只探测开局局面：最便宜、且服务端不可能报 INVALID_FEN */
const PROBE_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function clip(value, max) {
  const text = typeof value === 'string' ? value : String(value == null ? '' : value)
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 响应体可能是对象，也可能是字符串（个别环境不按 json 解析） */
function asBody(data) {
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

/**
 * 发一次请求，永不 reject。宿主不回调时由本地计时器兜底。
 * @returns {Promise<{status:number, elapsed:number, body:any, errMsg:string, raw:string}>}
 */
function requestOnce(host, options) {
  return new Promise(resolve => {
    const started = Date.now()
    if (!host || typeof host.request !== 'function') {
      resolve({ status: 0, elapsed: 0, body: null, raw: '', errMsg: '宿主没有 wx.request' })
      return
    }
    let settled = false
    const finish = payload => {
      if (settled) return
      settled = true
      resolve(payload)
    }
    const timer = setTimeout(() => {
      finish({
        status: 0,
        elapsed: Date.now() - started,
        body: null,
        raw: '',
        errMsg: '宿主 ' + options.timeoutMs + 'ms 内没有回调（请求可能被沙箱吞掉）'
      })
    }, options.timeoutMs)

    try {
      host.request({
        url: options.url,
        method: options.method,
        header: options.header,
        data: options.data,
        timeout: options.timeoutMs,
        success: res => {
          clearTimeout(timer)
          const r = res || {}
          finish({
            status: r.statusCode || 0,
            elapsed: Date.now() - started,
            body: asBody(r.data),
            raw: typeof r.data === 'string' ? r.data : '',
            errMsg: ''
          })
        },
        fail: err => {
          clearTimeout(timer)
          const msg = String((err && (err.errMsg || err.message)) || 'request fail')
          finish({ status: 0, elapsed: Date.now() - started, body: null, raw: '', errMsg: msg })
        }
      })
    } catch (e) {
      clearTimeout(timer)
      finish({
        status: 0,
        elapsed: Date.now() - started,
        body: null,
        raw: '',
        errMsg: String((e && e.message) || e)
      })
    }
  })
}

/**
 * 把失败现象翻译成人能读的分类。顺序有讲究：先认宿主的明确拒绝，再认状态码。
 * @returns {'ok'|'blocked'|'whitelist'|'gateway'|'timeout'|'network'|'bad'|'env'}
 */
function classify(result) {
  const errMsg = result.errMsg || ''
  if (/path not allowed/i.test(errMsg)) return 'blocked'
  if (/domain list|合法域名|not in domain/i.test(errMsg)) return 'whitelist'
  if (/没有 wx\.request/.test(errMsg)) return 'env'
  if (/没有回调/i.test(errMsg)) return 'timeout'
  if (/timeout/i.test(errMsg)) return 'timeout'
  if (result.status === 403) return 'gateway'
  if (result.status === 0) return 'network'
  if (result.status >= 500) return 'bad'
  return 'ok'
}

const KIND_TEXT = {
  blocked: '预览沙箱：当前宿主只放行平台 /.cloud/* 路径，外部引擎地址被拦下。' +
    '这是预览环境的设计限制（换域名也无效），真机/体验版/正式版不受影响',
  whitelist: '域名不在 request 合法域名白名单（真机/体验版才会触发）',
  gateway: '被前置网关拒绝（HTTP 403，多为微信移动端 UA 被拦）',
  timeout: '没有响应：网络不通，或宿主收了请求却不回调',
  network: '连接失败：DNS、TLS 或网络不可达',
  bad: '服务端返回了 5xx',
  env: '当前宿主不提供网络请求能力',
  ok: '通'
}

/**
 * 探测一次。
 *
 * @param {object} [options]
 * @param {object} [options.host]      wx 对象（测试可注入）
 * @param {string} [options.endpoint]  覆盖端点（默认按 engine-config 解析）
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{endpoint:string, from:string, rows:Array, hint:string, reachable:boolean}>}
 */
async function probe(options) {
  const o = options || {}
  const host = o.host || (typeof wx !== 'undefined' ? wx : null)
  const timeoutMs = isFinite(Number(o.timeoutMs)) && Number(o.timeoutMs) > 0
    ? Math.round(Number(o.timeoutMs))
    : DEFAULT_TIMEOUT_MS

  const resolved = engineConfig.resolveEndpoint()
  const endpoint = (o.endpoint || resolved.endpoint || '').replace(/\/+$/, '')
  const from = o.endpoint ? 'override' : resolved.from

  const rows = []
  const push = (key, name, level, detail) => rows.push({ key: key, name: name, level: level, detail: detail })

  push('endpoint', '端点', 'info', endpoint + '（来源 ' + from + '）')

  if (!endpoint) {
    push('config', '配置', 'error', '没有解析出任何端点')
    return { endpoint: '', from: from, rows: rows, hint: '端点为空，请检查 .env 与 engine-config.build.js', reachable: false }
  }

  // 1) /healthz：只测「域名/路径能不能到达」，不消耗引擎算力
  const health = await requestOnce(host, {
    url: endpoint + '/healthz',
    method: 'GET',
    timeoutMs: timeoutMs
  })
  const healthKind = classify(health)
  if (healthKind === 'ok' && health.status >= 200 && health.status < 300) {
    const body = health.body || {}
    const version = body.engine && body.engine.version ? body.engine.version : ''
    const pool = body.pool ? ' · 池 ' + (body.pool.idle != null ? body.pool.idle : '?') + '/' + (body.pool.size != null ? body.pool.size : '?') : ''
    push('healthz', 'GET /healthz', 'info', 'HTTP ' + health.status + ' · ' + health.elapsed + 'ms' + (version ? ' · ' + version : '') + pool)
  } else {
    const detail = health.errMsg
      ? health.errMsg
      : 'HTTP ' + health.status + (health.raw ? ' · ' + clip(health.raw, 80) : '')
    push('healthz', 'GET /healthz', 'error', detail + ' · ' + health.elapsed + 'ms')
  }

  // 2) /v1：真正跑一次极浅分析，确认「接口契约」也通（有些网关只放行 GET）
  const best = await requestOnce(host, {
    url: endpoint + '/v1',
    method: 'POST',
    header: { 'content-type': 'application/json' },
    data: JSON.stringify({ fen: PROBE_FEN, depth: 8, maxThinkingTime: 100, variants: 1 }),
    timeoutMs: timeoutMs
  })
  const bestBody = best.body || {}
  if (best.status >= 200 && best.status < 300 && bestBody.type !== 'error' && Array.isArray(bestBody.lines) && bestBody.lines.length) {
    const first = bestBody.lines[0] || {}
    push('v1', 'POST /v1', 'info', 'HTTP ' + best.status + ' · ' + best.elapsed + 'ms · ' +
      (first.san || first.uci || '?') + ' · ' + bestBody.lines.length + ' 线')
  } else {
    const detail = best.errMsg
      ? best.errMsg
      : 'HTTP ' + best.status + (bestBody.type === 'error' ? ' · ' + (bestBody.error || bestBody.text || '服务端报错') : '')
    push('v1', 'POST /v1', 'error', detail + ' · ' + best.elapsed + 'ms')
  }

  // 3) 结论：以更严重的那个为准（healthz 通但 /v1 不通 = 网关/路由差异）
  const v1Ok = rows[rows.length - 1].level === 'info'
  const healthOk = rows[rows.length - 2].level === 'info'
  const worst = !healthOk ? healthKind : (v1Ok ? 'ok' : classify(best))
  const hint = healthOk && !v1Ok
    ? '健康检查通、分析接口不通：多半是网关只放行了 GET，或路径被改写'
    : KIND_TEXT[worst] || KIND_TEXT.network

  return {
    endpoint: endpoint,
    from: from,
    rows: rows,
    hint: hint,
    reachable: healthOk && v1Ok
  }
}

module.exports = {
  probe,
  classify,
  requestOnce,
  DEFAULT_TIMEOUT_MS,
  PROBE_FEN,
  KIND_TEXT
}
