/**
 * coach-runner.js · L0：AI 点评编排器（被 play / replay / analyze 复用的单一实现）。
 *
 * 把「候选预取 → 流式生成 → 演示线落地 → 解析 → 富文本切片」全流程封装在这里，
 * 通过回调把结果交回页面 setData，避免每个模式 page 各写一遍（看板 L2-T6 接受标准：复用 L0 服务、无重复实现）。
 *
 * 复用：
 *   - coach-service（云端 LLM）：buildToolContext / requestCoachComment / groundDemoLines
 *   - comment-model（解析/富文本）：parseDemo / tokenizeText
 * 不依赖 wx / DOM / Canvas，可纯 Node 单测；网络与 wx 能力由 cloud / coach-service 内部探测降级。
 *
 * 取消语义：调用方传入 AbortSignal；被用户取消时 requestCoachComment 会 reject（AbortError），
 * 这里识别 signal.aborted 后**静默返回**，不回调 onError——取消不是失败。
 */
const ai = require('./ai-client')
const coachDemo = require('./comment-model')

/**
 * 跑一次点评。所有结果通过回调交回页面（页面负责 setData 与交互态）。
 *
 * @param {object} params
 *   fen, sideToMove, lines（引擎三线，用于喂给模型）, result（原始分析结果，用于候选预取；可空）
 *   onStarted(), onDelta(text), onModel(info)
 *   onResult({ coachText, coachSegments, parsed }), onError({message,detail,kind}), onWarn(msg)
 *   signal(AbortSignal)
 */
async function runCoachComment(params) {
  const p = params || {}
  const onStarted = typeof p.onStarted === 'function' ? p.onStarted : function () {}
  const onDelta = typeof p.onDelta === 'function' ? p.onDelta : null
  const onModel = typeof p.onModel === 'function' ? p.onModel : null
  const onResult = typeof p.onResult === 'function' ? p.onResult : function () {}
  const onError = typeof p.onError === 'function' ? p.onError : function () {}
  const onWarn = typeof p.onWarn === 'function' ? p.onWarn : function () {}
  const signal = p.signal
  const fen = p.fen
  const sideToMove = p.sideToMove
  const lines = p.lines || []

  onStarted()

  // 阶段一 · Candidate Grounding：优先复用已有分析结果，零额外搜索
  let toolCtx = { candidates: [], text: '' }
  try {
    toolCtx = await ai.buildToolContext(fen, p.result, { topN: 6 })
  } catch (e) {
    onWarn('候选预取失败，降级为旧格式：' + ((e && e.message) || e))
  }

  try {
    const text = await ai.requestCoachComment({
      fen: fen,
      sideToMove: sideToMove,
      lines: lines,
      candidateText: toolCtx.text,
      onDelta: onDelta,
      onModel: onModel,
      signal: signal
    })
    // 用户主动取消：请求层会 reject，但这里先于 onResult 拦截，避免把中断当结果
    if (signal && signal.aborted) return

    // 阶段一 · 把模型输出的 cand + extend 落地为端上生成的真实走法
    let parseText = text
    try {
      const ground = await ai.groundDemoLines(text, toolCtx.candidates, fen)
      if (ground.warnings && ground.warnings.length) {
        ground.warnings.forEach(w => onWarn(w))
      }
      parseText = ground.text
    } catch (e) {
      onWarn('演示线落地失败，降级为旧解析：' + ((e && e.message) || e))
    }

    const parsed = coachDemo.parseDemo(parseText, fen)
    onResult({
      coachText: parsed.prose,
      coachSegments: coachDemo.tokenizeText(parsed.prose, { lines: parsed.lines, colorMode: 'branch' }) || [],
      parsed: parsed
    })
  } catch (err) {
    if (signal && signal.aborted) return
    const info = ai.llmErrorInfo(err)
    onError({ message: info.message, detail: info.detail, kind: info.kind })
  }
}

module.exports = { runCoachComment }
