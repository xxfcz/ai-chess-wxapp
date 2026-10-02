/**
 * cloud.js
 * 云服务客户端（微信原生小程序形态）。
 *
 * 只能通过 @tencent-ai/workbuddy-cloud-sdk/miniprogram 这个子路径初始化，
 * 且两个 publicConfig 值都必须传入：小程序没有 location.origin，
 * 省略 endpoint 会直接初始化失败。
 */
// 副作用导入：SDK 的 SSE 解析器内部依赖全局 TextDecoder，微信真机没有这个对象。
// 放在这里是为了「只要碰云服务就一定会先补好」，不依赖 app.js 的执行时机。
require('./text-codec').installTextCodec()

const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')
const { publicConfig } = require('./cloud-config')

let cached = null

/**
 * 懒加载并复用同一个客户端实例。
 * 云服务不可用时抛出的错误由调用方捕获并给出可读提示。
 */
function getCloud() {
  if (cached) return cached
  cached = createMiniProgramWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
    wx: createDiagnosticWx(wx)
  })
  return cached
}

module.exports = { getCloud, publicConfig }
