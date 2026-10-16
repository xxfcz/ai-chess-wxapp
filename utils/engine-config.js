/**
 * 引擎端点配置：把「云端引擎在哪」从代码里挪到外面。
 *
 * ## 为什么不是直接 process.env / .env
 *
 * 小程序运行时既没有 `process`，也读不到包外文件（包内只有代码，没有文件系统），
 * 所以 `process.env.ENGINE_ENDPOINT` 和运行时读 `.env` **在小程序里都不成立**。
 * 可行的只有两条路，这里两条都留了：
 *
 *   A.**构建前注入**：改 `.env` → 跑 `npm run config:engine` → 生成 `engine-config.build.js`
 *     → 重新编译小程序。**不进版本库的是 `.env`，生成文件要提交**（否则新克隆的项目
 *     会因为 require 不到模块而编译失败）。
 *   B.**运行时覆盖**：本地缓存 / 代码内 `setEndpoint()`。真机调试想临时换地址时用它，
 *     **不用改代码、不用重新编译**。
 *
 * ## 解析顺序（先命中先用）
 *
 *   1. 代码内覆盖    `setEndpoint()`（测试与联调用，最高优先级）
 *   2. 本地缓存      `wx.getStorageSync('ai-chess.engineEndpoint')`
 *   3. 构建注入      `engine-config.build.js`（来自 `.env` / 环境变量）
 *      —— 开发版（envVersion=develop）优先用 `endpointDev`，方便本机指向 http 调试机
 *   4. 内置默认      `BUILT_IN_ENDPOINT`
 *
 * 地址一律经 `normalizeEndpoint()`：去尾斜杠、只认 http/https，不合法就当没配（回落到下一级），
 * 避免写错一个字符让整个引擎不可用。
 */
'use strict'

/** 内置默认：没有 .env、没有缓存时的落点（正式环境地址） */
const BUILT_IN_ENDPOINT = 'https://chess.imex.de5.net'

const STORAGE_KEY_ENDPOINT = 'ai-chess.engineEndpoint'
const STORAGE_KEY_MODE = 'ai-chess.engineMode'

let runtimeEndpoint = ''

/**
 * 构建注入值。文件由 `npm run config:engine` 生成，**必须存在**（小程序 require 不到就是编译错误）。
 * 字段缺失一律按「没配」处理。
 */
let built = null
function builtConfig() {
  if (built) return built
  try {
    built = require('./engine-config.build.js')
  } catch (e) {
    built = {}
  }
  return built
}

function normalizeEndpoint(value) {
  if (typeof value !== 'string') return ''
  const url = value.trim().replace(/\/+$/, '')
  if (!url) return ''
  // 只认 http(s)：小程序不允许其它协议，写错了就当没配，回落到下一级而不是硬失败
  return /^https?:\/\/.+/i.test(url) ? url : ''
}

/** 当前小程序版本：develop（开发版）/ trial（体验版）/ release（正式版）；取不到返回 '' */
function envVersion() {
  try {
    const host = typeof wx !== 'undefined' ? wx : null
    if (!host || typeof host.getAccountInfoSync !== 'function') return ''
    const info = host.getAccountInfoSync() || {}
    return (info.miniProgram && info.miniProgram.envVersion) || ''
  } catch (e) {
    return ''
  }
}

function readStorage(key) {
  try {
    const host = typeof wx !== 'undefined' ? wx : null
    if (!host || typeof host.getStorageSync !== 'function') return ''
    const v = host.getStorageSync(key)
    return typeof v === 'string' ? v : ''
  } catch (e) {
    return ''
  }
}

/**
 * 解析端点。
 * @returns {{ endpoint:string, from:string }} from 供日志/界面显示来源：override / storage / env / default
 */
function resolveEndpoint() {
  if (runtimeEndpoint) return { endpoint: runtimeEndpoint, from: 'override' }

  const stored = normalizeEndpoint(readStorage(STORAGE_KEY_ENDPOINT))
  if (stored) return { endpoint: stored, from: 'storage' }

  const b = builtConfig() || {}
  // 开发版优先用调试地址（.env 里 ENGINE_ENDPOINT_DEV）：本机/内网 http 服务在 develop 下可用
  if (envVersion() === 'develop') {
    const dev = normalizeEndpoint(b.endpointDev)
    if (dev) return { endpoint: dev, from: 'env(dev)' }
  }
  const main = normalizeEndpoint(b.endpoint)
  if (main) return { endpoint: main, from: 'env' }

  return { endpoint: BUILT_IN_ENDPOINT, from: 'default' }
}

/**
 * 引擎开关（docs/能力开关与功能矩阵.md）：`remote` 优先云端、`local` 只用端上。
 * 解析顺序与端点一致：代码覆盖 > 本地缓存 > 构建注入 > 默认 remote。
 */
function resolveEngineMode() {
  const stored = readStorage(STORAGE_KEY_MODE)
  if (stored === 'local' || stored === 'remote') return stored
  const b = builtConfig() || {}
  if (b.engineMode === 'local' || b.engineMode === 'remote') return b.engineMode
  return 'remote'
}

/** 请求超时（ms）；没配就用 remote-engine 自己的默认 */
function resolveTimeoutMs() {
  const b = builtConfig() || {}
  const n = Number(b.timeoutMs)
  return isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** 代码内覆盖端点（最高优先级）；传空串表示取消覆盖 */
function setEndpoint(url) {
  runtimeEndpoint = normalizeEndpoint(url)
  return runtimeEndpoint
}

function getEndpoint() {
  return resolveEndpoint().endpoint
}

/** 重新读构建配置（生成文件被替换后调用；小程序里一般只在测试用） */
function reload() {
  built = null
  runtimeEndpoint = ''
}

module.exports = {
  BUILT_IN_ENDPOINT,
  STORAGE_KEY_ENDPOINT,
  STORAGE_KEY_MODE,
  resolveEndpoint,
  resolveEngineMode,
  resolveTimeoutMs,
  setEndpoint,
  getEndpoint,
  reload,
  normalizeEndpoint,
  envVersion
}
