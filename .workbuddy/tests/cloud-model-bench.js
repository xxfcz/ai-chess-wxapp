/**
 * 模型速度对比探针（需要网络，会消耗少量云服务额度）。
 *
 * 背景：应用原来的 50 秒兜底看门狗在真实链路上不够用 ——
 * 用应用真实的教练提示词请求 auto 路由模型，在 50 秒内没有返回。
 *
 * 本探针用同一个提示词逐个试候选模型，测出「完整生成一圈」的耗时，
 * 用来决定：选哪个模型、以及看门狗该定多长。
 *
 * 运行：node .workbuddy/tests/cloud-model-bench.js [模型id ...]
 *       默认测 auto / deepseek-v4-flash / glm-5.3-flash / hunyuan-chat
 */
const path = require('path')
const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
const { createDiagnosticWx } = require(path.join(__dirname, '../../utils/workbuddy-cloud-diagnostics.js'))
const { publicConfig } = require(path.join(__dirname, '../../utils/cloud-config.js'))

const SYSTEM_PROMPT = [
  '你是一名国际象棋教练，面向中文用户讲解局面。',
  '只输出点评正文，不要复述这些要求，不要输出 Markdown 标题或代码块。',
  '基于给出的引擎数据说话，不要编造不存在的走法或子力。',
  '语气专业、简洁，控制在 3 到 5 句话。'
].join('')

const USER_PROMPT = [
  '局面 FEN：rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  '轮到白方行棋。',
  '引擎给出的候选路线：',
  '1. e4（后续 e5 Nf3），白方视角分数 +0.24',
  '2. d4（后续 d5 c4），白方视角分数 +0.20',
  '3. Nf3（后续 Nf6 g4），白方视角分数 +0.15',
  '',
  '请点评：这个局面的核心矛盾是什么？首选路线 e4 好在哪里？',
  '最后给白方一条具体的行棋建议。'
].join('\n')

const MAX_TOKENS = Number(process.env.MAX_TOKENS || 360)

function createPreviewLikeWx() {
  const store = {}
  const stats = { plain: 0, chunked: 0 }
  return {
    stats: stats,
    getStorageSync(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : '' },
    setStorageSync(key, value) { store[key] = value },
    removeStorageSync(key) { delete store[key] },
    request(options) {
      const method = (options.method || 'GET').toUpperCase()
      const body = typeof options.data === 'string' ? options.data : (options.data ? JSON.stringify(options.data) : undefined)
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
      fetch(options.url, { method: method, headers: options.header || {}, body: body })
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
}

async function bench(cloud, modelId) {
  const t0 = Date.now()
  let served = '(未返回)'
  let text = ''
  try {
    const stream = await cloud.llm.chat.completions.create({
      model: modelId,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_PROMPT }
      ],
      stream: true,
      temperature: 0.6,
      max_tokens: MAX_TOKENS
    })
    for await (const chunk of stream) {
      if (chunk && chunk.model) served = String(chunk.model)
      const choice = chunk && chunk.choices && chunk.choices[0]
      if (choice && choice.delta && choice.delta.content) text += choice.delta.content
    }
    return { modelId: modelId, ok: true, ms: Date.now() - t0, served: served, chars: text.length, text: text.trim() }
  } catch (err) {
    return {
      modelId: modelId,
      ok: false,
      ms: Date.now() - t0,
      served: served,
      error: (err && err.error && err.error.code) || '',
      message: (err && err.message) || ''
    }
  }
}

;(async () => {
  const wx = createPreviewLikeWx()
  const cloud = createMiniProgramWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
    wx: createDiagnosticWx(wx)
  })

  const ids = process.argv.slice(2).filter(Boolean)
  const targets = ids.length ? ids : ['auto', 'deepseek-v4-flash', 'glm-5.3-flash', 'hunyuan-chat']

  console.log('max_tokens =', MAX_TOKENS, '\n')
  const results = []
  for (const id of targets) {
    const r = await bench(cloud, id)
    results.push(r)
    if (r.ok) {
      console.log('✅ ' + String(id).padEnd(20) + ' ' + String(r.ms + 'ms').padStart(9) +
        '  服务模型=' + String(r.served).padEnd(22) + ' 正文 ' + r.chars + ' 字')
      console.log('     ' + r.text.slice(0, 100).replace(/\n/g, ' '))
    } else {
      console.log('❌ ' + String(id).padEnd(20) + ' ' + String(r.ms + 'ms').padStart(9) +
        '  ' + r.error + ' ' + r.message)
    }
  }

  console.log('\n=== 汇总（按耗时排序）===')
  results.slice().sort((a, b) => a.ms - b.ms).forEach(r => {
    console.log('  ' + String(r.ms + 'ms').padStart(9) + '  ' + String(r.modelId).padEnd(20) +
      (r.ok ? '→ ' + r.served : '→ 失败 ' + r.error))
  })
  process.exit(0)
})().catch(err => {
  console.log('探针异常:', err && err.message)
  console.log(err && err.stack)
  process.exit(1)
})
