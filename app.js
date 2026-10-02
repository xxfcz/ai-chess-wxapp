/**
 * app.js
 *
 * 启动顺序很重要：
 *   1) 先补运行环境缺的 UTF-8 编解码器 —— 云服务 SDK 的流式解析依赖全局
 *      `TextDecoder`，微信小程序真机没有这个对象，缺了就会在解析第一个分片时
 *      抛 `TextDecoder is not defined`（预览环境有，所以只在真机上暴露）。
 *   2) 再挂日志缓冲，把 console 与未捕获错误收进内存，供页面上的「运行日志」查看。
 *
 * 两件事都必须在小程序启动时完成，不能等页面里用到云服务才做。
 */
const { installTextCodec } = require('./utils/text-codec')
const debugLog = require('./utils/debug-log')

const codec = installTextCodec()
let codecNote = codec.installed
  ? '已补：' + [codec.decoder ? 'TextDecoder' : '', codec.encoder ? 'TextEncoder' : ''].filter(Boolean).join(' / ')
  : '运行环境自带，无需补'

console.log('[app] 启动 · UTF-8 编解码器 ' + codecNote)

App({
  globalData: {
    // 由分析页写入的最近一次局面，便于后续扩展多页共享
    lastFen: '',
    /** 启动时的编码器兜底结论，便于排查「真机缺 TextDecoder」这类问题 */
    codecNote: codecNote
  },
  onLaunch() {
    debugLog.install()
    debugLog.push('info', '[app] 启动完成 · ' + codecNote)
  },
  onError(err) {
    const message = err && err.message ? err.message : String(err)
    debugLog.push('error', '[app] 未捕获错误 ' + message)
    console.error('[app] uncaught error', message)
  },
  onUnhandledRejection(res) {
    const reason = res && res.reason
    debugLog.push('error', '[app] 未处理的 Promise 拒绝 ' + (reason && reason.message ? reason.message : String(reason)))
  }
})
