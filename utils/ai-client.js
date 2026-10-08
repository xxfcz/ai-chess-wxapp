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
const tools = require('./tools')
const coachDemo = require('./coach-demo')
const { Chess } = require('./chess.js')
const { getCloud } = require('./cloud')

const COACH_SYSTEM_PROMPT = [
  '你是一名国际象棋教练，面向中文用户讲解局面。',
  '只输出点评正文，不要复述这些要求，不要输出 Markdown 标题或代码块。',
  '基于给出的引擎数据说话，不要编造不存在的走法或子力。',
  '语气专业、简洁，控制在 3 到 5 句话、150 字以内。',
  '',
  '点评正文之后，若局面存在可选的后续走法，请补充一段「走法演示」数据，格式严格如下（不要使用 Markdown 代码块、不要加解释）：',
  '===DEMO===',
  '{"lines":[{"id":"main","label":"主线走法","tone":"good","desc":"一句话点评要点（不超过 40 字）","base":"root","cand":"#1","extend":2}]}',
  '===END===',
  '规则：lines 最多 3 条；tone 取 good（推荐）/ bad（避免）/ neutral（中性应对）；',
  '每条线必须带 desc：一句中文短语点评这条线的好坏与要点（不超过 40 字）；',
  '被点评局面下你最推荐的走法也必须作为一条 tone=good 的线输出（即使正文已经提到它），不要只写进正文；',
  '',
  '【重要】演示线的走法由系统生成，你只负责挑选，绝不自己拼写任何走法（SAN）：',
  '  - cand：从下方「合法候选」段落里选一个 #编号（必填，且必须真实存在于候选表中）；',
  '  - extend：在该候选之后，由系统用引擎最佳应对再展开几手（0~4，默认 0）；',
  '  - 禁止在 moves 字段里写任何走法，也禁止在 desc 里写具体着法；系统会自动把候选走法、',
  '    格子名（如 e5、h2）、棋子名（如「黑后」「d6象」「f3马」）变成可点链接，不要自己加标记；',
  '  - desc 里若想说明某个后续局面，用棋子名或格子名描述，不要写走法。',
  '一条线若从另一条线走几步后的局面继续，用 base:{"line":"<那条线的 id>","ply":<第几手，从 1 起>} 指明起点，从被点评局面起则写 "root" 或省略；',
  '若没有合适的演示线，直接不输出 ===DEMO=== 段。'
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
/** 点评只需要三五句话，限住输出长度可以显著缩短等待时间；
 *  留出余量给可选的 ===DEMO=== 结构化演示线（含每条线的 desc 短评） */
const MAX_TOKENS = 768

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

  const candidateText = typeof params.candidateText === 'string' && params.candidateText
    ? '\n' + params.candidateText
    : ''

  return [
    `局面 FEN：${fen}`,
    `轮到${side}行棋。`,
    '引擎给出的候选路线：',
    rows.join('\n') || '（引擎未给出路线）',
    '',
    `请点评：这个局面的核心矛盾是什么？首选路线 ${lines.length ? lines[0].san : '—'} 好在哪里？`,
    `最后给${side}一条具体的行棋建议。`,
    candidateText
  ].join('\n')
}

/* --------------------------------------------------- 阶段一 · Candidate Grounding */

/** 从 FEN 推出行棋方（缺省白） */
function guessSide(fen) {
  const parts = typeof fen === 'string' ? fen.split(' ') : []
  return parts[1] === 'b' ? 'b' : 'w'
}

/**
 * 阶段一 · 把端上已分析出的候选路线整理成「模型可引用的候选表」，
 * 并返回拼进 user prompt 的候选段落文本（便于单测与锁定 token 预算）。
 *
 * 成本为零：优先复用传入的已有分析结果（页面 _lastResult，含 3 条线及其 PV）；
 * 仅当 lines 缺失（例如用户尚未触发分析就点点评）时才补跑一次轻量搜索（R-场景）。
 *
 * @param {string} fen
 * @param {object} result 引擎 analyze 结果（含 lines / sideToMove），可空
 * @param {object} [opts] { topN }
 * @returns {Promise<{ candidates: Array, text: string }>}
 */
