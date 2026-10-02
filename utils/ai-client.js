/**
 * ai-client.js
 * AI 分析的门面层：
 *   1) analyzePosition —— 调用端上引擎，产出三条候选路线与分数；
 *   2) 分数格式化 —— 把行棋方视角的 cp / mate 换算成白方视角的展示文本；
 *   3) requestCoachComment —— 通过云服务 LLM API 生成中文局面点评（流式）。
 *
 * 引擎输出的字段与 UCI/Stockfish 同构，因此后续替换为真实引擎时，
 * 本文件与页面都不需要改动。
 */
const engine = require('./engine')
const device = require('./device')
const { getCloud } = require('./cloud')

const COACH_SYSTEM_PROMPT = [
  '你是一名国际象棋教练，面向中文用户讲解局面。',
  '只输出点评正文，不要复述这些要求，不要输出 Markdown 标题或代码块。',
  '基于给出的引擎数据说话，不要编造不存在的走法或子力。',
  '语气专业、简洁，控制在 3 到 5 句话、150 字以内。'
].join('')

/** 环境没有网络请求能力时给用户看的说明（端上分析与它无关，不受影响） */
const ENV_NO_NETWORK_TEXT =
  '当前环境未开放网络请求，云端点评暂时不可用。端上引擎分析（三条最佳路线）不受影响，' +
  '在微信真机或正式版中即可生成点评。'

/**
 * 模型选择：先按「够快」的偏好顺序挑，再退回云服务的自动路由。
 *
 * 为什么不能直接用 auto：实测同一条教练提示词（见下面的 buildUserPrompt），
 * auto 路由到的是混元 4 预览（思考型模型），一次完整生成超过 50 秒；
 * 而 flash 级模型的完整生成只要 3~10 秒。点评只要求三五句话，
 * 用思考型模型既慢又浪费额度，所以把快模型排在前面：
 *   deepseek-v4-flash 2905ms ｜ hunyuan-chat 4980ms ｜ glm-5.3-flash 10647ms
 *   （auto → hy4-preview-f 超过 50 秒且把 token 预算都花在思考上）
 * 列表里没有这些 id 时按顺序退回 auto / default / 第一条可用模型，
 * 保证模型上下线都不会让功能不可用。
 */
const MODEL_PREFERENCE = ['deepseek-v4-flash', 'hunyuan-chat', 'glm-5.3-flash']
const MODEL_BACKSTOP = ['auto', 'default']
/** 单次点评最多试几个模型：首选超时/空回复时换下一个再试一次 */
const MAX_ATTEMPTS = 2
/** 点评只需要三五句话，限住输出长度可以显著缩短等待时间 */
const MAX_TOKENS = 480

let cachedModelId = null

/** 模型 id → 提供方，仅用于界面说明，认不出来就不显示 */
const PROVIDER_RULES = [
  [/^deepseek/i, 'DeepSeek'],
  [/^glm/i, '智谱 GLM'],
  [/^minimax/i, 'MiniMax'],
  [/^kimi/i, '月之暗面 Kimi'],
  [/^(hy3|hy4|hunyuan)/i, '腾讯混元']
]

function providerOf(modelId) {
  const id = String(modelId || '')
  for (let i = 0; i < PROVIDER_RULES.length; i++) {
    if (PROVIDER_RULES[i][0].test(id)) return PROVIDER_RULES[i][1]
  }
  return ''
}

/**
 * 组装「这次点评用的是哪个模型」的展示信息。
 * 请求 auto 时，响应里声明的才是真正服务的模型，所以要能按 id 反查名字。
 * @returns {{ id:string, name:string, provider:string, label:string }}
 */
function describeModel(models, modelId) {
  const id = String(modelId || '')
  if (!id) return { id: '', name: '', provider: '', label: '' }
  const found = (models || []).find(item => item.id === id)
  const name = (found && found.name) || id
  const provider = providerOf(id)
  return { id: id, name: name, provider: provider, label: provider ? name + '（' + provider + '）' : name }
}

/** 按偏好顺序排出候选模型 id（去重、跳过已停用） */
function buildCandidates(models) {
  const usable = (models || []).filter(item => item.disabled !== true)
  const out = []
  const push = id => {
    if (!id || out.indexOf(id) !== -1) return
    if (!usable.some(item => item.id === id)) return
    out.push(id)
  }
  // 上次跑通的模型排第一，避免每次都在偏好列表里重新试探
  push(cachedModelId)
  MODEL_PREFERENCE.forEach(push)
  MODEL_BACKSTOP.forEach(push)
  usable.forEach(item => push(item.id))
  return out
}


