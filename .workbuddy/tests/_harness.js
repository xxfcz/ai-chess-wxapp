/**
 * _harness.js
 * 三套回归测试共用的极简断言/报告工具（零依赖、纯 Node）。
 *
 * 为什么不用 jest/mocha：这些脚本要能在没有 node_modules 的环境里
 * `node xxx.test.js` 直接跑，多一个依赖就多一处不可跑的风险。
 */
'use strict'

const state = { section: '', total: 0, failed: 0, failures: [] }

/** 开始一个新小节，只在终端上做视觉分组 */
function section(name) {
  state.section = name
  console.log('\n\x1b[1m' + name + '\x1b[0m')
}

function pass(name) {
  state.total++
  console.log('  \x1b[32m✓\x1b[0m ' + name)
}

function fail(name, detail) {
  state.total++
  state.failed++
  const line = state.section + ' :: ' + name + (detail ? '\n      ' + detail : '')
  state.failures.push(line)
  console.log('  \x1b[31m✗\x1b[0m ' + name)
  if (detail) console.log('      \x1b[31m' + detail + '\x1b[0m')
}

function ok(cond, name, detail) {
  if (cond) pass(name)
  else fail(name, detail)
  return !!cond
}

function eq(actual, expected, name) {
  const same = actual === expected
  ok(same, name, same ? '' : `期望 ${format(expected)}，实际 ${format(actual)}`)
  return same
}

function numEq(actual, expected, name) {
  return eq(Number(actual), Number(expected), name)
}

/** 数组成员完全一致（顺序无关），用于走法集合比对 */
function sameSet(actual, expected, name) {
  const a = [...(actual || [])].sort()
  const b = [...(expected || [])].sort()
  const same = a.length === b.length && a.every((v, i) => v === b[i])
  ok(same, name, same ? '' : `集合不一致\n      期望 ${b.join(',')}\n      实际 ${a.join(',')}`)
  return same
}

/** 断言 fn 抛出错误；matcher 可以是字符串（message 包含）或正则或函数 */
function throws(fn, matcher, name) {
  let threw = false
  let err = null
  try {
    fn()
  } catch (e) {
    threw = true
    err = e
  }
  if (!threw) {
    fail(name, '没有抛出任何错误')
    return null
  }
  if (matcher) {
    let matched = false
    if (typeof matcher === 'function') matched = !!matcher(err)
    else if (matcher instanceof RegExp) matched = matcher.test(String(err.message))
    else matched = String(err.message).indexOf(String(matcher)) !== -1
    if (!matched) {
      fail(name, `错误不符合预期：${format(err && err.message)}`)
      return err
    }
  }
  pass(name)
  return err
}

/** 断言 fn 不抛错（降级路径常用：环境少个接口也不能让调用方崩） */
function doesNotThrow(fn, name) {
  try {
    fn()
    pass(name)
    return true
  } catch (e) {
    fail(name, `抛出了：${format(e && e.message)}`)
    return false
  }
}

async function throwsAsync(fn, matcher, name) {
  let threw = false
  let err = null
  try {
    await fn()
  } catch (e) {
    threw = true
    err = e
  }
  if (!threw) {
    fail(name, '没有抛出任何错误')
    return null
  }
  if (matcher) {
    let matched = false
    if (typeof matcher === 'function') matched = !!matcher(err)
    else if (matcher instanceof RegExp) matched = matcher.test(String(err.message))
    else matched = String(err.message).indexOf(String(matcher)) !== -1
    if (!matched) {
      fail(name, `错误不符合预期：${format(err && err.message)}`)
      return err
    }
  }
  pass(name)
  return err
}

function format(v) {
  if (typeof v === 'string') return JSON.stringify(v)
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch (e) {
      return Object.prototype.toString.call(v)
    }
  }
  return String(v)
}

function summary(fileLabel) {
  console.log('\n' + '-'.repeat(56))
  if (state.failed === 0) {
    console.log(`\x1b[32m全绿\x1b[0m  ${fileLabel}  共 ${state.total} 项断言`)
    process.exitCode = 0
    return true
  }
  console.log(`\x1b[31m失败\x1b[0m  ${fileLabel}  ${state.failed}/${state.total} 项断言未通过`)
  for (let i = 0; i < state.failures.length; i++) console.log('  · ' + state.failures[i])
  process.exitCode = 1
  return false
}

module.exports = { section, ok, eq, numEq, sameSet, throws, throwsAsync, doesNotThrow, summary, format, state }