async function buildToolContext(fen, result, opts) {
  opts = opts || {}
  const topN = typeof opts.topN === 'number' && opts.topN > 0 ? Math.min(opts.topN, 8) : 6

  const lines = (result && result.lines) || []
  let side = (result && result.sideToMove) || guessSide(fen)
  let engLines = lines

  // 缺少分析结果：补跑一次轻量搜索（仅此一种情况会触发额外引擎调用）
  if (!engLines.length) {
    try {
      const r = await engine.analyze({ fen: fen, depth: 2, multiPV: 3 })
      engLines = r.lines || []
      if (!side || side === 'w') side = r.sideToMove || 'w'
    } catch (e) {
      engLines = []
    }
  }
  const sideToMove = side || 'w'

  const candidates = []
  const usedUci = new Set()
  engLines.slice(0, 3).forEach(ln => {
    const score = formatScore(ln, sideToMove)
    candidates.push({
      no: candidates.length + 1,
      san: ln.san,
      uci: ln.uci,
      whiteCp: score.whiteCp,
      scoreText: score.text,
      next: (ln.pvSan || []).slice(1, 3),
      pv: ln.pv || [],
      pvSan: ln.pvSan || [],
      inferior: false
    })
    usedUci.add(ln.uci)
  })

  // 显式保留一个劣手候选，给模型的 AVOID 对比线一个安全的负面样本
  const allLegal = tools.legalMoves(fen, {})
  if (candidates.length < topN) {
    const inferior = allLegal.find(m => !usedUci.has(m.uci))
    if (inferior) {
      candidates.push({
        no: candidates.length + 1,
        san: inferior.san,
        uci: inferior.uci,
        whiteCp: null,
        scoreText: '（劣手，可作对比）',
        next: [],
        pv: [],
        pvSan: [],
        inferior: true
      })
      usedUci.add(inferior.uci)
    }
  }

  // 仍不足 topN：用其余合法走法补足（标记「备选」，无评分，避免过度占用预算）
  let guard = 0
  while (candidates.length < topN && guard < 64) {
    guard++
    const extra = allLegal.find(m => !usedUci.has(m.uci))
    if (!extra) break
    candidates.push({
      no: candidates.length + 1,
      san: extra.san,
      uci: extra.uci,
      whiteCp: null,
      scoreText: '（备选）',
      next: [],
      pv: [],
      pvSan: [],
      inferior: false
    })
    usedUci.add(extra.uci)
  }

  return { candidates: candidates, text: buildCandidatePrompt(candidates) }
}

/** 把候选表拼成喂给模型的紧凑段落（不易误读、限 token） */
function buildCandidatePrompt(candidates) {
  const rows = (candidates || []).map(c => {
    const scorePart = c.whiteCp != null ? ('白方视角 ' + c.scoreText) : c.scoreText
    const nextPart = (c.next && c.next.length) ? ('  后续 ' + c.next.join(' ')) : ''
    return '#' + c.no + ' ' + c.san + '  ' + scorePart + nextPart
  })
  return [
    '合法候选（供演示线引用，编号前的 # 不要写进 desc；禁止自行拼写任何走法，只能引用下面的 #编号）：',
    rows.join('\n')
  ].join('\n')
}

/** 从点评文本里取出 ===DEMO=== ... ===END=== 块与其边界 */
function extractDemoBlock(text) {
  const t = typeof text === 'string' ? text : ''
  const start = t.indexOf(coachDemo.DEMO_START)
  if (start < 0) return null
  const rest = t.slice(start + coachDemo.DEMO_START.length)
  const end = rest.indexOf(coachDemo.DEMO_END)
  const jsonStr = (end >= 0 ? rest.slice(0, end) : rest).trim()
  const absEnd = end >= 0
    ? start + coachDemo.DEMO_START.length + end + coachDemo.DEMO_END.length
    : t.length
  return { jsonStr: jsonStr, start: start, end: absEnd }
}

