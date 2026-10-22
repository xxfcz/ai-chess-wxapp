/**
 * remote-engine.test.js
 * 远端引擎适配层的回归测试（打桩 wx.request，不产生真实网络请求）。
 *
 * 覆盖口径见 E:\WorkBuddy\ai-chess-server\docs\05-小程序接入协议.md §11：
 *   1. 分数视角不搞反（lines[] 直取，不换算）；
 *   2. 杀棋 scoreMate 正确；
 *   3. 三线 rank/pvSan 完整；
 *   4. 终局与非法 FEN 不发远端；
 *   5. 回落显形（source / degradedFrom）；
 *   6. 判错看 body.type，不能只看 HTTP 状态码。
 *
 * 跑法：node .workbuddy/tests/remote-engine.test.js
 */
'use strict'

const path = require('path')
const H = require('./_harness')

const REMOTE = path.resolve(__dirname, '../../utils/remote-engine.js')
const ENGINE = path.resolve(__dirname, '../../utils/engine.js')
const remote = require(REMOTE)
const engine = require(ENGINE)

const MIDDLE_FEN = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'
/** 愚人杀：白方已被将死（轮白走，无合法着法） */
const MATE_FEN = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'

/* ------------------------------------------------------------------ 打桩 */

/** 装一个可编排的 wx.request；handler 决定这次请求成功还是失败 */
function installWx(handler) {
  const calls = []
  global.wx = {
    request(options) {
      calls.push(options)
      handler(options, calls.length)
    },
    __calls: calls
  }
  return calls
}

function calls() {
  return (global.wx && global.wx.__calls) || []
}

/** 分析请求（POST /v1）——版本探测是另一个 GET，统计请求次数时别混在一起 */
function analysisCalls() {
  return calls().filter(c => c.method === 'POST')
}

/** 版本探测请求（GET /healthz） */
function probeCalls() {
  return calls().filter(c => c.url.indexOf('/healthz') !== -1)
}

/** 假本地引擎：不跑真搜索（真搜索要几百毫秒且与环境负载相关） */
function fakeLocal(extra) {
  return async function (opts) {
    fakeLocal.called++
    fakeLocal.lastOpts = opts
    return Object.assign({
      engine: 'mini-ab',
      fen: opts.fen,
      depth: 2,
      nodes: 12,
      elapsedMs: 7,
      sideToMove: 'w',
      lines: [{
        rank: 1, uci: 'e2e4', san: 'e4', from: 'e2', to: 'e4', captured: null,
        scoreCp: 8, scoreMate: null, pv: ['e2e4'], pvSan: ['e4']
      }],
      terminal: null
    }, extra || {})
  }
}
fakeLocal.called = 0
fakeLocal.lastOpts = null

function resetEnv() {
  remote.reset()
  remote.setFallback(null)
  fakeLocal.called = 0
  fakeLocal.lastOpts = null
  delete global.wx
}

/** 造一份服务端成功响应（结构照 05-小程序接入协议.md §4） */
function okBody(overrides) {
  return Object.assign({
    type: 'bestmove',
    fen: MIDDLE_FEN,
    turn: 'w',
    move: 'f3g5',
    san: 'Ng5',
    from: 'f3',
    to: 'g5',
    captured: null,
    promotion: null,
    depth: 14,
    seldepth: 19,
    nodes: 280438,
    elapsedMs: 402,
    timedOut: false,
    eval: 0.32,
    centipawns: '32',
    mate: null,
    engine: { name: 'Stockfish', version: 'Stockfish 16', source: 'self-hosted' },
    lines: [
      {
        rank: 1, multipv: 1, uci: 'f3g5', san: 'Ng5', from: 'f3', to: 'g5',
        scoreCp: 32, scoreMate: null,
        pv: ['f3g5', 'd7d5'], pvSan: ['Ng5', 'd5'],
        depth: 14, seldepth: 19, nodes: 280438, debug: 'info depth 14 …'
      },
      {
        rank: 2, multipv: 2, uci: 'd2d3', san: 'd3', from: 'd2', to: 'd3',
        scoreCp: 18, scoreMate: null,
        pv: ['d2d3', 'f8c5'], pvSan: ['d3', 'Bc5'],
        depth: 14, seldepth: 6, nodes: 280438, debug: 'info …'
      },
      {
        rank: 3, multipv: 3,uci: 'd1e2', san: 'Qe2', from: 'd1', to: 'e2',
        scoreCp: -3, scoreMate: null,
        pv: ['d1e2', 'f8c5'], pvSan: ['Qe2', 'Bc5'],
        depth: 13, seldepth: 15, nodes: 280438, debug: 'info …'
      }
    ]
  }, overrides || {})
}