/* ------------------------------------------------------------ 引擎分析 */

/**
 * @param {object} params { fen, depth, multiPV, onProgress }
 * @returns {Promise<object>} engine.analyze 的结果
 */
function analyzePosition(params) {
  const p = params || {}
  return engine.analyze({
    fen: p.fen,
    depth: p.depth,
    multiPV: p.multiPV || 3,
    onProgress: p.onProgress
  })
}

/* ------------------------------------------------------------ 分数展示 */

/**
 * 把行棋方视角的分数换算成白方视角。
 * @returns {{ text:string, whiteCp:number|null, mate:number|null, tone:string }}
 *   tone: 'white'（白优）| 'black'（黑优）| 'even'（均势）| 'mate'
 */
function formatScore(line, sideToMove) {
  const sign = sideToMove === 'w' ? 1 : -1

  if (line && line.scoreMate !== null && line.scoreMate !== undefined) {
    const mate = line.scoreMate * sign
    return {
      text: (mate > 0 ? '#' : '#-') + Math.abs(mate),
      whiteCp: mate > 0 ? 99999 : -99999,
      mate: mate,
      tone: 'mate'
    }
  }

  const cp = ((line && line.scoreCp) || 0) * sign
  const value = cp / 100
  let tone = 'even'
  if (cp > 60) tone = 'white'
  else if (cp < -60) tone = 'black'

  return {
    text: (value > 0 ? '+' : '') + value.toFixed(2),
    whiteCp: cp,
    mate: null,
    tone: tone
  }
}

/** 白方优势占比（0~100），用于优势条 */
function evalPercent(whiteCp) {
  if (whiteCp === null || whiteCp === undefined) return 50
  if (whiteCp >= 99999) return 100
  if (whiteCp <= -99999) return 0
  const share = 1 / (1 + Math.pow(10, -whiteCp / 400))
  return Math.max(2, Math.min(98, Math.round(share * 100)))
}

/** 组装展示用的路线对象 */
function buildLineView(line, sideToMove) {
  const score = formatScore(line, sideToMove)
  const pv = (line.pvSan && line.pvSan.length ? line.pvSan : [line.san]).slice(0, 4)
  return {
    rank: line.rank,
    san: line.san,
    from: line.from,
    to: line.to,
    scoreText: score.text,
    tone: score.tone,
    whiteCp: score.whiteCp,
    mate: score.mate,
    pvText: pv.join(' ')
  }
}

/* --------------------------------------------------- 云端 AI 教练点评 */

function sanitizeFen(fen) {
  return String(fen || '')
    .replace(/[^0-9a-hrnbqkpRNBQKP/\- ]/g, '')
    .slice(0, 90)
}

function buildUserPrompt(params) {
  const fen = sanitizeFen(params.fen)
  const side = params.sideToMove === 'w' ? '白方' : '黑方'
  const lines = params.lines || []
  const rows = lines.map(item => {
    const score = formatScore(item, params.sideToMove)
    return `${item.rank}. ${item.san}（后续 ${(item.pvSan || []).slice(1, 4).join(' ') || '—'}），白方视角分数 ${score.text}`
  })

  return [
    `局面 FEN：${fen}`,
    `轮到${side}行棋。`,
    '引擎给出的候选路线：',
    rows.join('\n') || '（引擎未给出路线）',
    '',
    `请点评：这个局面的核心矛盾是什么？首选路线 ${lines.length ? lines[0].san : '—'} 好在哪里？`,
    `最后给${side}一条具体的行棋建议。`
  ].join('\n')
}

/** 汇总底层原因（wx.request 的 errMsg、TypeError 文案等），用于诊断 */
function causeOf(err) {
  const parts = []
  let node = err && err.cause
  for (let i = 0; node && i < 3; i++) {
    const text = node.message ? String(node.message) : String(node)
    if (text && parts.indexOf(text) === -1) parts.push(text)
    node = node.cause
  }
  if (!parts.length && err && err.message) parts.push(String(err.message))
  if (!parts.length) return ''
  // 控制长度，避免把长响应体整段显示出来
  return parts.join(' <- ').slice(0, 160)
}