/** 把一个候选落子从某局面起，落地为真实 SAN 序列（优先用自带 PV，零额外搜索） */
async function groundFromCand(cand, startFen, extend, depth) {
  extend = Math.max(0, Math.min(extend | 0, 4))
  const cont = (cand.pvSan || []).slice(1, 1 + extend)

  // 优先复用候选自带 PV（D4：零额外搜索），续手即引擎最佳应对
  const chess = new Chess()
  const check = chess.validate_fen(startFen)
  if (check && check.valid === true) {
    chess.load(startFen)
    let ok = true
    const seed = tools.applyMove(chess, cand.uci)
    if (!seed) ok = false
    if (ok) {
      const moves = [cand.san]
      for (let i = 0; i < cont.length; i++) {
        const m = tools.applyMove(chess, cont[i])
        if (!m) { ok = false; break }
        moves.push(m.san)
      }
      if (ok && moves.length === 1 + extend) return moves
    }
  }

  // PV 不够长 / 起点不可行：用引擎最佳应对兜底展开（仍落在端上、保证合法）
  const res = await tools.expandLine(startFen, [cand.uci], { depth: depth, extend: extend })
  return res.path.map(p => p.san).slice(0, 1 + extend)
}

/** 候选就近纠正：# 编号优先；否则按 SAN / UCI 文本命中 */
function resolveCand(candStr, candByNo, candidates) {
  const s = String(candStr == null ? '' : candStr).trim()
  if (!s) return null
  if (s.charAt(0) === '#') {
    const c = candByNo[s]
    if (c) return c
  }
  const upper = s.toUpperCase()
  const bySan = (candidates || []).find(c => c && c.san && c.san.toUpperCase() === upper)
  if (bySan) return bySan
  return (candidates || []).find(c => c && c.uci && c.uci.toUpperCase() === upper) || null
}

/**
 * 阶段一 · 把模型输出的 cand + extend 落地为端上生成的真实走法序列。
 *
 * 输入：模型原始点评文本（含 ===DEMO=== 块）。
 * 输出：{ text, warnings } —— text 为「候选已替换为真实 moves 的等价文本」，可直接喂给
 *       coachDemo.parseDemo（输入结构不变）。warnings 供运行日志留痕。
 *
 * 设计要点（agent-phase1 §5.4 / §5.5）：
 *   - 候选续手优先复用候选自带的 PV（零额外搜索），PV 不够长时再用 expandLine 兜底；
 *   - cand 非法（编号不存在 / 写成走法文本）走「就近纠正」：按 SAN 命中候选 → 否则该线降级丢弃；
 *   - 仍走旧 moves 格式的线直接透传，交给 parseDemo 的 resolveMoves 做既有截断容错（R3）；
 *   - 所有线都失败 → 返回原文本（交 parseDemo 静默降级为无演示线，正文不受影响）。
 *
 * @param {string} text 模型原始点评文本
 * @param {Array} candidates buildToolContext 产出的候选表
 * @param {string} fen 被点评局面 FEN
 * @param {object} [opts] { depth }
 * @returns {Promise<{ text: string, warnings: string[] }>}
 */
async function groundDemoLines(text, candidates, fen, opts) {
  opts = opts || {}
  const depth = typeof opts.depth === 'number' && opts.depth > 0 ? opts.depth : 3
  const warnings = []

  const block = extractDemoBlock(text)
  if (!block) return { text: text, warnings: warnings }

  let data
  try {
    data = JSON.parse(block.jsonStr)
  } catch (e) {
    warnings.push('DEMO JSON 解析失败，演示线降级为无（正文保留）')
    return { text: text, warnings: warnings, degraded: true }
  }

  const rawLines = Array.isArray(data.lines) ? data.lines : []
  if (!rawLines.length) return { text: text, warnings: warnings }

  const candByNo = {}
  ;(candidates || []).forEach(c => { if (c && c.no != null) candByNo['#' + c.no] = c })
  const byId = {}
  rawLines.forEach(item => { if (item && typeof item.id === 'string') byId[item.id] = item })

  const grounded = []
  for (let i = 0; i < rawLines.length; i++) {
    const g = await groundOneLine(rawLines[i], candByNo, candidates, fen, depth, byId)
    if (g) { grounded.push(g); byId[g.id] = g }
    else warnings.push('线「' + ((rawLines[i] && rawLines[i].id) || '?') + '」无法落地，已降级丢弃')
  }

  if (!grounded.length) {
    warnings.push('所有演示线均无法落地，降级为无演示线')
    return { text: text, warnings: warnings, degraded: true }
  }

  const newJson = JSON.stringify({
    lines: grounded.map(g => ({
      id: g.id, label: g.label, tone: g.tone, desc: g.desc, base: g.base, moves: g.moves
    }))
  })
  const newText = text.slice(0, block.start) + coachDemo.DEMO_START + '\n' +
    newJson + '\n' + coachDemo.DEMO_END + text.slice(block.end)
  return { text: newText, warnings: warnings }
}

