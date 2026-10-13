/**
 * 真机形态探针（需要网络，会消耗少量云服务额度）。
 *
 * 复现并验证真机上的那个报错：`TextDecoder is not defined`。
 *
 * 真机与网页版预览的两个差异，这里都还原：
 *   1) 真机的 wx.request **原生支持分块流式**（任务对象有 onChunkReceived），
 *      所以走的是「原生分块」路径，不是降级路径；
 *   2) 真机的 JS 运行时**没有全局 TextDecoder**，而 SDK 的 SSE 解析器内部
 *      `new TextDecoder('utf-8')` 依赖它 —— 于是第一个分片到达时就抛错。
 *
 * 运行：node .workbuddy/tests/cloud-realdevice-probe.js
 */
const path = require('path')
const { createDiagnosticWx } = require(path.join(__dirname, '../../utils/workbuddy-cloud-diagnostics.js'))
const { publicConfig } = require(path.join(__dirname, '../../utils/cloud-config.js'))

/** 真机形态的 wx：原生分块（边收边回调）+ abort 会回调 fail */
function createRealDeviceLikeWx() {
  const store = {}
  const stats = { plain: 0, chunked: 0, chunks: 0, firstChunkMs: null, totalMs: null }
  const startedAt = Date.now()

  function headersToObject(headers) {
    const out = {}
    headers.forEach((value, key) => { out[key] = value })
    return out
  }

  return {
    stats: stats,
    getStorageSync(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : '' },
    setStorageSync(key, value) { store[key] = value },
    removeStorageSync(key) { delete store[key] },
    request(requestOptions) {
      const url = requestOptions.url
      const method = (requestOptions.method || 'GET').toUpperCase()
      const body = typeof requestOptions.data === 'string'
        ? requestOptions.data
        : (requestOptions.data ? JSON.stringify(requestOptions.data) : undefined)
      const aborter = typeof AbortController === 'function' ? new AbortController() : null
      const state = { aborted: false }

      if (requestOptions.enableChunked) {
        stats.chunked++
        const chunkListeners = []
        const headerListeners = []
        const task = {
          abort() {
            if (state.aborted) return
            state.aborted = true
            if (aborter) aborter.abort()
            // 真机上 abort() 会回调 fail，这里还原
            if (requestOptions.fail) requestOptions.fail({ errMsg: 'request:fail abort' })
          },
          onChunkReceived(fn) { chunkListeners.push(fn) },
          onHeadersReceived(fn) { headerListeners.push(fn) }
        }

        fetch(url, { method: method, headers: requestOptions.header || {}, body: body, signal: aborter ? aborter.signal : undefined })
          .then(async res => {
            headerListeners.forEach(fn => fn({ header: headersToObject(res.headers) }))
            const reader = res.body.getReader()
            for (;;) {
              const step = await reader.read()
              if (step.done) break
              if (state.aborted) return
              const value = step.value
              // 真机上 chunk.data 就是 ArrayBuffer
              const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
              stats.chunks++
              if (stats.firstChunkMs === null) stats.firstChunkMs = Date.now() - startedAt
              chunkListeners.forEach(fn => { try { fn({ data: buffer }) } catch (e) { /* 监听器异常不影响请求 */ } })
            }
            if (state.aborted) return
            stats.totalMs = Date.now() - startedAt
            requestOptions.success({ statusCode: res.status, header: headersToObject(res.headers), data: '' })
          })
          .catch(err => {
            if (state.aborted) return
            requestOptions.fail({ errMsg: 'request:fail ' + (err && err.message) })
          })
        return task
      }

      stats.plain++
      const task = { abort() { state.aborted = true; if (aborter) aborter.abort() } }
      fetch(url, { method: method, headers: requestOptions.header || {}, body: body, signal: aborter ? aborter.signal : undefined })
        .then(async res => {
          const text = await res.text()
          if (state.aborted) return
          requestOptions.success({ statusCode: res.status, header: headersToObject(res.headers), data: text })
        })
        .catch(err => {
          if (state.aborted) return
          requestOptions.fail({ errMsg: 'request:fail ' + (err && err.message) })
        })
      return task
    }
  }
}

