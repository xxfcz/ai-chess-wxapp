/**
 * 端到端实网探针（需要网络，会消耗少量云服务额度）：
 *
 * 用真实云服务 + 一个「像网页版预览」的 wx 实现（接受 enableChunked 但不给分块回调），
 * 走一遍应用真实的调用路径：SDK → 适配器 → 登录鉴权 → 列模型 → 流式点评。
 * 用来证明「不支持分块流式的环境」经过适配后功能仍然可用。
 *
 * 运行：node .workbuddy/tests/cloud-live-probe.js
 */
const path = require('path')
const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
const { createDiagnosticWx } = require(path.join(__dirname, '../../utils/workbuddy-cloud-diagnostics.js'))
const { publicConfig } = require(path.join(__dirname, '../../utils/cloud-config.js'))

/**
 * 模拟网页版预览的 wx：
 *  - 普通 wx.request 能正常拿到响应（这里用 fetch 实现）
 *  - 带 enableChunked 的请求返回的任务对象上没有 onChunkReceived
 *  - 存储接口用内存实现
 */
function createPreviewLikeWx() {
  const store = {}
  const stats = { plain: 0, chunked: 0 }
  const wx = {
    stats: stats,
    getStorageSync(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : ''
    },
    setStorageSync(key, value) {
      store[key] = value
    },
    removeStorageSync(key) {
      delete store[key]
    },
    request(options) {
      const url = options.url
      const method = (options.method || 'GET').toUpperCase()
      const body = typeof options.data === 'string' ? options.data : (options.data ? JSON.stringify(options.data) : undefined)

      if (options.enableChunked) {
        stats.chunked++
        // 像预览一样：接受了 enableChunked，却没有分块回调；
        // 且 abort() 会回调 fail('request:fail abort')——真实环境就是这个行为。
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
          options.success({ statusCode: res.status, header: header, data: text })
        })
        .catch(err => {
          if (task.aborted) return
          options.fail({ errMsg: 'request:fail ' + (err && err.message) })
        })
      return task
    }
  }
  return wx
}

;(async () => {
  const wx = createPreviewLikeWx()
  const adapter = createDiagnosticWx(wx)
  const cloud = createMiniProgramWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
    wx: adapter
  })

  console.log('=== 1. 列出模型 ===')
  const models = await cloud.llm.models.list()
  console.log('  模型数:', models.length)
  models.forEach((m, i) => {
    console.log('   ' + String(i + 1).padStart(2) + '. ' +
      String(m.id).padEnd(34) +
      String(m.name || '').padEnd(20) +
      (m.disabled === true ? '[已停用]' : ''))
  })
  // 应用里的选法：第一条未停用的
  const usable = models.filter(m => m.disabled !== true)
  const picked = usable.length ? usable[0] : null
  console.log('  应用实际会选:', picked && picked.id, '（规则：列表里第一条未停用的模型）')

  console.log('\n=== 2. 流式点评（环境不支持分块，走适配器降级） ===')
  const t0 = Date.now()
  let text = ''
  let frames = 0
  let servedBy = null
  const stream = await cloud.llm.chat.completions.create({
    model: picked.id,
    messages: [
      { role: 'system', content: '你是一名国际象棋教练，面向中文用户讲解局面。只输出点评正文。' },
      { role: 'user', content: '局面 FEN：rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1\n轮到白方行棋。请用两三句话点评。' }
    ],
    stream: true,
    temperature: 0.6
  })
  for await (const chunk of stream) {
    frames++
    if (chunk && chunk.model) servedBy = chunk.model
    const choice = chunk && chunk.choices && chunk.choices[0]
    if (choice && choice.delta && choice.delta.content) text += choice.delta.content
  }
  console.log('  分片数:', frames, '| 耗时:', Date.now() - t0 + 'ms')
  console.log('  响应声明的模型:', servedBy || '(未返回 model 字段)')
  console.log('  正文:', text.trim().slice(0, 120))

  console.log('\n=== 3. 适配器行为 ===')
  console.log('  streamingStatus:', adapter.streamingStatus(), '（false = 已确认识别为不支持分块）')
  console.log('  请求统计: 普通', wx.stats.plain, '次 / 分块', wx.stats.chunked, '次（分块那次数为探测，仅 1 次）')

  // 关键验收点：abort 触发的 fail 不能把这次请求判负
  const pass = models.length > 0 && text.trim().length > 0 &&
    adapter.streamingStatus() === false && wx.stats.chunked === 1
  console.log('\n' + (pass
    ? '✅ 实网链路通过：不支持分块流式的环境（含 abort 回调 fail）也能生成点评'
    : '❌ 未通过'))
  process.exit(pass ? 0 : 1)
})().catch(err => {
  console.log('\n❌ 探针失败:', err && err.message)
  console.log('   error:', JSON.stringify(err && err.error))
  console.log('   cause:', err && err.cause && err.cause.message)
  process.exit(1)
})