async function groundOneLine(item, candByNo, candidates, fen, depth, byId) {
  if (!item || typeof item !== 'object') return null
  const id = typeof item.id === 'string' && item.id ? item.id : ('line' + Math.random().toString(36).slice(2, 7))
  const tone = item.tone === 'bad' || item.tone === 'good' ? item.tone : 'neutral'
  const label = typeof item.label === 'string' && item.label
    ? item.label
    : (tone === 'good' ? '推荐走法' : tone === 'bad' ? '避免走法' : '演示线')
  const desc = typeof item.desc === 'string' ? item.desc.trim().slice(0, 80) : ''
  const base = (item.base === 'root' || item.base === undefined || item.base === null)
    ? 'root'
    : (item.base && typeof item.base === 'object' ? item.base : 'root')

  // base 引用另一条线：从那条线走几手后的局面继续（沿用现有语义）
  let startFen = fen
  if (base !== 'root') {
    const parent = (typeof base.line === 'string') ? byId[base.line] : null
    if (!parent) return null // 父线不存在 → 该线降级丢弃（warning 由调用方记录）
    // 注意：base+root候选的组合极为罕见且通常非法，交由 groundFromCand 自然丢弃；
    // 旧 moves 格式则保持 continuation，由 parseDemo 的 resolveMoves 重放 base 前缀。
    const ply = (typeof base.ply === 'number' && base.ply > 0)
      ? Math.min(base.ply, parent.moves.length) : parent.moves.length
    startFen = replayFen(fen, parent.moves.slice(0, ply)) || fen
  }

  let moves = []
  if (item.cand != null && String(item.cand) !== '') {
    const cand = resolveCand(item.cand, candByNo, candidates)
    if (!cand) return null // 候选无法解析 → 该线降级丢弃
    const extend = typeof item.extend === 'number' ? item.extend : 0
    moves = await groundFromCand(cand, startFen, extend, depth)
    if (!moves.length) return null
  } else if (Array.isArray(item.moves) && item.moves.length) {
    // 旧格式：原样透传，交给 parseDemo 的 resolveMoves 截断容错（R3）
    moves = item.moves.slice(0, 8).map(s => (typeof s === 'string' ? s.trim() : ''))
  } else {
    return null // 既无 cand 也无 moves → 丢弃
  }

  return { id: id, label: label, tone: tone, desc: desc, base: base, moves: moves }
}

/** 在 fen 基础上连续施加若干 SAN，返回新局面 FEN（任一非法返回 null） */
function replayFen(fen, sans) {
  const chess = new Chess()
  const check = chess.validate_fen(fen)
  if (!check || check.valid !== true) return null
  chess.load(fen)
  for (let i = 0; i < (sans || []).length; i++) {
    try {
      if (!chess.move(sans[i])) return null
    } catch (e) {
      return null
    }
  }
  return chess.fen()
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
  const cause = causeOf(err)
  // 把 HTTP 状态码带进排查详情（例如预览环境网络层回 404 时，能看到 HTTP 404 而不是裸的 Not found）
  const statusTag = (typeof status === 'number' && status) ? `HTTP ${status} · ` : ''
  const detail = (statusTag + (code ? code + (cause ? ' · ' + cause : '') : cause)).trim()

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
  // 404：云端接口路径不存在。多发生在「预览环境网络层无法真正访问该服务」时
  // （返回的是 404 的 statusText/正文 “Not found”，而非云端规范 JSON 错误），
  // 既不是模型故障，也不是本端代码问题——端上引擎分析不受影响。
  if (status === 404) {
    return wrap('云端接口返回 404（未找到）。这通常是预览环境的网络层无法访问该云服务接口所致，端上引擎分析不受影响；请在微信开发者工具或真机上重试「生成点评」。', 'notfound')
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
  // Agent 化阶段二要把重试粒度从「单次请求」上提到「会话层」，
  // 这个函数届时会被重写，先导出以便有回归测试兜底。
  shouldTryNextModel,
  sanitizeFen,
  ENV_NO_NETWORK_TEXT,
  MODEL_PREFERENCE,
  MAX_ATTEMPTS,
  MAX_TOKENS,
  // 阶段一 · Candidate Grounding
  buildToolContext,
  groundDemoLines,
  buildCandidatePrompt
}
