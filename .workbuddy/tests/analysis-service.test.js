/**
 * analysis-service.test.js
 * 平台化重构的物理拆离验证：analysis-service 作为独立 L0 模块，对外行为
 * 与原来 ai-client 里那一组函数完全一致（docs/平台化产品重构方案.md §11）。
 *
 * 用 node 跑：
 *   node .workbuddy/tests/analysis-service.test.js
 */
'use strict'

const path = require('path')
const H = require('./_harness')

const ROOT = path.join(__dirname, '..', '..')
const svc = require(path.join(ROOT, 'utils', 'analysis-service.js'))

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function main() {
  H.section('formatScore —— 行棋方视角 → 白方视角')
  H.eq(svc.formatScore({ scoreCp: 130, scoreMate: null }, 'w').tone, 'white', '白方正分 → 白优')
  H.eq(svc.formatScore({ scoreCp: 130, scoreMate: null }, 'w').text, '+1.30', '白优带正号')
  H.eq(svc.formatScore({ scoreCp: 130, scoreMate: null }, 'b').tone, 'black', '黑方正分 → 黑优')
  H.eq(svc.formatScore({ scoreCp: 130, scoreMate: null }, 'b').text, '-1.30', '黑优带负号')
  H.eq(svc.formatScore({ scoreCp: 0, scoreMate: null }, 'w').tone, 'even', '零分是均势')
  H.eq(svc.formatScore({ scoreCp: null, scoreMate: 2 }, 'w').tone, 'mate', '有 mate 分数 → tone=mate')
  H.eq(svc.formatScore({ scoreCp: null, scoreMate: 2 }, 'w').text, '#2', '白方两步杀显示 #2')
  H.eq(svc.formatScore({ scoreCp: null, scoreMate: -3 }, 'w').text, '#-3', '白方被杀显示 #-3')
  H.eq(svc.formatScore({ scoreCp: null, scoreMate: 2 }, 'b').text, '#-2', '黑方被将杀（黑视角）显示 #-2')

  H.section('evalPercent —— 优势条百分比')
  H.eq(svc.evalPercent(0), 50, '零分时优势条居中')
  H.eq(svc.evalPercent(99999), 100, '白方绝杀优势拉满')
  H.eq(svc.evalPercent(-99999), 0, '黑方绝杀优势归零')
  H.ok(svc.evalPercent(300) > 50 && svc.evalPercent(-300) < 50, '正负分分居两侧')
  H.eq(svc.evalPercent(null), 50, '空值回退居中')

  H.section('buildLineView —— 展示路线对象')
  const lv = svc.buildLineView({ rank: 1, san: 'e4', from: 'e2', to: 'e4', scoreCp: 25, pvSan: ['e4', 'e7e5', 'Ng1f3'] }, 'w')
  H.eq(lv.rank, 1, 'rank 透传')
  H.eq(lv.san, 'e4', 'san 透传')
  H.eq(lv.pvText, 'e4 e7e5 Ng1f3', 'pvText 取 pvSan 前 4')
  const lvNoPv = svc.buildLineView({ rank: 2, san: 'Nf3', from: 'g1', to: 'f3', scoreCp: -10 }, 'w')
  H.eq(lvNoPv.pvText, 'Nf3', '没有 pvSan 时回退到 san 本身')

  H.section('describeEngineSource —— 来源徽标 + 降级显形')
  const remote = svc.describeEngineSource({ source: 'remote', engineVersion: 'Stockfish 15.1' })
  H.eq(remote.source, 'remote', '标记 remote')
  H.eq(remote.label, '云端 Stockfish 15.1', '徽标带引擎版本')
  H.ok(!remote.degraded, '云端成功不降级')

  const localClean = svc.describeEngineSource({ source: 'local' })
  H.eq(localClean.label, '本地引擎', '本地引擎徽标')
  H.ok(!localClean.degraded, '主动本地无降级提示')

  const degradedNet = svc.describeEngineSource({ source: 'local', degradedFrom: 'ENV_NO_NETWORK' })
  H.ok(degradedNet.degraded && degradedNet.notice.indexOf('网络请求') !== -1, 'ENV_NO_NETWORK 文案正确')

  const degradedGateway = svc.describeEngineSource({ source: 'local', degradedFrom: 'GATEWAY_BLOCK' })
  H.ok(degradedGateway.notice.indexOf('已备案域名') !== -1, 'GATEWAY_BLOCK 提示自有域名')

  const degradedGeneric = svc.describeEngineSource({ source: 'local', degradedFrom: 'ANALYZE_TIMEOUT' })
  H.ok(degradedGeneric.notice.indexOf('云端引擎') !== -1 && degradedGeneric.notice.indexOf('本地引擎') !== -1,
    '普通降级说清「云端 → 本地」')

  H.section('setEngineMode / getEngineMode')
  svc.setEngineMode('local')
  H.eq(svc.getEngineMode(), 'local', '可切到 local')
  svc.setEngineMode('remote')
  H.eq(svc.getEngineMode(), 'remote', '可切到 remote')
  svc.setEngineMode('anything-else')
  H.eq(svc.getEngineMode(), 'remote', '非法值规整为 remote')

  H.section('analyzePosition（local 模式，确定性）')
  svc.setEngineMode('local')
  return svc.analyzePosition({ fen: START_FEN, depth: 2, multiPV: 3 }).then(result => {
    H.eq(result.source, 'local', 'local 模式来源标记 local')
    H.ok(Array.isArray(result.lines) && result.lines.length >= 1, '至少产出 1 条路线')
    H.ok(result.lines.length <= 3, '不超过请求的 3 线')
    const first = result.lines[0]
    H.ok(first && typeof first.san === 'string' && first.san.length > 0, '首线有 san')
    H.ok(first && typeof first.from === 'string' && typeof first.to === 'string', '首线有 from/to')
    H.eq(result.sideToMove, 'w', '起始局面行棋方为白')
    return true
  })
}

main().then(() => {
  H.summary('analysis-service.test.js')
}).catch(err => {
  console.error(err)
  process.exit(1)
})