;(async () => {
  // ---- 关键一步：把全局 TextDecoder 摘掉，模拟真机 ----
  const savedTextDecoder = global.TextDecoder
  delete global.TextDecoder
  console.log('=== 1. 模拟真机：先摘掉全局 TextDecoder ===')
  console.log('  typeof TextDecoder =', typeof global.TextDecoder)

  const { installTextCodec } = require(path.join(__dirname, '../../utils/text-codec.js'))
  const installResult = installTextCodec()
  console.log('  补装结果:', JSON.stringify(installResult.installed), '（decoder:', installResult.decoder, '）')
  if (typeof global.TextDecoder !== 'function') {
    console.log('  ❌ 补装失败，后面的链路必然报 TextDecoder is not defined')
    process.exit(1)
  }

  const rawWx = createRealDeviceLikeWx()
  globalThis.wx = rawWx // 供 ai-client 内部的 getCloud() 使用

  const ai = require(path.join(__dirname, '../../utils/ai-client.js'))
  const { getCloud } = require(path.join(__dirname, '../../utils/cloud.js'))

  console.log('\n=== 2. 真机形态：原生分块流式 + 应用真实调用路径 ===')
  const models = await getCloud().llm.models.list()
  console.log('  模型数:', models.length)

  const t0 = Date.now()
  let served = ''
  let deltas = 0
  let firstDeltaMs = null
  let text = ''
  try {
    text = await ai.requestCoachComment({
      fen: 'r1bqkbnr/pppppppp/2n5/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 1 2',
      sideToMove: 'b',
      lines: [
        { rank: 1, san: 'e5', pvSan: ['e5', 'Nf3', 'Nf6'], scoreCp: -18, from: 'e7', to: 'e5' },
        { rank: 2, san: 'd5', pvSan: ['d5', 'exd5', 'Qxd5'], scoreCp: -22, from: 'd7', to: 'd5' },
        { rank: 3, san: 'e6', pvSan: ['e6', 'd4', 'd5'], scoreCp: -26, from: 'e7', to: 'e6' }
      ],
      onDelta: () => { deltas++; if (firstDeltaMs === null) firstDeltaMs = Date.now() - t0 },
      onModel: info => { served = (info && info.label) || String(info) }
    })
  } catch (err) {
    console.log('  ❌ 失败:', err && err.message)
    console.log('     error:', JSON.stringify(err && err.error))
    console.log('     cause:', err && err.cause && err.cause.message)
    global.TextDecoder = savedTextDecoder
    process.exit(1)
  }

  console.log('  实际服务模型:', served)
  console.log('  总耗时:', Date.now() - t0 + 'ms')
  console.log('  原生分片数:', rawWx.stats.chunks, '| 首个分片:', rawWx.stats.firstChunkMs + 'ms')
  console.log('  增量回调次数:', deltas, '| 首个增量:', firstDeltaMs + 'ms')
  console.log('  正文长度:', text.length, '字')
  console.log('  正文:', text.trim().slice(0, 140))

  const pass = text.trim().length > 0 && rawWx.stats.chunks > 1 && deltas >= 1 &&
    firstDeltaMs !== null && firstDeltaMs < Date.now() - t0
  console.log('\n' + (pass
    ? '✅ 真机形态通过：没有全局 TextDecoder 也能用原生分块流式拿到点评（且是增量返回）'
    : '❌ 未通过（分片数或增量回调不符合预期）'))

  global.TextDecoder = savedTextDecoder
  process.exit(pass ? 0 : 1)
})().catch(err => {
  console.log('探针异常:', err && err.message)
  console.log(err && err.stack)
  process.exit(1)
})
