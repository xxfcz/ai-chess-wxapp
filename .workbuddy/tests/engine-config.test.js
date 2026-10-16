/**
 * engine-config.test.js
 * 端点外部配置的回归测试（不打网络）。
 *
 * 覆盖：解析优先级、地址规整、非法值回落到下一级、小程序版本（develop/release）分流。
 * 跑法：node .workbuddy/tests/engine-config.test.js
 */
'use strict'

const path = require('path')
const H = require('./_harness')

const config = require(path.resolve(__dirname, '../../utils/engine-config.js'))
const BUILD = path.resolve(__dirname, '../../utils/engine-config.build.js')

/** 把「构建注入」那一层换成指定内容（Node 里改 require 缓存；小程序里它是真实文件） */
function setBuilt(value) {
  require.cache[BUILD] = {
    id: BUILD,
    filename: BUILD,
    loaded: true,
    exports: value
  }
  config.reload()
}

/** 装一个带缓存与版本信息的假 wx；传 null 表示「没有 wx」（Node 直跑 / 预览缺接口） */
function installWx(storage, version) {
  if (storage === null && version === null) {
    delete global.wx
    return
  }
  global.wx = {
    getStorageSync(key) {
      return storage && Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : ''
    },
    getAccountInfoSync() {
      return { miniProgram: { envVersion: version || '' } }
    }
  }
}

function clearWx() {
  delete global.wx
}

async function main() {
  /* ------------------------------------------------------ 1. 地址规整 */
  H.section('1. 地址规整（只认 http/https，去尾斜杠）')

  H.eq(config.normalizeEndpoint('https://chess.imex.de5.net/'), 'https://chess.imex.de5.net', '去掉尾部斜杠')
  H.eq(config.normalizeEndpoint('  http://1.2.3.4:8787  '), 'http://1.2.3.4:8787', '两端空白去掉')
  H.eq(config.normalizeEndpoint('ftp://x.example'), '', '非 http(s) 一律当没配（回落到下一级）')
  H.eq(config.normalizeEndpoint('chess.imex.de5.net'), '', '缺协议也不认')
  H.eq(config.normalizeEndpoint(''), '', '空串视为没配')
  H.eq(config.normalizeEndpoint(null), '', 'null 不炸')

  /* ------------------------------------------------ 2. 默认与构建注入 */
  H.section('2. 解析优先级：override > storage > env > 默认')

  clearWx()
  setBuilt({})
  H.eq(config.resolveEndpoint().endpoint, config.BUILT_IN_ENDPOINT, '什么都没配 → 内置默认')
  H.eq(config.resolveEndpoint().from, 'default', '来源标记为 default')

  clearWx()
  setBuilt({ endpoint: 'https://a.example' })
  H.eq(config.resolveEndpoint().endpoint, 'https://a.example', '.env 注入生效')
  H.eq(config.resolveEndpoint().from, 'env', '来源标记为 env')

  clearWx()
  setBuilt({ endpoint: '这不是地址' })
  H.eq(config.resolveEndpoint().endpoint, config.BUILT_IN_ENDPOINT, '注入值不合法 → 回落到默认（不硬失败）')

  installWx({ 'ai-chess.engineEndpoint': 'https://cached.example' }, 'release')
  setBuilt({ endpoint: 'https://a.example' })
  H.eq(config.resolveEndpoint().endpoint, 'https://cached.example', '本地缓存优先于 .env')
  H.eq(config.resolveEndpoint().from, 'storage', '来源标记为 storage')

  installWx({ 'ai-chess.engineEndpoint': 'https://cached.example' }, 'release')
  setBuilt({ endpoint: 'https://a.example' })
  config.setEndpoint('https://override.example')
  H.eq(config.resolveEndpoint().endpoint, 'https://override.example', '代码覆盖是最高优先级')
  H.eq(config.resolveEndpoint().from, 'override', '来源标记为 override')
  config.setEndpoint('')
  H.eq(config.resolveEndpoint().endpoint, 'https://cached.example', '取消覆盖后回到缓存值')

  /* -------------------------------------------- 3. 开发版走调试地址 */
  H.section('3. develop 优先用 ENGINE_ENDPOINT_DEV')

  installWx({}, 'develop')
  setBuilt({ endpoint: 'https://prod.example', endpointDev: 'http://192.168.1.9:8787' })
  H.eq(config.resolveEndpoint().endpoint, 'http://192.168.1.9:8787', '开发版用调试地址（可以是 http + IP）')
  H.eq(config.resolveEndpoint().from, 'env(dev)', '来源标记为 env(dev)')

  installWx({}, 'release')
  setBuilt({ endpoint: 'https://prod.example', endpointDev: 'http://192.168.1.9:8787' })
  H.eq(config.resolveEndpoint().endpoint, 'https://prod.example', '正式版**不**用调试地址（http/IP 在 release 下不可用）')

  installWx({}, 'trial')
  setBuilt({ endpoint: 'https://prod.example', endpointDev: 'http://192.168.1.9:8787' })
  H.eq(config.resolveEndpoint().endpoint, 'https://prod.example', '体验版同正式版')

  installWx({}, 'develop')
  setBuilt({ endpoint: 'https://prod.example', endpointDev: '' })
  H.eq(config.resolveEndpoint().endpoint, 'https://prod.example', '没配 dev 就退回通用地址')

  /* ---------------------------------------------------- 4. 开关与超时 */
  H.section('4. 引擎开关 / 超时也走同一套配置')

  clearWx()
  setBuilt({})
  H.eq(config.resolveEngineMode(), 'remote', '默认 remote（优先云端，失败回落本地）')
  H.eq(config.resolveTimeoutMs(), 0, '没配超时 → 0（由 remote-engine 用自己的默认）')

  setBuilt({ engineMode: 'local' })
  H.eq(config.resolveEngineMode(), 'local', 'ENGINE_MODE=local 生效')
  setBuilt({ engineMode: 'LOCAL' })
  H.eq(config.resolveEngineMode(), 'remote', '大小写不合法时按没配处理（不静默关掉云端）')
  setBuilt({ timeoutMs: 3000 })
  H.eq(config.resolveTimeoutMs(), 3000, '超时从配置读')

  installWx({ 'ai-chess.engineMode': 'local' }, 'develop')
  setBuilt({ engineMode: 'remote' })
  H.eq(config.resolveEngineMode(), 'local', '缓存里的开关优先于 .env')

  /* ------------------------------------------------ 5. 缺接口不炸 */
  H.section('5. 环境缺 wx 接口不能炸（预览只实现子集）')

  installWx(null, null)
  setBuilt({})
  H.doesNotThrow(() => config.resolveEndpoint(), '没有 wx 也能解析（走默认）')
  H.doesNotThrow(() => config.resolveEngineMode(), '没有 wx 也能拿到开关')

  global.wx = { getStorageSync() { throw new Error('boom') }, getAccountInfoSync() { throw new Error('boom') } }
  H.doesNotThrow(() => config.resolveEndpoint(), 'wx 接口抛错也被兜住')

  clearWx()
  setBuilt({})
  config.reload()

  return H.summary('engine-config.test.js')
}

main()
