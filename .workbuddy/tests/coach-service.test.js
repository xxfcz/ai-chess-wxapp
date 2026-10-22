/**
 * coach-service.test.js
 * 平台化重构的物理拆离验证：coach-service 作为独立 L0 模块（云端点评 + 阶段一
 * Candidate Grounding + 演示线落地），对外行为与原来 ai-client 里一致
 * （docs/平台化产品重构方案.md §11）。
 *
 * 注意：不依赖云服务/云 SDK；buildToolContext 优先复用传入分析结果，
 * 只在无结果时才跑轻量引擎搜索。本测试一律传入 result，避免联网与长耗时。
 *
 * 用 node 跑：
 *   node .workbuddy/tests/coach-service.test.js
 */
'use strict'

const path = require('path')
const H = require('./_harness')

const ROOT = path.join(__dirname, '..', '..')
const svc = require(path.join(ROOT, 'utils', 'coach-service.js'))

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

async function main() {
  H.section('buildCandidatePrompt —— 候选段落文本')
  const candText = svc.buildCandidatePrompt([
    { no: 1, san: 'e4', whiteCp: 25, scoreText: '+0.25', next: ['e7e5'] },
    { no: 2, san: 'd4', whiteCp: null, scoreText: '（备选）', next: [] }
  ])
  H.ok(candText.indexOf('合法候选') !== -1, '段落带引导语')
  H.ok(candText.indexOf('#1 e4') !== -1, '含 #1 候选')
  H.ok(candText.indexOf('#2 d4') !== -1, '含 #2 候选')

  H.section('buildToolContext —— 阶段一 Candidate Grounding')
  const result = {
    sideToMove: 'w',
    lines: [
      { rank: 1, san: 'e4', uci: 'e2e4', scoreCp: 25, pvSan: ['e4', 'e7e5', 'Ng1f3'] },
      { rank: 2, san: 'd4', uci: 'd2d4', scoreCp: 20, pvSan: ['d4', 'd7d5'] },
      { rank: 3, san: 'Nf3', uci: 'g1f3', scoreCp: 15, pvSan: ['Nf3', 'd7d5'] }
    ]
  }
  const { candidates, text } = await svc.buildToolContext(START_FEN, result, { topN: 6 })
  H.eq(candidates.length, 6, '补齐到 topN=6（3 优 + 1 劣 + 2 备选）')
  H.ok(candidates.slice(0, 3).every(c => c.inferior === false && c.whiteCp != null), '前 3 条是带评分的优手')
  const inferior = candidates.find(c => c.inferior === true)
  H.ok(inferior && inferior.whiteCp === null, '显式保留一个劣手候选作对比')
  H.ok(candidates.slice(0, 3).every(c => c.no >= 1), '候选带连续编号')
  H.ok(text.indexOf('合法候选') !== -1 && text.indexOf('#1 e4') !== -1, '候选段落文本可拼进 user prompt')

  H.section('groundDemoLines —— 候选落地为真实走法')
  const grounded = await svc.groundDemoLines(
    '点评正文\n===DEMO===\n' +
    JSON.stringify({ lines: [{ id: 'main', label: '主线', tone: 'good', desc: '好棋', base: 'root', cand: '#1', extend: 1 }] }) +
    '\n===END===',
    candidates,
    START_FEN,
    { depth: 3 }
  )
  H.eq(grounded.warnings.length, 0, '合法 cand 落地无警告')
  const gm = JSON.parse(grounded.text.slice(grounded.text.indexOf('===DEMO===') + '===DEMO==='.length, grounded.text.indexOf('===END===')).trim())
  H.ok(gm.lines[0].moves.length === 2, 'cand+extend(1) 落地为 2 手真实 SAN')
  H.eq(gm.lines[0].moves[0], 'e4', '首手是候选走法 e4')
  H.eq(gm.lines[0].moves[1], 'e5', '续手来自候选自带 PV（落为 SAN）')

  H.section('groundDemoLines —— 失败与透传')
  const dropped = await svc.groundDemoLines(
    '正文\n===DEMO===\n' +
    JSON.stringify({ lines: [{ id: 'x', label: 'x', tone: 'bad', desc: '坏', base: 'root', cand: '#9', extend: 0 }] }) +
    '\n===END===',
    candidates,
    START_FEN
  )
  H.ok(dropped.warnings.length > 0 && dropped.degraded === true, 'cand 不存在 → 线降级丢弃并告警')

  const passthrough = await svc.groundDemoLines('纯正文无演示线', candidates, START_FEN)
  H.eq(passthrough.text, '纯正文无演示线', '无 DEMO 块时文本原样返回')
  H.eq(passthrough.warnings.length, 0, '无 DEMO 块无警告')
}

main().then(() => {
  H.summary('coach-service.test.js')
}).catch(err => {
  console.error(err)
  process.exit(1)
})