/**
 * 自建服务（112.121.168.204:8787）的 `POST /v1` 实测**不带** engine 字段，
 * 版本只能从 `GET /healthz` 拿——这一组用例就按真实形态造。
 */
function noEngineBody() {
  const body = okBody()
  delete body.engine
  return body
}

function respondWith(body, statusCode) {
  installWx(options => {
    options.success({ statusCode: statusCode || 200, data: body })
  })
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  /* ------------------------------------------------ 1. 请求形态与成功路径 */
  H.section('1. 请求形态与成功路径（05 协议 §3 / §4）')

  resetEnv()
  respondWith(okBody())
  let r = await remote.analyze({ fen: MIDDLE_FEN, depth: 3, multiPV: 3 })

  H.eq(analysisCalls().length, 1, '只发一次分析请求')
  H.eq(analysisCalls()[0].url, remote.DEFAULT_ENDPOINT + '/v1', 'POST 到 /v1（不走 WebSocket）')
  H.eq(analysisCalls()[0].method, 'POST', '方法是 POST')
  H.eq(analysisCalls()[0].timeout, remote.REQUEST_TIMEOUT_MS, '带上了请求超时')
  const payload = JSON.parse(analysisCalls()[0].data)
  H.eq(payload.fen, MIDDLE_FEN, 'FEN 原样送出')
  H.eq(payload.variants, 3, 'variants 与 multiPV 一致')
  H.ok(payload.depth >= 1 && payload.depth <= 30, 'depth 在服务端范围内（1~30）')
  H.ok(payload.maxThinkingTime >= 50 && payload.maxThinkingTime <= 5000, '思考时间在服务端范围内（50~5000ms）')

  H.eq(r.source, 'remote', '结果标记 source=remote')
  H.eq(r.engine, 'stockfish', 'engine 字段标为 stockfish')
  H.eq(r.engineVersion, 'Stockfish 16', '引擎版本来自 body.engine.version')
  H.eq(r.lines.length, 3, '拿到三条线')
  H.eq(r.lines.map(l => l.rank).join(','), '1,2,3', 'rank 依次为 1/2/3')
  H.ok(r.lines.every(l => l.pvSan && l.pvSan.length), '每条线都有 pvSan')
  H.ok(r.lines.every(l => l.pv && l.pv.length), '每条线都有 pv（UCI）')
  H.ok(r.elapsedMs >= 0, 'elapsedMs 是客户端计时')
  H.eq(r.terminal, null, '正常响应里 terminal 为 null')
  H.eq(remote.state().failStreak, 0, '成功后失败计数归零')

  /* -------------------------------------------------------- 2. 分数视角 */
  H.section('2. 分数视角（lines[] 直取，不换算）')

  resetEnv()
  respondWith(okBody({
    fen: 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1',
    turn: 'b',
    centipawns: '729',
    lines: [
      { rank: 1, uci: 'e7e5', san: 'e5', from: 'e7', to: 'e5', scoreCp: -729, scoreMate: null, pv: [], pvSan: [] }
    ]
  }))
  r = await remote.analyze({ fen: 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1', multiPV: 1 })
  H.eq(r.lines[0].scoreCp, -729, '轮黑走且黑方劣势：scoreCp 为负（视角没搞反）')
  H.eq(r.sideToMove, 'b', 'sideToMove 取自 turn')

  resetEnv()
  respondWith(okBody({
    fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
    move: 'a1a8', san: 'Ra8#', mate: '1', centipawns: '10000',
    lines: [
      { rank: 1, uci: 'a1a8', san: 'Ra8#', from: 'a1', to: 'a8', scoreCp: null, scoreMate: 1, pv: ['a1a8'], pvSan: ['Ra8#'] }
    ]
  }))
  r = await remote.analyze({ fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', multiPV: 1 })
  H.eq(r.lines[0].scoreMate, 1, '一步杀：scoreMate === 1')
  H.eq(r.lines[0].scoreCp, null, '杀棋时 scoreCp 为 null')

  H.section('2.1 captured 只在第 1 线（服务端 lines[] 没有该字段）')
  resetEnv()
  respondWith(okBody({ captured: 'p', lines: okBody().lines.slice(0, 2) }))
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 2 })
  H.eq(r.lines[0].captured, 'p', '第 1 线取顶层 captured')
  H.eq(r.lines[1].captured, null, '其余线 captured 置 null')

  /* -------------------------------------------------- 3. 本地前置拦截 */
  H.section('3. 终局 / 非法 FEN 本地前置拦截（D16）')

  resetEnv()
  remote.setFallback(fakeLocal())
  respondWith(okBody())
  r = await remote.analyze({ fen: MATE_FEN, multiPV: 3 })
  H.eq(calls().length, 0, '终局局面不发远端请求')
  H.eq(r.source, 'local', '终局走本地')
  H.eq(r.skipped, 'terminal', '标记为终局跳过')
  H.ok(!r.degradedFrom, '终局不算降级（不显示降级提示）')

  resetEnv()
  remote.setFallback(fakeLocal())
  respondWith(okBody())
  r = await remote.analyze({ fen: '这不是 FEN', multiPV: 3 })
  H.eq(calls().length, 0, '非法 FEN 不发远端请求')
  H.eq(r.source, 'local', '非法 FEN 交本地引擎给一贯的报错')

  /* ------------------------------------------------------ 4. 回落显形 */
  H.section('4. 失败回落本地且必须显形（D15）')

  resetEnv()
  remote.setFallback(fakeLocal())
  installWx(options => { options.fail({ errMsg: 'request:fail timeout' }) })
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(r.source, 'local', '超时后落到本地')
  H.eq(r.degradedFrom, 'TIMEOUT', 'degradedFrom 记下原因码')
  H.eq(r.degradedReason, '响应超时', 'degradedReason 是可读的原因')
  H.eq(fakeLocal.lastOpts.fen, MIDDLE_FEN, '回落时把原始参数原样交给本地引擎')

  resetEnv()
  remote.setFallback(fakeLocal())
  installWx(options => { options.fail({ errMsg: 'request:fail url not in domain list' }) })
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(r.degradedFrom, 'NETWORK', '域名未配置这类网络失败归为 NETWORK')

  resetEnv()
  remote.setFallback(fakeLocal())
  delete global.wx
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(r.degradedFrom, 'ENV_NO_NETWORK', '环境没有 request 时降级为 ENV_NO_NETWORK')
  H.eq(r.source, 'local', '仍然出结果，不是抛错')

  H.section('4.1 判错看 body.type，不能只看 HTTP 状态码')

  resetEnv()
  remote.setFallback(fakeLocal())
  respondWith({ type: 'error', error: 'QUEUE_FULL', text: 'Queue is full' }, 200)
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(r.degradedFrom, 'QUEUE_FULL', 'HTTP 200 + type:error 也能判出失败')

  resetEnv()
  remote.setFallback(fakeLocal())
  respondWith({ type: 'error', error: 'ENGINE_UNAVAILABLE', text: 'engine down' }, 503)
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(r.source, 'local', '503 回落本地')
  H.eq(r.degradedFrom, 'ENGINE_UNAVAILABLE', '503 的原因码保留')

  resetEnv()
  remote.setFallback(fakeLocal())
  respondWith({ type: 'bestmove', lines: [] }, 200)
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(r.degradedFrom, 'BAD_RESPONSE', '没有 lines 视为坏响应并回落')

  H.section('4.2 请求本身有问题：不回落，抛给调用方')

  resetEnv()
  remote.setFallback(fakeLocal())
  respondWith({ type: 'error', error: 'GAME_OVER', text: 'Game over: checkmate' }, 400)
  await H.throwsAsync(
    () => remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 }),
    e => e.code === 'GAME_OVER',
    'GAME_OVER 直接抛错'
  )
  H.eq(fakeLocal.called, 0, '不该回落的场景不会偷偷跑本地引擎')

  resetEnv()
  remote.setFallback(fakeLocal())
  respondWith({ type: 'error', error: 'INVALID_FEN', text: 'bad fen' }, 400)
  await H.throwsAsync(
    () => remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 }),
    e => e.code === 'INVALID_FEN',
    'INVALID_FEN 直接抛错（属本地 bug）'
  )

  /* -------------------------------------- 4.3 环境级屏蔽（预览/真机网关） */
  H.section('4.3 环境级屏蔽：预览只允许 /.cloud/、真机微信 UA 被网关 403')

  resetEnv()
  remote.setFallback(fakeLocal())
  installWx(options => { options.fail({ errMsg: 'request:fail path not allowed' }) })
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(r.source, 'local', 'path not allowed 落到本地')
  H.eq(r.degradedFrom, 'GATEWAY_BLOCK', 'path not allowed 标记为 GATEWAY_BLOCK（不是坏响应）')
  H.ok(remote.state().permanentlyBlocked, '命中环境屏蔽后标记为永久屏蔽')
  const blockedCalls = calls().length
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(calls().length, blockedCalls, '永久屏蔽后不再发请求（不刷屏）')

  resetEnv()
  remote.setFallback(fakeLocal())
  installWx(options => {
    options.success({ statusCode: 403, data: '<!doctype html><html><head><title>请在浏览器中打开</title>' })
  })
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(r.source, 'local', '网关 403 + HTML 落到本地')
  H.eq(r.degradedFrom, 'GATEWAY_BLOCK', '403 + HTML「请在浏览器中打开」标记为 GATEWAY_BLOCK')

  // 服务端自己回的 JSON 403（风控/限流/来源校验）不是环境屏蔽：
  // 否则一次临时风控就会把整个会话永久钉在本地引擎上，且界面上看不出区别。
  resetEnv()
  remote.setFallback(fakeLocal())
  installWx(options => {
    options.success({ statusCode: 403, data: { type: 'error', error: 'FORBIDDEN', text: '来源校验未通过' } })
  })
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(r.source, 'local', '403 + JSON 仍回落本地')
  H.ok(!remote.state().permanentlyBlocked, '403 + JSON 不标记永久屏蔽（下次还会重试）')
  H.eq(r.degradedFrom, 'FORBIDDEN', '错误码透传为服务端给的 FORBIDDEN')

  /* ------------------------------------------------------ 5. 限流重试 */
  H.section('5. 限流退避重试一次（05 协议 §6）')

  resetEnv()
  remote.setFallback(fakeLocal())
  installWx(options => {
    options.success({ statusCode: 429, data: { type: 'error', error: 'RATE_LIMITED', text: 'slow down' } })
  })
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(analysisCalls().length, 2, '限流后退避重试一次（共两次分析请求）')
  H.eq(r.degradedFrom, 'RATE_LIMITED', '仍失败则回落本地并标记限流')

  /* ------------------------------------------------------------ 6. 熔断 */
  H.section('6. 连续失败后熔断，冷却期内不再干等超时')

  resetEnv()
  remote.setFallback(fakeLocal())
  installWx(options => { options.fail({ errMsg: 'request:fail timeout' }) })
  await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(remote.state().circuitOpen, false, '第一次失败还不熔断')
  await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(remote.state().circuitOpen, true, '连续两次失败后熔断')
  const before = calls().length
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(calls().length, before, '熔断期内不再发请求')
  H.eq(r.source, 'local', '熔断期内直接给本地结果')
  H.eq(r.degradedFrom, 'TIMEOUT', '降级原因沿用上次的原因码')

  resetEnv()
  remote.setFallback(fakeLocal())
  let n = 0
  installWx(options => {
    n++
    if (n === 1) options.fail({ errMsg: 'request:fail timeout' })
    else options.success({ statusCode: 200, data: okBody() })
  })
  await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(r.source, 'remote', '服务端恢复后自动切回云端')
  H.eq(remote.state().failStreak, 0, '恢复后失败计数清零')

  /* ---------------------------------------------------- 6.1 版本探测 */
  H.section('6.1 引擎版本：/v1 不带时从 GET /healthz 补（只探一次）')

  resetEnv()
  remote.setFallback(fakeLocal())
  installWx(options => {
    if (options.url.indexOf('/healthz') !== -1) {
      options.success({
        statusCode: 200,
        data: { status: 'ok', engine: { binary: '/opt/stockfish', version: 'Stockfish 15.1', ok: true } }
      })
    } else {
      options.success({ statusCode: 200, data: noEngineBody() })
    }
  })
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(probeCalls().length, 1, '首次分析并行探一次 /healthz')
  H.eq(r.source, 'remote', '探测不影响分析结果')
  H.eq(r.engineVersion, 'Stockfish 15.1', '版本填进结果（徽标显示「云端 Stockfish 15.1」）')
  await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(probeCalls().length, 1, '版本缓存后不再重复探测')

  resetEnv()
  remote.setFallback(fakeLocal())
  installWx(options => {
    if (options.url.indexOf('/healthz') !== -1) options.fail({ errMsg: 'request:fail timeout' })
    else options.success({ statusCode: 200, data: noEngineBody() })
  })
  r = await remote.analyze({ fen: MIDDLE_FEN, multiPV: 3 })
  H.eq(r.source, 'remote', '版本探测失败不影响分析（不因此回落本地）')
  H.eq(r.engineVersion, '', '探测失败时版本留空（徽标退化成「云端引擎」）')

  /* -------------------------------------------------------- 7. 契约一致 */
  H.section('7. 与端上 engine.js 契约一致（AGENTS.md §4 冻结）')

  resetEnv()
  const local = await engine.analyze({ fen: MIDDLE_FEN, depth: 1, multiPV: 1 })
  respondWith(okBody())
  const remoteResult = await remote.analyze({ fen: MIDDLE_FEN, depth: 3, multiPV: 1 })
  const topKeys = ['engine', 'fen', 'depth', 'nodes', 'elapsedMs', 'sideToMove', 'lines', 'terminal']
  topKeys.forEach(k => {
    H.ok(k in remoteResult, '远端结果含字段 ' + k + '（本地同样有：' + (k in local) + '）')
  })
  const lineKeys = Object.keys(local.lines[0]).sort()
  const remoteLineKeys = Object.keys(remoteResult.lines[0]).sort()
  H.eq(remoteLineKeys.join(','), lineKeys.join(','), '单条线的字段与本地完全一致')
  H.eq(typeof remoteResult.source, 'string', '额外带 source（只加字段，不改既有字段）')

  /* ----------------------------------------------------- 8. 参数映射 */
  H.section('8. UI 深度 → 远端参数映射')

  const p2 = remote.remoteParams(2)
  const p4 = remote.remoteParams(4)
  H.ok(p4.depth > p2.depth, 'UI 深度越大，远端搜索越深')
  H.ok(p4.think >= p2.think, 'UI 深度越大，思考时间不减')
  const pBad = remote.remoteParams(99)
  H.eq(pBad.depth, 14, '意外深度回落到默认 14')
  H.ok(remote.remoteParams(undefined).depth >= 1, '缺省深度也给出合法值')

  /* -------------------------------------------------------- 9. 自然语言 */
  H.section('9. 降级原因文案')

  H.eq(remote.reasonText('RATE_LIMITED'), '请求过于频繁', '限流文案')
  H.eq(remote.reasonText('ENGINE_UNAVAILABLE'), '暂时不可用', '引擎不可用文案')
  H.eq(remote.reasonText('什么鬼'), '暂时不可用', '未知码有兜底文案')

  resetEnv()
  delete global.wx
  H.summary('remote-engine.test.js')
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
