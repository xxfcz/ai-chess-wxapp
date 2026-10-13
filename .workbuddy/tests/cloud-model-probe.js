/**
 * 云端模型 / 延迟诊断探针（需要网络，会消耗少量云服务额度）。
 *
 * 目的：回答两个问题
 *   1) 云服务到底提供哪些模型、应用实际用的是哪一个（服务端会返回 model 字段）；
 *   2) 用「应用真实使用的提示词」测一次完整生成的耗时，
 *      判断兜底看门狗的时限是不是定得太紧。
 *
 * 运行：node .workbuddy/tests/cloud-model-probe.js
 */
const path = require('path')
const { createDiagnosticWx } = require(path.join(__dirname, '../../utils/workbuddy-cloud-diagnostics.js'))
const { publicConfig } = require(path.join(__dirname, '../../utils/cloud-config.js'))

/** 模拟「网页版预览」的 wx：普通请求走 fetch；enableChunked 请求不给 onChunkReceived */
function createPreviewLikeWx() {
  const store = {}
  const stats = { plain: 0, chunked: 0, events: [] }
  return {
    stats: stats,
    getStorageSync(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : ''
    },
    setStorageSync(key, value) { store[key] = value },
    removeStorageSync(key) { delete store[key] },
    request(options) {
      const url = options.url
      const method = (options.method || 'GET').toUpperCase()
      const body = typeof options.data === 'string' ? options.data : (options.data ? JSON.stringify(options.data) : undefined)
      const startedAt = Date.now()
      const label = /chat\/completions/.test(url) ? 'completions' : (/models/.test(url) ? 'models' : url)

      if (options.enableChunked) {
        stats.chunked++
        const chunkTask = {
          aborted: false,
          abort() {
            if (chunkTask.aborted) return
            chunkTask.aborted = true
            if (options.fail) options.fail({ errMsg: 'request:fail abort' })
          }
        }
        return chunkTask
      }

      stats.plain++
      const task = { aborted: false, abort() { task.aborted = true } }
      fetch(url, { method: method, headers: options.header || {}, body: body })
        .then(async res => {
          const text = await res.text()
          const header = {}
          res.headers.forEach((value, key) => { header[key] = value })
          if (task.aborted) return
          stats.events.push({ label: label, ms: Date.now() - startedAt, bytes: text.length, status: res.status })
          options.success({ statusCode: res.status, header: header, data: text })
        })
        .catch(err => {
          if (task.aborted) return
          options.fail({ errMsg: 'request:fail ' + (err && err.message) })
        })
      return task
    }
  }
}

const rawWx = createPreviewLikeWx()
const adapter = createDiagnosticWx(rawWx)
// ai-client 内部的 getCloud() 会自己包一层适配器，这里把 rawWx 暴露成全局 wx
globalThis.wx = rawWx

const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
  wx: adapter
})
const ai = require(path.join(__dirname, '../../utils/ai-client.js'))

;(async () => {
  console.log('=== 1. 云服务提供的模型 ===')
  const tList = Date.now()
  const models = await cloud.llm.models.list()
  console.log('  模型数:', models.length, '| 列表耗时:', Date.now() - tList + 'ms')
  models.forEach((m, i) => {
    console.log('   ' + String(i + 1).padStart(2) + '. ' +
      String(m.id).padEnd(36) +
      String(m.name || '').padEnd(24) +
      (m.disabled === true ? '[已停用]' : ''))
  })

  console.log('\n=== 2. 用应用真实的提示词跑一次（应用会先挑响应快的模型） ===')
  const t0 = Date.now()
  let servedBy = '(未返回)'
  let firstDeltaMs = null
  let deltas = 0
  let text = ''
  try {
    text = await ai.requestCoachComment({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      sideToMove: 'w',
      lines: [
        { rank: 1, san: 'e4', pvSan: ['e4', 'e5', 'Nf3'], scoreCp: 24, from: 'e2', to: 'e4' },
        { rank: 2, san: 'd4', pvSan: ['d4', 'd5', 'c4'], scoreCp: 20, from: 'd2', to: 'd4' },
        { rank: 3, san: 'Nf3', pvSan: ['Nf3', 'Nf6', 'g3'], scoreCp: 15, from: 'g1', to: 'f3' }
      ],
      onDelta: () => { deltas++; if (firstDeltaMs === null) firstDeltaMs = Date.now() - t0 },
      onModel: info => { servedBy = (info && info.label) || String(info) }
    })
  } catch (err) {
    console.log('  ❌ 失败：', err && err.message)
    console.log('     error:', JSON.stringify(err && err.error))
    console.log('     cause:', err && err.cause && err.cause.message)
    console.log('     用时:', Date.now() - t0 + 'ms')
    rawWx.stats.events.forEach(e => console.log('  ' + e.label + ': ' + e.ms + 'ms, ' + e.bytes + ' 字节, HTTP ' + e.status))
    process.exit(1)
  }

  console.log('  实际服务模型:', servedBy)
  console.log('  总耗时:', Date.now() - t0 + 'ms')
  console.log('  onDelta 次数:', deltas, '| 首个 delta 距开始:', firstDeltaMs + 'ms')
  console.log('  正文长度:', text.length, '字')
  console.log('  正文:', text.trim().slice(0, 160))

  console.log('\n=== 3. 请求明细 ===')
  rawWx.stats.events.forEach(e => console.log('  ' + e.label + ': ' + e.ms + 'ms, ' + e.bytes + ' 字节, HTTP ' + e.status))
  console.log('  普通请求', rawWx.stats.plain, '次 / 分块探测', rawWx.stats.chunked, '次')
  process.exit(0)
})().catch(err => {
  console.log('\n❌ 探针异常:', err && err.message)
  console.log(err && err.stack)
  process.exit(1)
})
