/**
 * cloud-config.js
 * 云服务公开配置（来自 WorkBuddy 云服务开通结果 publicConfig）。
 * 这三个值是唯一可以随小程序前端代码一起发布的云服务凭据：
 *   - endpoint      当前应用的数据面入口
 *   - publishableKey 标识「是哪个应用」，本身不携带任何权限（服务端按来源校验）
 * 不要在这里写入任何长期密钥、环境 id 或服务端凭据。
 */
const publicConfig = {
  resourceId: 'wbcs_lgFNlEpClBk313UYV660rn',
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_Q0BvUcC34QxiYVHs0aFeay_tRNDkb2Ib91NfyPBzmLuNjc7hKrzC128'
}

module.exports = { publicConfig }
