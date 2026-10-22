/**
 * ai-client.js
 * AI 分析的门面层（facade）。
 *
 * 平台化重构后，原本堆在这里的「分析呈现」与「AI 点评」逻辑已物理拆成两个 L0 平台模块：
 *   - analysis-service.js  —— 引擎分析的读取与呈现（3 线 MultiPV + 行棋方/白方视角换算 + 优势条 + 节点级缓存）
 *   - coach-service.js     —— 云端 AI 点评（流式 LLM + 阶段一 Candidate Grounding + 演示线落地）
 *
 * 本文件只做「门面收口」：把两个服务的导出合并，并确保需要直接暴露的 `remoteEngine`
 * 仍按原样可被页面与回归测试访问（analyze-page.test.js 用 ai.remoteEngine.reset()）。
 *
 * ⚠️ 对外导出集合必须与历史版本完全一致（回归门禁依赖它），不要新增/删除导出项。
 *   既有的 `coach` 标识符不在此处重命名（见 working-memory 命名约定）。
 */
const analysisService = require('./analysis-service')
const coachService = require('./coach-service')
const remoteEngine = require('./remote-engine')

module.exports = Object.assign({}, analysisService, coachService, {
  // 历史导出项：远端引擎适配层（回归测试 ai.remoteEngine.reset() 依赖）
  remoteEngine: remoteEngine
})
