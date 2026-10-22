/**
 * ⚠️ 自动生成，不要手改。
 *
 * 由 `npm run config:engine` 从项目根 `.env` 生成（`scripts/gen-engine-config.js`）。
 * 这个文件**要提交**：小程序 require 不到模块就是编译错误，不能靠 .gitignore 排除后现场生成。
 * 改地址请改 `.env` 再跑一次脚本，然后重新编译小程序。
 *
 * 生成时间：2026-10-22T14:59:39.751Z
 * 本次取值：ENGINE_ENDPOINT=https://chess.imex.de5.net（.env）、ENGINE_MODE=remote（.env）
 */
module.exports = {
  // 云端引擎地址，如 https://chess.imex.de5.net
  endpoint: "https://chess.imex.de5.net",
  // 开发版专用地址（envVersion=develop 时优先），如 http://112.121.168.204:8787
  endpointDev: "",
  // 引擎开关：remote（优先云端，失败回落本地）| local（只用端上）
  engineMode: "remote",
  // 单次请求超时（ms）；0 或留空 = 用默认值 10000
  timeoutMs: 0
}
