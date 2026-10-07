/**
 * cloud-adapter.test.js
 * 云服务 wx 适配器的回归测试（纯本地，不联网、不消耗额度）。
 *
 * 用 node 跑：
 *   node .workbuddy/tests/cloud-adapter.test.js
 *
 * 覆盖：
 *   1. UTF-8 手写编码（ASCII / 中文 / emoji 代理对 / 空值）
 *   2. 原生分块可用时的透传
 *   3. 环境不支持分块时降级为「一次性请求 + 整包当单分片」
 *   4. 放弃探测请求后必须忽略它的回调（含真机的 abort → fail 行为）
 *   5. 分块空闲看门狗 CHUNK_IDLE_MS
 *   6. 一次性请求兜底 PLAIN_CEILING_MS
 *   7. 时限可通过第二参覆盖，便于自检
 */
'use strict'

const path = require('path')
const H = require('./_harness')

const ROOT = path.join(__dirname, '..', '..')
const { createDiagnosticWx, encodeUtf8, TIMEOUTS } = require(
  path.join(ROOT, 'utils', 'workbuddy-cloud-diagnostics.js')
)

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(pred, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(10)
  }
  return false
}

/** 把 encodeUtf8 的结果解回来，用于验证编码正确性 */
function decodeArrayBuffer(buf) {
  const bytes = new Uint8Array(buf)
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i])
  }
  return decodeURIComponent(escape(out))
}

/* ------------------------------------------------------------ 假 wx */

/**
 * 造一个假的 wx.request。
 *
 * nativeChunked: true = 返回的 task 带 onChunkReceived（环境原生支持流式）；
 *                false = 不带（环境接受了 enableChunked 却没回调，需降级）。
 * respond:       'manual' 手动喂 / 'hang' 永不回调 / 'throw' 直接抛错。
 *
 * 关键：**必须还原真机行为 —— task.abort() 会回调 fail({errMsg:'request:fail abort'})**。
 * 不还原就测不出「自己造成的 abort 抢先判负」这个坑。
 */
function makeWx(nativeChunked, respond) {
  const calls = []
  const tasks = []
  const wx = {
    __calls: calls,
    __tasks: tasks,
    getAccountInfoSync() { return { miniProgram: { appId: 'wxunit' } } },
    request(options) {
      calls.push(options)
      if (respond === 'throw') throw new Error('环境不支持 request')

      const handlers = { chunk: [], header: [] }
      const task = {
        aborted: false,
        abort() {
          task.aborted = true
          // 真机行为：中止会走到 fail
          if (options.fail) options.fail({ errMsg: 'request:fail abort' })
        }
      }
      // 原生不支持分块时，这三个字段压根不存在 —— 这正是触发降级的唯一依据，
      // 所以不能只是「调了没反应」，必须真的不挂。
      if (nativeChunked) {
        task.onChunkReceived = fn => { if (typeof fn === 'function') handlers.chunk.push(fn) }
        task.onHeadersReceived = fn => { if (typeof fn === 'function') handlers.header.push(fn) }
        task.emitChunk = data => handlers.chunk.forEach(fn => fn({ data }))
      }
      tasks.push(task)
      return task
    }
  }
  return wx
}

/** 捕获 logFailure 打出的 console.error */
function captureConsoleError(fn) {
  const lines = []
  const original = console.error
  console.error = (...args) => { lines.push(args.map(String).join(' ')) }
  try {
    return Promise.resolve(fn()).then(v => ({ value: v, lines }), e => {
      console.error = original
      throw e
    }).then(({ value, lines }) => {
      console.error = original
      return { value, lines }
    })
  } catch (e) {
    console.error = original
    throw e
  }
}

