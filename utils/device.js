/**
 * device.js
 * 运行环境的安全取值：窗口宽度、轻提示。
 *
 * 网页版模拟预览不保证实现 getWindowInfo / getSystemInfoSync / showToast，
 * 这里逐级降级到浏览器全局量，最后兜底 375，保证任何环境下都返回可用值而不是抛错。
 */

const FALLBACK_WIDTH = 375
// 拿不到真实高度时，用一台常见机型的高度兜底，保证棋盘尺寸计算不会把棋盘撑太大
const FALLBACK_HEIGHT = 812

function isPositive(value) {
  return typeof value === 'number' && isFinite(value) && value > 0
}

/** 屏幕可视宽度（CSS 像素） */
function getWindowWidth() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.getWindowInfo === 'function') {
      const info = wx.getWindowInfo()
      if (info && isPositive(info.windowWidth)) return info.windowWidth
    }
  } catch (e) {
    // 低版本基础库没有 getWindowInfo
  }

  try {
    if (typeof wx !== 'undefined' && typeof wx.getSystemInfoSync === 'function') {
      const info = wx.getSystemInfoSync()
      if (info && isPositive(info.windowWidth)) return info.windowWidth
    }
  } catch (e) {
    // 同上，继续降级
  }

  try {
    if (typeof window !== 'undefined' && isPositive(window.innerWidth)) return window.innerWidth
  } catch (e) {
    // 非浏览器环境
  }

  try {
    const el = typeof document !== 'undefined' ? document.documentElement : null
    if (el && isPositive(el.clientWidth)) return el.clientWidth
  } catch (e) {
    // 非浏览器环境
  }

  return FALLBACK_WIDTH
}

/** 屏幕可视高度（CSS 像素）；与宽度一样逐级降级，缺值时用典型机型高度兜底 */
function getWindowHeight() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.getWindowInfo === 'function') {
      const info = wx.getWindowInfo()
      if (info && isPositive(info.windowHeight)) return info.windowHeight
    }
  } catch (e) {
    // 低版本基础库没有 getWindowInfo
  }

  try {
    if (typeof wx !== 'undefined' && typeof wx.getSystemInfoSync === 'function') {
      const info = wx.getSystemInfoSync()
      if (info && isPositive(info.windowHeight)) return info.windowHeight
    }
  } catch (e) {
    // 同上，继续降级
  }

  try {
    if (typeof window !== 'undefined' && isPositive(window.innerHeight)) return window.innerHeight
  } catch (e) {
    // 非浏览器环境
  }

  try {
    const el = typeof document !== 'undefined' ? document.documentElement : null
    if (el && isPositive(el.clientHeight)) return el.clientHeight
  } catch (e) {
    // 非浏览器环境
  }

  return FALLBACK_HEIGHT
}

/** 轻提示；环境不支持时只在控制台留痕，绝不因为提示本身报错 */
function toast(title) {
  try {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title: title, icon: 'none' })
      return
    }
  } catch (e) {
    // 继续降级
  }
  try {
    console.log('[toast] ' + title)
  } catch (e) {
    // 控制台不可用时忽略
  }
}

/**
 * 复制到剪贴板。环境不支持时如实提示，绝不因为「复制」本身抛错。
 * @returns {boolean} 是否真的调到了剪贴板接口（false 表示已降级为提示）
 */
function copyText(text) {
  const data = typeof text === 'string' ? text : String(text == null ? '' : text)
  try {
    if (typeof wx !== 'undefined' && typeof wx.setClipboardData === 'function') {
      wx.setClipboardData({
        data: data,
        success: () => toast('已复制到剪贴板'),
        fail: () => toast('复制失败，可长按选中文字')
      })
      return true
    }
  } catch (e) {
    // 继续降级
  }
  toast('当前环境不支持复制')
  return false
}

/**
 * 弹出操作菜单（长按点评后让用户挑要复制哪一段）。
 * 环境不支持时返回 false，调用方应降级为「直接复制最具体的那一项」。
 *
 * @param {string[]} itemList 菜单项（微信限制最多 6 项）
 * @param {(index:number)=>void} onPick 选中回调
 */
function actionSheet(itemList, onPick) {
  try {
    if (typeof wx !== 'undefined' && typeof wx.showActionSheet === 'function' && itemList && itemList.length) {
      wx.showActionSheet({
        itemList: itemList,
        success: res => {
          if (typeof onPick === 'function') onPick(res && typeof res.tapIndex === 'number' ? res.tapIndex : -1)
        },
        fail: () => {
          // 用户取消，忽略
        }
      })
      return true
    }
  } catch (e) {
    // 继续降级
  }
  return false
}

/**
 * 当前环境是否具备网络请求能力。
 *
 * 网页版预览只实现微信接口的一个子集（已知没有 createSelectorQuery），
 * 云端点评依赖 wx.request，所以在调用前先探测一次，
 * 好给用户一句明确的话，而不是抛一个英文 TypeError。
 */
function canRequest() {
  try {
    return typeof wx !== 'undefined' && typeof wx.request === 'function'
  } catch (e) {
    return false
  }
}

module.exports = {
  getWindowWidth,
  getWindowHeight,
  toast,
  canRequest,
  copyText,
  actionSheet,
  FALLBACK_WIDTH,
  FALLBACK_HEIGHT
}
