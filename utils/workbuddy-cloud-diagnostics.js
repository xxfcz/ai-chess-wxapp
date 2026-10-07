/**
 * workbuddy-cloud-diagnostics.js
 *
 * 云服务的 wx 适配器，做两件事：
 *   1) 记录请求失败的摘要日志（不含凭据与完整响应体）；
 *   2) 抹平运行环境差异 —— 某些环境（如网页版预览）会接受 enableChunked
 *      却不提供分块回调 onChunkReceived，导致 SDK 的流式请求直接失败。
 *      这里自动降级为「一次性请求 + 把整包响应当单个分片喂给 SDK」，
 *      功能可用，只是失去逐字增量渲染。
 *
 * 关于时限（实测数据，改之前请先看这里）：
 *   - 一次性请求要从头等到尾（没有增量可观测），所以只能给一个总上限；
 *     超过上限就当作云端不会返回了，给用户一句可读的说明，而不是一直转圈。
 *   - 分块流式则用「空闲看门狗」：每收到一个分片就重新计时，卡住才判超时。
 *   - wx.request 自身的超时（默认 60 秒）也要放宽，否则平台会先掐断请求，
 *     拿到的错误信息不如我们自己的清楚。
 */
const PLAIN_CEILING_MS = 75000
const CHUNK_IDLE_MS = 25000
/** 略大于 PLAIN_CEILING_MS：让「我们自己的」超时说明先于平台超时生效 */
const REQUEST_TIMEOUT_MS = PLAIN_CEILING_MS + 5000

function diagnosticObject(value) {
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return {};
        }
    }
    return value !== null && typeof value === 'object' ? value : {};
}

function diagnosticText(value) {
    return typeof value === 'string' ? value.slice(0, 512) : undefined;
}

function responseHeader(headers, name) {
    const key = Object.keys(headers || {}).find(key => key.toLowerCase() === name);
    return key ? diagnosticText(headers[key]) : undefined;
}

function logFailure(options, startedAt, status, data, headers) {
    const url = options.url.split(/[?#]/, 1)[0].replace(/^(https?:\/\/)[^/]*@/, '$1');
    const payload = diagnosticObject(data);
    const nestedError = typeof payload.error === 'object' ? diagnosticObject(payload.error) : {};
    let code = payload.code;
    if (typeof payload.error === 'string') code = payload.error;
    else if (nestedError.code !== undefined) code = nestedError.code;
    const rawMessage = payload.error_description || nestedError.message || payload.message;
    const message = typeof rawMessage === 'string'
        ? diagnosticText(rawMessage.split(options.url).join(url))
        : undefined;
    const login = /^https?:\/\/[^/]+\/\.cloud\/auth\/v1\/login-wechat$/.test(url)
        ? diagnosticObject(options.data)
        : {};

    // 只记录失败摘要，避免凭据、查询参数和完整响应体进入手机日志。
    console.error('[WorkBuddy Cloud] request failed', JSON.stringify({
        stage: status === 0 ? 'network' : 'http',
        method: (options.method || 'GET').toUpperCase(),
        url,
        status,
        durationMs: Date.now() - startedAt,
        appid: diagnosticText(login.appid),
        code: typeof code === 'number' ? code : diagnosticText(code),
        message: message || `HTTP ${status}`,
        requestId: responseHeader(headers, 'x-request-id'),
        traceId: responseHeader(headers, 'x-trace-id'),
    }));
}

/** UTF-8 编码；环境可能没有 TextEncoder，所以手写一份 */
function encodeUtf8(text) {
    const str = String(text == null ? '' : text)
    const bytes = []
    for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i)
        // 代理对：合并成一个码点
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
            const next = str.charCodeAt(i + 1)
            if (next >= 0xdc00 && next <= 0xdfff) {
                code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
                i++
            }
        }
        if (code < 0x80) {
            bytes.push(code)
        } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
        } else if (code < 0x10000) {
            bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
        } else {
            bytes.push(
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 0x3f),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f)
            )
        }
    }
    const buffer = new ArrayBuffer(bytes.length)
    const view = new Uint8Array(buffer)
    for (let i = 0; i < bytes.length; i++) view[i] = bytes[i]
    return buffer
}

/**
 * @param {object} originalWx 宿主环境的 wx
 * @param {object} [overrides] 时限覆盖，仅供自检使用（生产代码不要传）
 *        { plainCeilingMs, chunkIdleMs, requestTimeoutMs }
 */
