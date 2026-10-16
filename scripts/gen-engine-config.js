/**
 * gen-engine-config.js —— 把 `.env` 编译成小程序能 require 的模块。
 *
 * 为什么需要这一步：小程序运行时读不到 `.env`（包内没有文件系统、也没有 process.env），
 * 所以「外部配置」必须在**编译前**落成一个普通 JS 模块。
 *
 * 跑法（改完 `.env` 后必须跑，然后重新编译小程序）：
 *
 *   npm run config:engine
 *
 * 取值优先级：**系统环境变量 > .env > 内置默认**。
 * 所以 CI / 命令行可以临时覆盖：`ENGINE_ENDPOINT=https://x.example npm run config:engine`。
 *
 * 零依赖：自己解析 .env（只支持 KEY=VALUE、# 注释、可选 export / 引号）。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const ENV_FILE = path.join(ROOT, '.env')
const OUT_FILE = path.join(ROOT, 'utils', 'engine-config.build.js')

/** .env 键 → 生成字段。注释里写清用途，生成文件自带说明。 */
const FIELDS = [
  {
    key: 'ENGINE_ENDPOINT',
    field: 'endpoint',
    comment: '云端引擎地址，如 https://chess.imex.de5.net'
  },
  {
    key: 'ENGINE_ENDPOINT_DEV',
    field: 'endpointDev',
    comment: '开发版专用地址（envVersion=develop 时优先），如 http://112.121.168.204:8787'
  },
  {
    key: 'ENGINE_MODE',
    field: 'engineMode',
    comment: "引擎开关：remote（优先云端，失败回落本地）| local（只用端上）",
    // 只有这两个值认，其余当没配（避免拼错把引擎静默关掉）
    allow: ['remote', 'local']
  },
  {
    key: 'ENGINE_TIMEOUT_MS',
    field: 'timeoutMs',
    comment: '单次请求超时（ms）；0 或留空 = 用默认值 10000',
    numeric: true
  }
]

/** 极简 .env 解析：KEY=VALUE，# 整行注释，允许 export 前缀与单双引号 */
function parseEnv(text) {
  const out = {}
  String(text || '').split(/\r?\n/).forEach(line => {
    const raw = line.trim()
    if (!raw || raw.charAt(0) === '#') return
    const body = raw.replace(/^export\s+/, '')
    const eq = body.indexOf('=')
    if (eq === -1) return
    const key = body.slice(0, eq).trim()
    let value = body.slice(eq + 1).trim()
    // 去掉行内注释（前面有空格的 #）
    const hash = value.indexOf(' #')
    if (hash !== -1) value = value.slice(0, hash).trim()
    if (value.length >= 2) {
      const first = value.charAt(0)
      const last = value.charAt(value.length - 1)
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1)
      }
    }
    if (key) out[key] = value
  })
  return out
}

function pick(name, allow, numeric) {
  // 系统环境变量优先（CI 覆盖），其次 .env
  let value = process.env[name]
  let from = value ? '环境变量' : ''
  if (!value) {
    value = envFromFile[name]
    from = value ? '.env' : ''
  }
  value = typeof value === 'string' ? value.trim() : ''
  if (!value) return { value: null, from: '' }
  if (numeric) {
    const n = Number(value)
    if (!isFinite(n) || n < 0) {
      console.warn('[config:engine] ' + name + ' 不是数字，已忽略：' + value)
      return { value: null, from: '' }
    }
    return { value: Math.round(n), from: from }
  }
  if (allow && allow.indexOf(value) === -1) {
    console.warn('[config:engine] ' + name + ' 取值不合法（允许：' + allow.join(' / ') + '），已忽略：' + value)
    return { value: null, from: '' }
  }
  return { value: value, from: from }
}

const envText = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : ''
const envFromFile = parseEnv(envText)

const entries = []
const sources = []
FIELDS.forEach(f => {
  const got = pick(f.key, f.allow, f.numeric)
  const value = got.value === null ? (f.numeric ? 0 : '') : got.value
  const literal = f.numeric ? String(value) : JSON.stringify(value)
  entries.push('  // ' + f.comment + '\n  ' + f.field + ': ' + literal)
  if (got.from) sources.push(f.key + '=' + got.value + '（' + got.from + '）')
})

const stamp = new Date().toISOString()
const body = '/**\n' +
  ' * ⚠️ 自动生成，不要手改。\n' +
  ' *\n' +
  ' * 由 `npm run config:engine` 从项目根 `.env` 生成（`scripts/gen-engine-config.js`）。\n' +
  ' * 这个文件**要提交**：小程序 require 不到模块就是编译错误，不能靠 .gitignore 排除后现场生成。\n' +
  ' * 改地址请改 `.env` 再跑一次脚本，然后重新编译小程序。\n' +
  ' *\n' +
  ' * 生成时间：' + stamp + '\n' +
  (sources.length ? ' * 本次取值：' + sources.join('、') + '\n' : ' * 本次取值：全部留空（运行时走内置默认）\n') +
  ' */\n' +
  'module.exports = {\n' +
  entries.join(',\n') + '\n' +
  '}\n'

fs.writeFileSync(OUT_FILE, body, 'utf8')

console.log('[config:engine] 已生成 ' + path.relative(ROOT, OUT_FILE))
if (!fs.existsSync(ENV_FILE)) {
  console.log('[config:engine] 未找到 .env（可复制 .env.example 改名），当前全部走内置默认')
}
sources.forEach(s => console.log('  · ' + s))
if (!sources.length) console.log('  · 无外部取值，端点 = 内置默认 https://chess.imex.de5.net')
