/**
 * board-model.js
 * 把棋局状态换算成棋盘视图数据（纯函数，不依赖 wx / Canvas，可单独测试）。
 *
 * 棋盘用 WXML 视图渲染：一个 8×8 的 view 网格，棋子是格内的文字字形。
 * 这样不依赖 wx.createSelectorQuery（网页版预览不提供该接口），
 * 拖拽落点用「位移 ÷ 格宽」反推，也不需要查询棋盘的真实位置。
 */
const geometry = require('./geometry')

/** 统一用实心字形，靠颜色区分黑白，在深浅两种格底色上都清晰 */
const GLYPHS = {
  k: '\u265A',
  q: '\u265B',
  r: '\u265C',
  b: '\u265D',
  n: '\u265E',
  p: '\u265F'
}

const MIN_BOARD = 240
const MAX_BOARD = 512
const BOARD_MARGIN = 32

/**
 * 依据窗口宽度算出棋盘尺寸。
 * 返回的 boardSize 一定是 cellSize 的 8 倍，避免最后一列/行被裁掉。
 */
function boardMetrics(width) {
  const w = typeof width === 'number' && width > 0 ? width : 375
  const raw = Math.max(MIN_BOARD, Math.min(MAX_BOARD, Math.floor(w - BOARD_MARGIN)))
  const cellSize = Math.max(1, Math.floor(raw / 8))
  return { boardSize: cellSize * 8, cellSize: cellSize }
}

/**
 * 生成 64 个棋格的视图数据（按显示顺序：从上到下、从左到右）。
 *
 * @param {object} state
 * @param {Array}  state.board        8×8 棋盘，元素为 { type, color } 或 null
 * @param {boolean} state.flipped     true 表示黑方在下方
 * @param {string} [state.selected]   当前选中格
 * @param {Array}  [state.legalTargets] 合法落点
 * @param {object} [state.lastMove]   { from, to }
 * @param {object} [state.hint]       预览路线 { from, to }
 * @param {string} [state.checkSquare] 被将军的王所在格
 * @param {string} [state.hiddenSquare] 拖拽起点（棋子由浮层显示，格内不画）
 * @returns {Array<{sq:string, cls:string, glyph:string, color:string, mark:string}>}
 */
function buildCells(state) {
  const s = state || {}
  const board = s.board
  const flipped = !!s.flipped

  const targets = {}
  const legalTargets = s.legalTargets || []
  for (let i = 0; i < legalTargets.length; i++) targets[legalTargets[i]] = true

  const marks = {}
  if (s.lastMove) {
    marks[s.lastMove.from] = 'last'
    marks[s.lastMove.to] = 'last'
  }
  if (s.hint) {
    marks[s.hint.from] = 'hint'
    marks[s.hint.to] = 'hint'
  }

  const cells = []
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const square = geometry.cellToSquare(col, row, flipped)
      const file = square.charCodeAt(0) - 97
      const rank = Number(square.charAt(1)) - 1 // 0 表示第 1 横线
      // chess.js 的 board() 第 0 行是第 8 横线，行号与 rank 相反，必须换算
      const boardRow = board ? board[7 - rank] : null
      const piece = boardRow ? boardRow[file] : null

      const cls = [geometry.isLightSquare(col, row) ? 'light' : 'dark']
      if (s.selected === square) cls.push('sel')
      if (marks[square]) cls.push(marks[square])
      if (s.checkSquare === square) cls.push('check')

      let mark = ''
      if (targets[square]) mark = piece ? 'ring' : 'dot'

      const hidden = s.hiddenSquare === square
      cells.push({
        sq: square,
        cls: cls.join(' '),
        glyph: piece && !hidden ? GLYPHS[piece.type] || '' : '',
        color: piece ? piece.color : '',
        mark: mark,
        // 坐标只标注在棋盘边缘：左列标行号，底行标列号
        ct: col === 0 ? String(rank + 1) : '',
        cb: row === 7 ? geometry.FILES[file] : ''
      })
    }
  }
  return cells
}

module.exports = { GLYPHS, buildCells, boardMetrics, MIN_BOARD, MAX_BOARD }