function createDiagnosticWx(originalWx, overrides) {
    const limits = Object.assign({
        plainCeilingMs: PLAIN_CEILING_MS,
        chunkIdleMs: CHUNK_IDLE_MS,
        requestTimeoutMs: REQUEST_TIMEOUT_MS
    }, overrides || {})
    const seconds = ms => Math.round(ms / 1000)

    // 自定义 wx 适配器可能只实现请求和存储接口。
    if (typeof originalWx.getAccountInfoSync === 'function') {
        try {
            const appid = originalWx.getAccountInfoSync().miniProgram.appId;
            console.info('[WorkBuddy Cloud] initialized', JSON.stringify({ appid }));
        } catch (e) {
            // 取不到 appid 不影响云服务使用
        }
    }

    // null = 尚未探测；true = 环境原生支持分块流式；false = 已确认不支持
    let chunkedSupported = null;

    function plainRequest(options, startedAt) {
        return originalWx.request({
            ...options,
            timeout: options.timeout || limits.requestTimeoutMs,
            success(result) {
                if (result.statusCode < 200 || result.statusCode >= 300) {
                    logFailure(options, startedAt, result.statusCode, result.data, result.header);
                }
                if (options.success) options.success.call(this, result);
            },
            fail(result) {
                if (result.errMsg !== 'request:fail abort') {
                    logFailure(options, startedAt, 0, { message: result.errMsg });
                }
                if (options.fail) options.fail.call(this, result);
            },
        });
    }

    /**
     * 流式请求的兜底：SDK 需要任务对象提供 onChunkReceived。
     * 环境不提供时，改用一次性请求，把完整响应体作为唯一分片推给 SDK 的 SSE 解析器。
     */
    function chunkedRequest(options, startedAt) {
        const chunkListeners = []
        const headerListeners = []
        // 响应可能早于监听器注册（部分环境同步回调），先缓存再补发
        const pendingChunks = []
        let lastHeaders = null
        // owner 记录「是谁把这单判定结束的」，abandoned 表示探测请求已被我们主动放弃
        const state = { inner: null, finished: false, owner: null, abandoned: false, timer: null }

        function clearTimer() {
            if (state.timer) {
                clearTimeout(state.timer)
                state.timer = null
            }
        }

        function deliverChunk(data) {
            for (let i = 0; i < chunkListeners.length; i++) {
                try {
                    chunkListeners[i]({ data: data })
                } catch (e) {
                    // 监听器异常不应影响请求本身
                }
            }
        }

        function emitChunk(data) {
            if (!chunkListeners.length) {
                pendingChunks.push(data)
                return
            }
            deliverChunk(data)
        }

        function emitHeaders(header) {
            const value = header || {}
            if (lastHeaders === null) lastHeaders = value
            for (let i = 0; i < headerListeners.length; i++) {
                try {
                    headerListeners[i]({ header: value })
                } catch (e) {
                    // 同上
                }
            }
        }

        function settle(owner, isFail, result) {
            if (state.finished) return
            state.finished = true
            state.owner = owner
            clearTimer()
            if (isFail) {
                if (result.errMsg !== 'request:fail abort') {
                    logFailure(options, startedAt, 0, { message: result.errMsg })
                }
                if (options.fail) options.fail(result)
                return
            }
            if (result.statusCode < 200 || result.statusCode >= 300) {
                logFailure(options, startedAt, result.statusCode, result.data, result.header)
            }
            if (options.success) options.success(result)
        }

        const task = {
            onChunkReceived(fn) {
                if (typeof fn !== 'function') return
                chunkListeners.push(fn)
                while (pendingChunks.length) {
                    deliverChunk(pendingChunks.shift())
                }
            },
            onHeadersReceived(fn) {
                if (typeof fn !== 'function') return
                headerListeners.push(fn)
                if (lastHeaders !== null) {
                    try {
                        fn({ header: lastHeaders })
                    } catch (e) {
                        // 监听器异常忽略
                    }
                }
            },
            abort() {
                clearTimer()
                try {
                    if (state.inner && typeof state.inner.abort === 'function') state.inner.abort()
                } catch (e) {
                    // 忽略重复中断
                }
            }
        }

        /**
         * 放弃探测请求。
         *
         * 关键点：真实环境里 task.abort() 会回调 fail({errMsg:'request:fail abort'})。
         * 那是我们自己中止的，不能算请求失败 —— 否则它会抢先把整单判负，
         * 降级请求随后拿到的正文就永远送不出去（表现为 gateway_network_error）。
         */
        function abandonProbe(probe) {
            if (!probe) return
            state.abandoned = true
            try {
                if (typeof probe.abort === 'function') probe.abort()
            } catch (e) {
                // 忽略重复中止
            }
            // 探测请求若在放弃前就同步回报了结果，撤销它，让降级请求有机会完成
            if (state.finished && state.owner === 'probe') {
                state.finished = false
                state.owner = null
            }
        }

        /** 放弃分块，改用一次性请求；整包响应体作为单个分片 */
        function startPlainFallback(probe) {
            abandonProbe(probe)
            state.timer = setTimeout(() => {
                settle('plain', true, { errMsg: `request:fail timeout（云端模型 ${seconds(limits.plainCeilingMs)} 秒内没有返回结果）` })
            }, limits.plainCeilingMs)

        state.inner = (function () {
            // 探测请求有 try/catch 兜底，降级这里同样要兜：
            // wx.request 本身也可能同步抛错（并行上限、宿主异常等），
            // 直接穿透出去会让 SDK 连 fail 都收不到。
            try {
                return originalWx.request({
                    ...options,
                    enableChunked: false,
                    responseType: 'text',
                    timeout: options.timeout || limits.requestTimeoutMs,
                    success(result) {
                        emitHeaders(result.header)
                        const body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
                        emitChunk(encodeUtf8(body))
                        settle('plain', false, result)
                    },
                    fail(result) {
                        settle('plain', true, result)
                    }
                })
            } catch (e) {
                settle('plain', true, {
                    errMsg: 'request:fail ' + ((e && e.message) || '发起请求失败')
                })
                return null
            }
        })()
        }

        // 已确认环境不支持分块：直接走一次性请求，不再白发一次探测
        if (chunkedSupported === false) {
            startPlainFallback(null)
            return task
        }

        let probe = null
        try {
            probe = originalWx.request({
                ...options,
                timeout: options.timeout || limits.requestTimeoutMs,
                // 被主动放弃后，探测请求回报的任何结果都不再上报
                success(result) {
                    if (state.abandoned) return
                    settle('probe', false, result)
                },
                fail(result) {
                    if (state.abandoned) return
                    settle('probe', true, result)
                }
            })
        } catch (e) {
            probe = null
        }

        if (probe && typeof probe.onChunkReceived === 'function') {
            // 环境原生支持分块流式：按原样透传
            chunkedSupported = true
            state.inner = probe
            if (typeof probe.onHeadersReceived === 'function') {
                probe.onHeadersReceived(emitHeaders)
            }
            /** 每收到一个分片就重新计时：只要还在出字，就不算卡住 */
            const armIdleTimer = () => {
                clearTimer()
                if (state.finished) return
                state.timer = setTimeout(() => {
                    settle('probe', true, { errMsg: `request:fail timeout（分块流式 ${seconds(limits.chunkIdleMs)} 秒没有新数据）` })
                }, limits.chunkIdleMs)
            }
            probe.onChunkReceived(chunk => {
                emitChunk(chunk && chunk.data)
                armIdleTimer()
            })
            armIdleTimer()
            return task
        }

        // 环境接受了 enableChunked 却没有分块回调 —— 记为不支持，之后不再尝试
        chunkedSupported = false
        startPlainFallback(probe)
        return task
    }

    const adapter = {
        request(options) {
            const startedAt = Date.now();
            const opts = options || {};
            return opts.enableChunked ? chunkedRequest(opts, startedAt) : plainRequest(opts, startedAt);
        },
        getStorageSync(key) {
            try {
                if (typeof originalWx.getStorageSync === 'function') return originalWx.getStorageSync(key);
            } catch (e) {
                // 环境未实现或读取失败：交给 SDK 当作「没有缓存」处理
            }
            return '';
        },
        setStorageSync(key, value) {
            try {
                if (typeof originalWx.setStorageSync === 'function') originalWx.setStorageSync(key, value);
            } catch (e) {
                // 写缓存失败不影响请求本身
            }
        },
        removeStorageSync(key) {
            try {
                if (typeof originalWx.removeStorageSync === 'function') originalWx.removeStorageSync(key);
            } catch (e) {
                // 同上
            }
        },
    };

    // 供自检使用：null=未探测，false=已降级为一次性请求
    adapter.streamingStatus = function () {
        return chunkedSupported;
    };

    return adapter;
}

module.exports = {
    createDiagnosticWx,
    encodeUtf8,
    // 供自检与界面提示引用，避免时限散落在多处
    TIMEOUTS: { PLAIN_CEILING_MS, CHUNK_IDLE_MS, REQUEST_TIMEOUT_MS }
};