/**
 * 把 SDK 错误整理成「给用户看的话 + 给排查用的细节」。
 *
 * 注意：SDK 在底层请求失败（wx.request 失败、中断、响应无法解析）时
 * 统一抛 code 以 gateway_ 开头的错误，这类问题并不是「模型服务不可用」，
 * 必须分开说，否则用户会误以为是云端故障。
 *
 * @returns {{ message:string, detail:string, kind:string }}
 */
function llmErrorInfo(err) {
  const code = err && err.error && err.error.code ? String(err.error.code) : ''
  const status = err && typeof err.status === 'number' ? err.status : undefined
  const detail = code ? code + (causeOf(err) ? ' · ' + causeOf(err) : '') : causeOf(err)

  const wrap = (message, kind) => ({ message: message, detail: detail, kind: kind })

  if (code === 'env_no_network') return wrap(String(err.message || ENV_NO_NETWORK_TEXT), 'env')
  if (code.indexOf('request_') === 0) return wrap('请求参数有误，本次点评未能完成。', 'request')
  if (code.indexOf('auth_') === 0) return wrap('云服务鉴权未通过，请稍后重试。', 'auth')
  if (code.indexOf('quota_') === 0) {
    if (code === 'quota_rate_limited' && err.retryAfterMs) {
      return wrap(`请求过于频繁，请 ${Math.ceil(err.retryAfterMs / 1000)} 秒后再试。`, 'quota')
    }
    return wrap('云服务额度已用尽，可在「设置 → 数据管理 → 应用」中查看。', 'quota')
  }
  if (code === 'coach_empty_response') {
    return wrap('云端模型这次没有输出内容，请再点一次「生成点评」。', 'empty')
  }
  // 超时也走 gateway_* 码，但要和「网络不通」分开说：模型是收到了请求的，
  // 只是没在限时内生成完（大模型排队或输出过长时会出现）。
  if (code.indexOf('gateway_') === 0 && /timeout/i.test(detail)) {
    return wrap('云端模型这次没有在限时内返回（大模型排队时偶有发生），可以再点一次「生成点评」。', 'timeout')
  }
  // 底层请求失败：与模型无关，是网络/环境限制
  if (code === 'gateway_network_error') {
    return wrap('云端请求未能完成：当前环境不允许或中断了这次网络请求。端上引擎分析不受影响。', 'network')
  }
  if (code === 'gateway_stream_interrupted') {
    return wrap('云端响应中途断开，当前环境可能不支持流式返回，可以再试一次。', 'network')
  }
  if (code === 'gateway_invalid_response') {
    return wrap('云端返回的内容无法解析，可能被网络中间层改写，请稍后重试。', 'network')
  }
  if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) {
    return wrap('模型服务暂时不可用，请稍后再试。', 'model')
  }
  if (code.indexOf('internal_') === 0) {
    return wrap('服务内部错误' + (err.requestId ? `（请求号 ${err.requestId}）` : '') + '，请稍后重试。', 'internal')
  }
  if (status === 0) return wrap('网络连接失败，请检查网络后重试。', 'network')
  const message = err && err.message ? String(err.message) : ''
  // 预览环境可能只实现了 wx 的一个子集，缺 request 时给出明确说明
  if (message.indexOf('is not a function') !== -1 && message.indexOf('request') !== -1) {
    return wrap(ENV_NO_NETWORK_TEXT, 'env')
  }
  if (message.indexOf('request:fail') !== -1 || message.indexOf('network') !== -1) {
    return wrap('网络连接失败，请检查网络后重试。', 'network')
  }
  return wrap(message || '点评生成失败，请稍后重试。', 'unknown')
}

/** 兼容旧用法：只要给用户看的那句话 */
function describeLLMError(err) {
  return llmErrorInfo(err).message
}

/**
 * 失败后是否值得换个模型再试一次。
 * 只在「换模型可能不一样」的情况下重试：
 *   timeout —— 这个模型太慢，换个快的可能就出来了；
 *   empty   —— 这个模型把预算花在思考上没吐正文（实测 auto 就是），换一个；
 *   model   —— 该模型服务侧异常，换一个。
 * network / auth / quota / request 属于链路或账户层面，换模型不会变好，
 * 重试只会让用户多等一倍时间、多烧一次额度。
 */
function shouldTryNextModel(err, signal) {
  // 用户主动取消：任何情况下都不该偷偷再发一次请求
  if (signal && signal.aborted) return false
  const kind = llmErrorInfo(err).kind
  return kind === 'timeout' || kind === 'empty' || kind === 'model'
}

