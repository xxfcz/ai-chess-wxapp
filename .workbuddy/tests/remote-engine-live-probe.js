/**
 * remote-engine-live-probe.js
 * 一次性真实探针：用真实网络打自建 ai-chess-server，验证「小程序 ↔ 云端引擎」端到端。
 *
 * ⚠️ 不属常规回归（需要网络、消耗服务端算力），跑完可删。
 * 常规回归用 .workbuddy/tests/remote-engine.test.js（打桩 wx.request，零网络）。
 *
 * 跑法：node .workbuddy/tests/remote-engine-live-probe.js
 */
'use strict'

const path = require('path')
const remote = require(path.resolve(__dirname, '../../utils/remote-engine.js'))
const debugLog = require(path.resolve(__dirname, '../../utils/debug-log.js'))
const ai = require(path.resolve(__dirname, '../../utils/ai-client.js'))

/** 用 node 的 fetch 顶一个 wx.request（小程序里用的是微信同名的那个接口） */
function installWx() {
  global.wx = {
    request(options) {
      const startedAt = Date.now()
      fetch(options.url, {
        method: options.method || 'GET',
        headers: options.header || {},
        body: typeof options.data === 'string' ? options.data : undefined
      })
        .then(async res => {
          const text = await res.text()
          let data = text
          try {
            data = JSON.parse(text)
          } catch (e) {
            // 保持字符串，remote-engine 自己会再试一次解析
          }
          options.success({
            statusCode: res.status,
            data: data,
            __ms: Date.now() - startedAt
          })
        })
        .catch(err => {
          options.fail({ errMsg: 'request:fail ' + (err && err.message ? err.message : 'network') })
        })
    }
  }
}

function show(label, result) {
  const src = ai.describeEngineSource(result)
  console.log('\n--- ' + label + ' ---')
  console.log('来源       : ' + src.source + '（徽标：' + src.label + '）')
  if (result.degradedFrom) console.log('降级原因   : ' + result.degradedFrom + ' · ' + (result.degradedReason || ''))
  console.log('引擎/深度  : ' + result.engine + (result.engineVersion ? ' ' + result.engineVersion : '') +
    ' · depth ' + result.depth + ' · ' + result.elapsedMs + 'ms')
  if (result.terminal) console.log('终局       : ' + result.terminal.label)
  ;(result.lines || []).forEach(l => {
    console.log('  #' + l.rank + ' ' + l.san +
      '  scoreCp=' + l.scoreCp + ' scoreMate=' + l.scoreMate +
      '  pv=' + (l.pvSan || []).slice(0, 6).join(' '))
  })
  if (src.notice) console.log('界面提示   : ' + src.notice)
}

async function main() {
  debugLog.install()
  installWx()

  console.log('端点：' + remote.DEFAULT_ENDPOINT + '/v1')

  // 1) 中局三线
  show('中局 · 意大利开局', await remote.analyze({
    fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
    depth: 3,
    multiPV: 3
  }))

  // 2) 轮黑走且黑方大劣：scoreCp 必须为负（视角没搞反）
  show('黑方缺后 · 轮黑走', await remote.analyze({
    fen: 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1',
    depth: 3,
    multiPV: 3
  }))

  // 3) 一步杀
  show('一步杀 Ra8#', await remote.analyze({
    fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
    depth: 3,
    multiPV: 3
  }))

  // 4) 终局：本地前置拦截，不该产生请求
  show('终局（愚人杀，轮白已被将死）', await remote.analyze({
    fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
    depth: 3,
    multiPV: 3
  }))

  // 5) 服务端不可达：自动回落本地
  remote.reset()
  remote.configure({ endpoint: 'https://127.0.0.1:1', timeoutMs: 2000 })
  show('服务端不可达（应回落本地）', await remote.analyze({
    fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
    depth: 2,
    multiPV: 3
  }))

  console.log('\n引擎状态：' + JSON.stringify(remote.state()))

  console.log('\n--- 运行日志（界面「运行日志」卡片同款） ---')
  console.log(debugLog.text())
}

main().catch(err => {
  console.error('探针异常：', err)
  process.exitCode = 1
})
