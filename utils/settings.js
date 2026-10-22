/**
 * settings.js · L0：用户偏好（纯逻辑，无 UI / 无 wx 依赖，可纯 Node 单测）。
 *
 * 承载对弈/点评相关的用户设置（方案 §11.4 / §11.5）：
 *   autoCoach        'off' | 'on' | 'remoteOnly'  自动点评开关
 *   playCoachScope   'allSteps' | 'keySteps'       对弈专属：每步 / 仅关键步
 *   playKeyCp        关键步判定阈值（cp，约一兵；保守/标准/宽松档在 UI 映射）
 *   playAs           'w' | 'b'                    玩家默认执子方
 *
 * 注意：引擎模式（remote/local）不在此处——它由 engine-config + analysis-service 单独管理，
 * 这里只管「用户偏好」，不重复引擎开关的语义。
 *
 * 持久化：优先 wx storage；缺接口（预览子集）静默降级为「只活在本会话内存」。
 * 测试可用 `_setBackend` 注入桩、`_reset` 清空。
 */

const DEFAULTS = {
  autoCoach: 'on',
  playCoachScope: 'keySteps',
  playKeyCp: 80,
  playAs: 'w',
  sparrerLevel: 'standard'
}

/** 合法取值白名单：写入时做一道校验，避免脏数据污染 UI 分支 */
const ALLOWED = {
  autoCoach: ['off', 'on', 'remoteOnly'],
  playCoachScope: ['allSteps', 'keySteps'],
  playAs: ['w', 'b'],
  sparrerLevel: ['easy', 'standard', 'strong']
}

const NS = 'chess.settings.'

let _backend = undefined // undefined=未探测；null=无 storage；否则 {getItem,setItem}
let _mem = {} // 内存缓存；_setBackend/_reset 会整体替换（故用 let）

function _detectStorage() {
  const host = typeof wx !== 'undefined' ? wx : null
  if (host && typeof host.getStorageSync === 'function' && typeof host.setStorageSync === 'function') {
    return {
      getItem(k) {
        try { return host.getStorageSync(k) } catch (e) { return undefined }
      },
      setItem(k, v) {
        try { host.setStorageSync(k, v) } catch (e) { /* 写入失败静默 */ }
      }
    }
  }
  return null
}

function _backendNow() {
  if (_backend === undefined) _backend = _detectStorage()
  return _backend
}

function _read(key) {
  const b = _backendNow()
  if (!b) return undefined
  try { return b.getItem(NS + key) } catch (e) { return undefined }
}

function _write(key, value) {
  const b = _backendNow()
  if (!b) return
  try { b.setItem(NS + key, value) } catch (e) { /* 写入失败静默 */ }
}

function _coerce(key, value) {
  if (key === 'playKeyCp') {
    const n = Number(value)
    return isFinite(n) ? Math.max(10, Math.min(400, Math.round(n))) : DEFAULTS.playKeyCp
  }
  const allowed = ALLOWED[key]
  if (allowed && allowed.indexOf(value) === -1) return DEFAULTS[key]
  return value
}

/** 读取单个偏好（带默认值 + 缓存） */
function getSetting(key) {
  if (Object.prototype.hasOwnProperty.call(_mem, key)) return _mem[key]
  const stored = _read(key)
  const value = stored !== undefined ? _coerce(key, stored) : DEFAULTS[key]
  _mem[key] = value
  return value
}

/** 读取全部偏好（浅拷贝，调用方不可直接改返回值影响内部） */
function getSettings() {
  const out = {}
  Object.keys(DEFAULTS).forEach(k => { out[k] = getSetting(k) })
  return out
}

/** 写入单个偏好（同步记忆 + 持久化） */
function setSetting(key, value) {
  if (!(key in DEFAULTS)) return
  const v = _coerce(key, value)
  _mem[key] = v
  _write(key, v)
}

/** 批量写入（来自设置页） */
function setSettings(patch) {
  if (!patch || typeof patch !== 'object') return
  Object.keys(DEFAULTS).forEach(k => {
    if (Object.prototype.hasOwnProperty.call(patch, k)) setSetting(k, patch[k])
  })
}

/* ----------------------------------------------- 测试 / 自检钩子（不进生产逻辑） */

/** 注入 storage 桩：{ getItem(k), setItem(k,v) } 或 null（模拟无 storage 环境） */
function _setBackend(b) {
  _backend = b
  _mem = {}
}

/** 清空内存 + 重置 storage 探测（测试之间隔离） */
function _reset() {
  _mem = {}
  _backend = undefined
}

module.exports = {
  getSetting,
  getSettings,
  setSetting,
  setSettings,
  DEFAULTS,
  _setBackend,
  _reset
}
