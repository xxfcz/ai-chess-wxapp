/**
 * text-codec.js
 * 运行环境缺失的 UTF-8 编解码器。
 *
 * 为什么需要：云服务 SDK 的 SSE 解析器内部写着 `new TextDecoder('utf-8')`
 * 并对每个分片做 `decode(bytes, { stream: true })`。浏览器和 Node 里有这个全局对象，
 * 所以网页版预览一直正常；但**微信小程序运行时（真机）没有 TextDecoder**，
 * 一进入流式解析就抛 `TextDecoder is not defined` —— 端上分析与它无关，不受影响。
 *
 * 因此在小程序启动时（以及建立云客户端之前）把缺失的实现补到全局对象上：
 *   - 只在「原生实现不存在」时安装，绝不覆盖宿主已有的实现；
 *   - 支持 `decode(bytes)` / `decode(bytes, {stream:true})` / `decode()`（收尾刷出），
 *     增量语义与原生一致：跨分片被截断的多字节字符会缓到下一次。
 *
 * 另一个方向（编码）由 workbuddy-cloud-diagnostics.js 里的 encodeUtf8 手写完成，
 * 这里也顺手补一个 TextEncoder，避免其他依赖处再踩一次。
 */

const REPLACEMENT_CHAR = 0xfffd

/** 把各种可能的入参统一成 Uint8Array */
function toBytes(input) {
  if (input === undefined || input === null) return new Uint8Array(0)
  if (input instanceof Uint8Array) return input
  if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input)
  // 其他 TypedArray / DataView：按底层缓冲取，注意 byteOffset
  if (input.buffer && typeof input.byteLength === 'number') {
    return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength)
  }
  if (Array.isArray(input)) return new Uint8Array(input)
  return new Uint8Array(0)
}

/** String.fromCharCode.apply 参数过多会爆栈，分段拼接 */
function fromCharCodes(codes) {
  let out = ''
  for (let i = 0; i < codes.length; i += 4096) {
    out += String.fromCharCode.apply(null, codes.slice(i, i + 4096))
  }
  return out
}

function pushCodePoint(codes, code) {
  if (code <= 0xffff) {
    codes.push(code)
    return
  }
  const rest = code - 0x10000
  codes.push(0xd800 + (rest >> 10), 0xdc00 + (rest & 0x3ff))
}

class Utf8TextDecoder {
  constructor(label) {
    const name = String(label === undefined || label === null ? 'utf-8' : label).toLowerCase()
    if (name !== 'utf-8' && name !== 'utf8' && name !== 'unicode-1-1-utf-8') {
      throw new RangeError('TextDecoder 兜底实现只支持 utf-8，收到：' + name)
    }
    this.encoding = 'utf-8'
    this.fatal = false
    this.ignoreBOM = true
    /** 上一次解码剩下的「不完整多字节序列」字节 */
    this._tail = []
  }

  decode(input, options) {
    const stream = !!(options && options.stream)
    const bytes = toBytes(input)

    let all = bytes
    if (this._tail.length) {
      all = new Uint8Array(this._tail.length + bytes.length)
      all.set(this._tail, 0)
      all.set(bytes, this._tail.length)
    }

    const codes = []
    let i = 0
    while (i < all.length) {
      const first = all[i]

      if (first <= 0x7f) {
        codes.push(first)
        i += 1
        continue
      }

      let need = 0
      let code = 0
      let min = 0
      if (first >= 0xc2 && first <= 0xdf) {
        need = 1
        code = first & 0x1f
        min = 0x80
      } else if (first >= 0xe0 && first <= 0xef) {
        need = 2
        code = first & 0x0f
        min = 0x800
      } else if (first >= 0xf0 && first <= 0xf4) {
        need = 3
        code = first & 0x07
        min = 0x10000
      } else {
        // 0x80~0xc1、0xf5~0xff 作为首字节永远非法
        codes.push(REPLACEMENT_CHAR)
        i += 1
        continue
      }

      if (i + need > all.length - 1) {
        // 字节数不够：流式就先留着，等下一片拼上；非流式只能报替换字符
        if (stream) break
        codes.push(REPLACEMENT_CHAR)
        i += 1
        continue
      }

      let valid = true
      for (let k = 1; k <= need; k++) {
        const byte = all[i + k]
        if (byte < 0x80 || byte > 0xbf) {
          valid = false
          break
        }
      }
      if (valid) {
        for (let k = 1; k <= need; k++) {
          code = (code << 6) | (all[i + k] & 0x3f)
        }
        // 过长编码 / 代理区 / 超出 Unicode 范围
        if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) valid = false
      }
      if (!valid) {
        codes.push(REPLACEMENT_CHAR)
        i += 1
        continue
      }

      pushCodePoint(codes, code)
      i += need + 1
    }

    const text = fromCharCodes(codes)
    if (stream) {
      // 流式：把被截断的多字节序列留给下一次调用拼上
      this._tail = i < all.length ? Array.prototype.slice.call(all.subarray(i)) : []
    } else {
      // 非流式：循环里已经逐字节补过替换字符（按字节而非按序列，够用即可）
      this._tail = []
    }
    return text
  }
}

class Utf8TextEncoder {
  constructor() {
    this.encoding = 'utf-8'
  }

  encode(input) {
    const str = String(input === undefined || input === null ? '' : input)
    const bytes = []
    for (let i = 0; i < str.length; i++) {
      let code = str.charCodeAt(i)
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
    return new Uint8Array(bytes)
  }
}

/** 取全局对象；小程序最新基础库有 globalThis，旧环境逐级退回 */
function globalObject() {
  if (typeof globalThis !== 'undefined' && globalThis) return globalThis
  if (typeof global !== 'undefined' && global) return global
  if (typeof window !== 'undefined' && window) return window
  if (typeof self !== 'undefined' && self) return self
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('return this')
    return fn() || null
  } catch (e) {
    return null
  }
}

/**
 * 把缺失的 TextDecoder / TextEncoder 补到全局对象上。
 * @param {object} [target] 指定安装目标（自检用）；不传则用当前全局对象
 * @returns {{ installed:boolean, decoder:boolean, encoder:boolean, target:object|null }}
 */
function installTextCodec(target) {
  const scope = target || globalObject()
  const result = { installed: false, decoder: false, encoder: false, target: scope || null }
  if (!scope) return result
  try {
    if (typeof scope.TextDecoder !== 'function') {
      scope.TextDecoder = Utf8TextDecoder
      result.decoder = true
      result.installed = true
    }
    if (typeof scope.TextEncoder !== 'function') {
      scope.TextEncoder = Utf8TextEncoder
      result.encoder = true
      result.installed = true
    }
  } catch (e) {
    // 全局对象被冻结等极端情况：不抛错，交给调用方观察结果
  }
  return result
}

module.exports = {
  installTextCodec,
  globalObject,
  Utf8TextDecoder,
  Utf8TextEncoder,
  REPLACEMENT_CHAR
}