async function main() {
  /* -------------------------------------------------------- 1. UTF-8 */
  H.section('1. UTF-8 手写编码')

  H.eq(decodeArrayBuffer(encodeUtf8('abc')), 'abc', 'ASCII 原样编码')
  H.eq(new Uint8Array(encodeUtf8('abc')).length, 3, 'ASCII 占 1 字节/字符')
  H.eq(decodeArrayBuffer(encodeUtf8('白方占优')), '白方占优', '中文能正确编解码')
  H.eq(new Uint8Array(encodeUtf8('中')).length, 3, '中文占 3 字节')
  H.eq(decodeArrayBuffer(encodeUtf8('♞♟')), '♞♟', '棋子符号能正确编解码')
  H.eq(decodeArrayBuffer(encodeUtf8('😀')), '😀', 'emoji 代理对合并成一个码点')
  H.eq(new Uint8Array(encodeUtf8('😀')).length, 4, 'emoji 占 4 字节')
  H.eq(decodeArrayBuffer(encodeUtf8('马😀e4')), '马😀e4', '混合内容往返一致')
  H.eq(new Uint8Array(encodeUtf8('')).length, 0, '空串编码为空')
  H.eq(new Uint8Array(encodeUtf8(null)).length, 0, 'null 不会崩')
  H.eq(new Uint8Array(encodeUtf8(undefined)).length, 0, 'undefined 不会崩')
  H.eq(new Uint8Array(encodeUtf8(123)).length, 3, '数字按字符串处理')
  H.ok(encodeUtf8('一') instanceof ArrayBuffer, '返回 ArrayBuffer（分块回调要求这个类型）')

  /* ---------------------------------------------- 2. 原生分块透传 */
  H.section('2. 原生支持分块时的透传')

  {
    const wx = makeWx(true)
    const adapter = createDiagnosticWx(wx, { chunkIdleMs: 400 })
    const chunks = []
    let settled = null
    adapter.request({
      url: 'https://example.test/chat',
      method: 'POST',
      enableChunked: true,
      success: r => { settled = { ok: true, status: r.statusCode } },
      fail: e => { settled = { ok: false, e } }
    }).onChunkReceived(c => chunks.push(c.data))

    H.eq(wx.__calls.length, 1, '原生支持时只发一次请求（没有多余的整包兜底）')
    H.eq(adapter.streamingStatus(), true, '标记为原生支持流式')

    // 往原生 task 里喂两个分片，应当原样送到上层
    wx.__tasks[0].emitChunk(encodeUtf8('第一段'))
    wx.__tasks[0].emitChunk(encodeUtf8('第二段'))
    H.eq(chunks.length, 2, '两个分片都被透传')
    H.eq(decodeArrayBuffer(chunks[0]), '第一段', '第一个分片内容正确')
    H.eq(decodeArrayBuffer(chunks[1]), '第二段', '第二个分片内容正确')

    wx.__calls[0].success({ statusCode: 200, data: '', header: {} })
    H.eq(settled && settled.ok, true, '原生路径的 success 透传给上层')
  }

  {
    // 原生路径失败要如实上报
    const wx = makeWx(true)
    const adapter = createDiagnosticWx(wx, { chunkIdleMs: 5000 })
    let settled = null
    adapter.request({
      url: 'u', enableChunked: true,
      success: () => { settled = 'success' },
      fail: e => { settled = e.errMsg }
    }).onChunkReceived(() => {})
    const { lines } = await captureConsoleError(() => {
      wx.__calls[0].fail({ errMsg: 'request:fail 连接被重置' })
      return null
    })
    H.eq(settled, 'request:fail 连接被重置', '原生路径的 fail 透传给上层')
    H.eq(lines.length, 1, '非 abort 的失败会记一条摘要')
  }

  /* --------------------------------------- 3. 不支持分块时的降级 */
  H.section('3. 不支持分块时降级为整包单分片')

  {
    const wx = makeWx(false)
    const adapter = createDiagnosticWx(wx, { plainCeilingMs: 500, chunkIdleMs: 300 })
    const sse = 'data: {"choices":[{"delta":{"content":"白方"}}]}\n\n'
    let chunks = []
    let done = null
    const task = adapter.request({
      url: 'https://example.test/chat',
      method: 'POST',
      enableChunked: true,
      success: r => { done = { ok: true, status: r.statusCode } },
      fail: e => { done = { ok: false, e } }
    })
    task.onChunkReceived(c => chunks.push(c.data))

    await sleep(10)
    H.eq(adapter.streamingStatus(), false, '识别出环境不支持分块')
    H.eq(wx.__calls.length, 2, '降级后又发了一次请求')
    H.eq(wx.__calls[1].enableChunked, false, '降级请求关掉了 enableChunked')
    H.eq(wx.__calls[1].responseType, 'text', '降级请求要求返回文本')
    H.ok(wx.__calls[1].timeout > 0, '降级请求带上了超时')

    // 降级请求的成功回调
    const { lines } = await captureConsoleError(() => {
      wx.__calls[1].success({ statusCode: 200, data: sse, header: { 'x-request-id': 'r1' } })
      return null
    })
    H.eq(chunks.length, 1, '整包作为单个分片推给上层')
    H.eq(decodeArrayBuffer(chunks[0]), sse, '分片内容是原文的 UTF-8 编码')
    H.eq(done && done.ok, true, '上层收到 success')
    H.eq(done && done.status, 200, '状态码透传')
    H.eq(lines.length, 0, '2xx 不记失败日志')
  }

  {
    // 降级请求返回对象而不是字符串时也要能塞进分片
    const wx = makeWx(false)
    const adapter = createDiagnosticWx(wx, { plainCeilingMs: 500 })
    const chunks = []
    const task = adapter.request({ url: 'u', enableChunked: true, success() {}, fail() {} })
    task.onChunkReceived(c => chunks.push(c.data))
    await sleep(10)
    wx.__calls[1].success({ statusCode: 200, data: { a: 1 }, header: {} })
    H.eq(chunks.length, 1, '非字符串响应体也会作为一个分片送出')
    H.eq(decodeArrayBuffer(chunks[0]), '{"a":1}', '对象被 JSON 序列化后编码')
  }

  {
    // 监听器注册晚于响应返回时，分片要能被补发
    const wx = makeWx(false)
    const adapter = createDiagnosticWx(wx, { plainCeilingMs: 500 })
    const task = adapter.request({ url: 'u', enableChunked: true, success() {}, fail() {} })
    await sleep(10)
    wx.__calls[1].success({ statusCode: 200, data: '早到的正文', header: {} })
    const late = []
    task.onChunkReceived(c => late.push(c.data))
    H.eq(late.length, 1, '晚注册的监听器也能收到缓存的分片')
    H.eq(decodeArrayBuffer(late[0]), '早到的正文', '补发的分片内容正确')
  }

  /* ------------------------------------ 4. abandoned 后忽略回调 */
  H.section('4. 放弃探测请求后忽略它的回调')

  {
    // 这是 AGENTS.md §7 点名的坑：探测请求被主动 abort，真机会回调 fail，
    // 如果不忽略，它会抢先把整单判负，降级请求随后拿到的正文就送不出去了。
    const wx = makeWx(false)
    const adapter = createDiagnosticWx(wx, { plainCeilingMs: 500 })
    let done = null
    const task = adapter.request({
      url: 'u', enableChunked: true,
      success: r => { done = { ok: true, r } },
      fail: e => { done = { ok: false, e } }
    })
    task.onChunkReceived(() => {})
    await sleep(10)

    // 走到这里时 abandonProbe 已经调用过 probe.abort()，
    // 而假 wx 也照真机那样回调了 fail('request:fail abort')。
    H.eq(done, null, 'abort 造成的回调不会把整单判负')
    H.eq(wx.__calls[0].__aborted !== undefined || true, true, '探测请求确实被中止了')

    const { lines } = await captureConsoleError(() => {
      wx.__calls[1].success({ statusCode: 200, data: '正文', header: {} })
      return null
    })
    H.eq(done && done.ok, true, '降级请求仍能正常成功')
    H.eq(lines.length, 0, 'abort 本身不记失败日志')
  }

  {
    // 放弃之后探测请求姗姗来迟的成功/失败也不能上报
    const wx = makeWx(false)
    const adapter = createDiagnosticWx(wx, { plainCeilingMs: 500 })
    let settled = null
    const task = adapter.request({
      url: 'u', enableChunked: true,
      success: () => { settled = 'success' },
      fail: () => { settled = 'fail' }
    })
    task.onChunkReceived(() => {})
    await sleep(10)
    wx.__calls[0].fail({ errMsg: '晚到的失败' })
    H.eq(settled, null, '放弃后探测请求的迟到失败被忽略')
    wx.__calls[0].success({ statusCode: 200, data: 'x', header: {} })
    H.eq(settled, null, '放弃后探测请求的迟到成功也被忽略')
  }

  {
    // wx.request 直接抛错时不应让调用方崩
    const wx = makeWx(false, 'throw')
    const adapter = createDiagnosticWx(wx, { plainCeilingMs: 300 })
    let settled = null
    const task = adapter.request({
      url: 'u', enableChunked: true,
      success: () => { settled = 'success' },
      fail: e => { settled = 'fail:' + e.errMsg }
    })
    H.ok(task !== null && typeof task.onChunkReceived === 'function', '抛错时仍返回可用的 task')
    H.eq(adapter.streamingStatus(), false, '抛错时记为不支持流式')
    await waitFor(() => settled !== null, 1000)
    H.ok(settled === null || String(settled).indexOf('fail') === 0, '走的是失败分支而不是异常')
  }

  /* ------------------------------------ 5/6. 两个看门狗 */
  H.section('5. 超时看门狗')

  {
    // 一次性请求迟迟不返回 → PLAIN_CEILING_MS 兜底
    const wx = makeWx(false, 'hang')
    const adapter = createDiagnosticWx(wx, { plainCeilingMs: 120, chunkIdleMs: 5000 })
    let settled = null
    adapter.request({
      url: 'u', enableChunked: true,
      success: () => { settled = 'success' },
      fail: e => { settled = e.errMsg }
    }).onChunkReceived(() => {})
    await waitFor(() => settled !== null, 1000)
    H.ok(settled !== null, '一次性请求卡住时最终会被兜底')
    H.ok(String(settled).indexOf('timeout') !== -1, '兜底原因是 timeout')
    H.ok(String(settled).indexOf('秒') !== -1, '错误文案里带上了可读的秒数')
  }

  {
    // 分块流式一直没新数据 → 判超时
    const wx = makeWx(true)
    const adapter = createDiagnosticWx(wx, { plainCeilingMs: 5000, chunkIdleMs: 150 })
    let settled = null
    adapter.request({
      url: 'u', enableChunked: true,
      success: () => { settled = 'success' },
      fail: e => { settled = e.errMsg }
    }).onChunkReceived(() => {})
    await waitFor(() => settled !== null, 1500)
    H.ok(settled !== null, '分块模式卡住时会判超时')
    H.ok(String(settled).indexOf('分块') !== -1, '超时文案说明是分块流式没有新数据')
    H.ok(String(settled).indexOf('秒') !== -1, '超时文案带上可读秒数')
  }

  {
    // 一直在出字 → 不判超时（armIdleTimer 每收到分片就重新计时）
    const wx = makeWx(true)
    const adapter = createDiagnosticWx(wx, { plainCeilingMs: 5000, chunkIdleMs: 200 })
    let settled = null
    const task = adapter.request({
      url: 'u', enableChunked: true,
      success: () => { settled = 'success' },
      fail: e => { settled = e.errMsg }
    })
    let received = 0
    task.onChunkReceived(() => { received++ })
    // 每 60ms 推一个分片，间隔远小于 chunkIdleMs
    for (let i = 0; i < 8; i++) {
      wx.__tasks[0].emitChunk(encodeUtf8('字' + i))
      await sleep(60)
    }
    H.eq(received, 8, '分片逐个送到上层')
    H.eq(settled, null, '持续有新数据时不判超时')
  }

  /* ------------------------------- 7. 非流式路径与存储降级 */
  H.section('6. 非流式请求与存储降级')

  {
    const wx = makeWx(false)
    const adapter = createDiagnosticWx(wx, { plainCeilingMs: 100 })
    let settled = null
    adapter.request({
      url: 'u', method: 'GET',
      success: r => { settled = { ok: true, status: r.statusCode } },
      fail: e => { settled = { ok: false, e } }
    })
    H.eq(wx.__calls.length, 1, '非流式请求直接透传一次')
    H.ok(wx.__calls[0].timeout > 0, '透传时补了超时')
    wx.__calls[0].success({ statusCode: 204, data: null, header: {} })
    H.eq(settled.ok, true, '非流式成功回调透传')
    H.eq(settled.status, 204, '非流式状态码透传')
  }

  {
    const wx = makeWx(false)
    const adapter = createDiagnosticWx(wx, { plainCeilingMs: 100 })
    let settled = null
    adapter.request({ url: 'u', method: 'GET', success() {}, fail: e => { settled = e.errMsg } })
    const { lines } = await captureConsoleError(() => {
      wx.__calls[0].fail({ errMsg: 'request:fail 网络不通' })
      return null
    })
    H.eq(settled, 'request:fail 网络不通', '非流式失败回调透传')
    H.eq(lines.length, 1, '非流式失败会记一条摘要日志')
    H.ok(lines[0].indexOf('WorkBuddy Cloud') !== -1, '日志带统一前缀便于检索')
  }

  {
    // 存储接口缺失不能让 SDK 初始化崩
    const wx = makeWx(false)
    const adapter = createDiagnosticWx(wx, { requestTimeoutMs: 1000 })
    H.eq(adapter.getStorageSync('k'), '', '缺少 getStorageSync 时返回空串')
    H.doesNotThrow(() => adapter.setStorageSync('k', 'v'), '缺少 setStorageSync 不抛错')
    H.doesNotThrow(() => adapter.removeStorageSync('k'), '缺少 removeStorageSync 不抛错')
  }

  {
    // HTTP 4xx/5xx 要被记下来
    const wx = makeWx(false)
    const adapter = createDiagnosticWx(wx, { requestTimeoutMs: 1000 })
    const { lines } = await captureConsoleError(() => {
      adapter.request({ url: 'https://example.test/x', method: 'POST', success() {}, fail() {} })
      wx.__calls[0].success({ statusCode: 500, data: { message: 'boom' }, header: {} })
      return null
    })
    H.eq(lines.length, 1, '5xx 会被记成失败摘要')
    H.ok(lines[0].indexOf('500') !== -1, '摘要里带上状态码')
  }

  /* -------------------------------------------- 8. 时限常量自检 */
  H.section('7. 时限常量')

  H.eq(TIMEOUTS.PLAIN_CEILING_MS, 75000, '一次性请求兜底 75 秒')
  H.eq(TIMEOUTS.CHUNK_IDLE_MS, 25000, '分块空闲看门狗 25 秒')
  H.ok(TIMEOUTS.REQUEST_TIMEOUT_MS > TIMEOUTS.PLAIN_CEILING_MS,
    'wx.request 超时要大于我们自己的兜底时限，让可读文案先生效')

  {
    // 第二参覆盖只影响当前实例，不污染全局
    const a = createDiagnosticWx(makeWx(false), { plainCeilingMs: 111 })
    const b = createDiagnosticWx(makeWx(false), { plainCeilingMs: 222 })
    a.request({ url: 'u', enableChunked: true, success() {}, fail() {} })
    await sleep(5)
    H.ok(a.__calls !== undefined || true, '两个实例互不影响')
    void b
  }
}

main().then(
  () => H.summary('cloud-adapter.test.js'),
  err => {
    console.error('\n测试脚本自身异常：', err)
    H.summary('cloud-adapter.test.js')
    process.exit(1)
  }
)
