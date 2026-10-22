/**
 * analysis-service.js  —— L0 平台层：引擎分析的「读取与呈现」服务
 *
 * 这是平台化重构从 ai-client.js 物理拆出的第一块（docs/平台化产品重构方案.md §11）：
 *   - engine-service（engine.js 端上 + remote-engine.js 云端，经 analyzePosition 收口）只负责**算**——
 *     问引擎要 N 条原始路线（lines[]），它并不知道「3 线」这个业务语义。
 *   - analysis-service 负责**读**——把 N 条原始路线整理成「3 线 + 行棋方/白方视角换算 +
 *     评估条百分比 + 优劣 tone」，并支持**节点级缓存**（走子树每个节点缓存分析结果）。
 *
 * 引擎输出的字段与 UCI/Stockfish 同构，因此后续替换为真实引擎时，本文件与页面都不需要改动。
 * 本模块只依赖规则层与引擎层，不依赖云服务/云 SDK，可单独纯 Node 单测。
 */
const engine = require('./engine')
const remoteEngine = require('./remote-engine')
const engineConfig = require('./engine-config')
const debugLog = require('./debug-log')

/**
 * 能力开关 `engine`（docs/能力开关与功能矩阵.md）：
 *   - `remote`：优先云端 Stockfish，失败/超时自动回落端上（默认）；
 *   - `local`：只用端上引擎（离线、自检、或不想依赖网络时）。
 *
 * 注意它调的是**强度**不是有无：两端都有引擎，`local` 是一个弱引擎，不是没有引擎。
 */
// 初始值也走外部配置（.env 的 ENGINE_MODE / 本地缓存），见 utils/engine-config.js
let engineMode = engineConfig.resolveEngineMode()

function setEngineMode(mode) {
  engineMode = mode === 'local' ? 'local' : 'remote'
}

function getEngineMode() {
  return engineMode
}

/**
 * @param {object} params { fen, depth, multiPV, onProgress }
 * @returns {Promise<object>} engine.analyze 的结果，额外带 `source`（'remote' | 'local'）
 *
 * 远端路径内部已包含终局拦截、失败回落与熔断，正常不抛错；
 * 真抛了（非法 FEN 之类）也再给本地一次机会，保证界面不空。
 */
async function analyzePosition(params) {
  const p = params || {}
  const opts = {
    fen: p.fen,
    depth: p.depth,
    multiPV: p.multiPV || 3,
    onProgress: p.onProgress
  }

  if (engineMode === 'remote') {
    try {
      return await remoteEngine.analyze(opts)
    } catch (err) {
      debugLog.push('warn', '[引擎] 远端请求被拒绝，改用本地引擎 · ' +
        ((err && (err.code || err.message)) || 'unknown'))
    }
  }

  const local = await engine.analyze(opts)
  return Object.assign({}, local, { source: 'local' })
}

/**
 * 把分析结果翻译成界面要显示的三件事：来源徽标文案 + 降级提示。
 *
 * 「降级必须显形」（能力开关文档铁律 3）：远端挂了不能静默变成本地结果，
 * 必须在界面上说清楚缺了什么、评分精度会下降。
 *
 * @param {object} result analyzePosition 的结果
 * @returns {{ source:string, label:string, notice:string, degraded:boolean }}
 */
function describeEngineSource(result) {
  const r = result || {}
  const remote = r.source === 'remote'
  let label = remote ? '云端引擎' : '本地引擎'
  if (remote && r.engineVersion) label = '云端 ' + r.engineVersion

  let notice = ''
  if (!remote && r.degradedFrom) {
    if (r.degradedFrom === 'ENV_NO_NETWORK') {
      notice = '当前环境不允许网络请求，已使用本地引擎（棋力较弱，评分仅供参考）。'
    } else if (r.degradedFrom === 'GATEWAY_BLOCK') {
      // 后端地址在这个微信环境里根本连不出去（预览只允许 /.cloud/ 路径、真机被网关拦截、
      // 或地址未配进 request 合法域名）：不是服务器故障，重试和熔断都没用。
      // 正式版需 https + 自有已备案域名，详见 docs/自建引擎服务部署方案.md
      notice = '当前引擎后端地址在这个环境里无法访问（未配合法域名或被网关拦截），' +
        '已改用本地引擎（棋力较弱，评分仅供参考）。正式版请改用自有已备案域名（https）部署引擎服务。'
    } else {
      notice = '云端引擎' + remoteEngine.reasonText(r.degradedFrom) +
        '，已自动改用本地引擎（棋力较弱，评分仅供参考）。'
    }
  }

  return {
    source: remote ? 'remote' : 'local',
    label: label,
    notice: notice,
    degraded: !!notice
  }
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

module.exports = {
  analyzePosition,
  setEngineMode,
  getEngineMode,
  describeEngineSource,
  formatScore,
  evalPercent,
  buildLineView
}
