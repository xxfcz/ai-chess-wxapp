/**
 * clipboard-import.js · 剪贴板自动导入 FEN 的共享逻辑（Landing 与分析页共用）。
 *
 * 把「探测 → 去重 → 询问 → 应用」抽成纯逻辑，避免 Landing / analyze 各写一遍。
 * 全部依赖 wx 的能力都先探测，缺接口静默降级（符合 AGENTS.md §2/§8 预览子集约束）。
 * 不依赖 wx / DOM，可纯 Node 单测（回归脚本直接 require）。
 *
 * 数据格式约定（memory）：内部一律 FEN + UCI；这里只处理 FEN 文本抽取，
 * PGN 边界转换留给导入时各模式做一次（load_pgn）。
 */
const { isValidFen, extractFen } = require('./game')

/**
 * 探测剪贴板里的合法 FEN。
 * @param {object|null} host wx 或 null
 * @returns {Promise<string|null>} 规整后的合法 FEN；无接口 / 失败 / 找不到都返回 null
 */
function readClipboardFen(host) {
  return new Promise(resolve => {
    if (!host || typeof host.getClipboardData !== 'function') return resolve(null)
    host.getClipboardData({
      success: res => {
        const raw = (res && typeof res.data === 'string') ? res.data : ''
        resolve(extractFen(raw))
      },
      fail: () => resolve(null)
    })
  })
}

/**
 * 询问是否导入检测到的 FEN；无 showModal 能力时直接放弃（不打扰、也不偷偷改局面）。
 * @returns {Promise<boolean>} 用户确认返回 true
 */
function confirmImportFen(host, fen) {
  return new Promise(resolve => {
    if (!host || typeof host.showModal !== 'function') return resolve(false)
    const preview = fen.length > 56 ? fen.slice(0, 56) + '…' : fen
    host.showModal({
      title: '从剪贴板导入局面',
      content: '检测到剪贴板里有合法局面：\n' + preview + '\n是否载入并分析？',
      confirmText: '载入',
      cancelText: '忽略',
      success: r => resolve(!!(r && r.confirm)),
      fail: () => resolve(false)
    })
  })
}

/**
 * 自动导入流程（共享核心）：
 *   探测剪贴板 → 抽取 FEN → 与当前局面 / 最近一次已询问内容去重 → 询问 → 确认则 onApply。
 *
 * 去重由两个回调交给调用方维护（analyze / Landing 各自持有 _lastPromptedFen），
 * 因为「同一内容只问一次」的状态属于调用方页面实例。markPrompted 在弹窗前同步写入，
 * 避免快速重入的 onShow 对同一内容重复弹窗。
 *
 * @param {object} opts
 *   host: wx 或 null
 *   currentFen: 当前局面 FEN（与之一致则不打扰）；Landing 无棋盘可传 ''
 *   alreadyPrompted(fen): 该内容是否已问过
 *   markPrompted(fen): 标记为已问
 *   onApply(fen): 用户确认后的落地动作（analyze→载入选局面；Landing→跳分包并传 fen）
 * @returns {Promise<{fen:string|null, confirmed:boolean}>}
 */
async function autoImportFenFromClipboard(opts) {
  const host = opts.host
  const fen = await readClipboardFen(host)
  if (!fen) return { fen: null, confirmed: false }
  if (fen === opts.currentFen) return { fen, confirmed: false }
  if (opts.alreadyPrompted && opts.alreadyPrompted(fen)) return { fen, confirmed: false }
  if (opts.markPrompted) opts.markPrompted(fen)
  const confirmed = await confirmImportFen(host, fen)
  if (confirmed && opts.onApply) opts.onApply(fen)
  return { fen, confirmed }
}

module.exports = { readClipboardFen, confirmImportFen, autoImportFenFromClipboard, isValidFen, extractFen }