/**
 * 跑一次流式补全。
 * @returns {Promise<{text:string, servedId:string|null}>}
 */
async function streamCompletion(cloud, params) {
  const onDelta = params.onDelta
  const onModel = params.onModel
  let text = ''
  let servedId = null
  let lastFlush = 0
  const flush = force => {
    if (!onDelta) return
    const now = Date.now()
    if (!force && now - lastFlush < 140) return
    lastFlush = now
    onDelta(text)
  }

  for await (const chunk of cloud.llm.chat.completions.create({
    model: params.modelId,
    messages: params.messages,
    stream: true,
    temperature: 0.6,
    max_tokens: MAX_TOKENS,
    signal: params.signal
  })) {
    // 响应里会声明真正服务的模型（请求 auto 时尤其有用）
    if (chunk && chunk.model) {
      const served = String(chunk.model)
      if (served !== servedId) {
        servedId = served
        if (onModel) onModel(describeModel(params.models, served))
      }
    }
    const choice = chunk && chunk.choices && chunk.choices[0]
    const delta = choice && choice.delta
    // 首帧只有 role，content 为空；只累加真实文本
    if (delta && delta.content) {
      text += delta.content
      flush(false)
    }
  }
  flush(true)
  return { text: text, servedId: servedId }
}

function emptyResponseError(modelId) {
  const err = new Error('模型没有返回内容，请重试。')
  err.error = { code: 'coach_empty_response' }
  err.modelId = modelId
  return err
}

/**
 * 生成中文局面点评（流式）。
 *
 * @param {object} params
 * @param {string} params.fen
 * @param {('w'|'b')} params.sideToMove
 * @param {Array} params.lines        引擎输出的路线
 * @param {(text:string)=>void} [params.onDelta] 增量回调（已节流）
 * @param {(model:{id:string,name:string,provider:string,label:string})=>void} [params.onModel]
 *        本次用到（或将要先用）的模型；换模型重试时会再次回调
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<string>} 完整点评文本
 */
async function requestCoachComment(params) {
  const p = params || {}
  const onDelta = typeof p.onDelta === 'function' ? p.onDelta : null
  const onModel = typeof p.onModel === 'function' ? p.onModel : null

  // 环境探测前置：预览环境未必实现 wx.request，提前给出可读原因
  if (!device.canRequest()) {
    const err = new Error(ENV_NO_NETWORK_TEXT)
    err.error = { code: 'env_no_network' }
    throw err
  }

  const cloud = getCloud()
  const models = await cloud.llm.models.list()
  const usable = (models || []).filter(item => item.disabled !== true)
  if (!usable.length) {
    throw new Error('当前没有可用的模型，暂时无法生成点评。')
  }

  const candidates = buildCandidates(models)
  const messages = [
    { role: 'system', content: COACH_SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(p) }
  ]

  const attempts = Math.max(1, Math.min(MAX_ATTEMPTS, candidates.length))
  let lastError = null

  for (let i = 0; i < attempts; i++) {
    const modelId = candidates[i]
    if (i > 0) {
      // 换模型重试：把上一轮的部分输出清掉，避免两段文字拼在一起
      if (onDelta) onDelta('')
    }
    if (onModel) onModel(describeModel(models, modelId))

    try {
      const result = await streamCompletion(cloud, {
        modelId: modelId,
        models: models,
        messages: messages,
        onDelta: onDelta,
        onModel: onModel,
        signal: p.signal
      })
      if (!result.text.trim()) throw emptyResponseError(modelId)

      // 记住跑通的模型：下次直接用它，省掉一轮试探
      cachedModelId = modelId
      return result.text
    } catch (err) {
      lastError = err
      if (i === attempts - 1 || !shouldTryNextModel(err, p.signal)) throw err
    }
  }

  throw lastError || new Error('点评生成失败，请稍后重试。')
}

/** 清空「上次跑通的模型」记忆（自检用） */
function resetModelChoice() {
  cachedModelId = null
}

module.exports = {
  analyzePosition,
  formatScore,
  evalPercent,
  buildLineView,
  requestCoachComment,
  describeLLMError,
  llmErrorInfo,
  describeModel,
  providerOf,
  buildCandidates,
  resetModelChoice,
  sanitizeFen,
  ENV_NO_NETWORK_TEXT,
  MODEL_PREFERENCE,
  MAX_ATTEMPTS,
  MAX_TOKENS
}
