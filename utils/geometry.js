/**
 * geometry.js
 * 棋格名 ⇄ 显示坐标换算。
 * 全部是纯函数，不依赖 DOM / Canvas / wx，可在逻辑层单独测试。
 *
 * 约定：
 *   - col（列）0..7 → 从左到右
 *   - row（行）0..7 → 从上到下
 *   - flipped = true 表示黑方在下方（棋盘上下翻转）
 */

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

function isSquare(square) {
  return typeof square === 'string' &&
    square.length === 2 &&
    square.charCodeAt(0) >= 97 && square.charCodeAt(0) <= 104 &&
    square.charCodeAt(1) >= 49 && square.charCodeAt(1) <= 56
}

/** 'e4' → { col, row } */
function squareToCell(square, flipped) {
  const file = square.charCodeAt(0) - 97 // a=0
  const rank = square.charCodeAt(1) - 49 // '1'=0
  return {
    col: flipped ? 7 - file : file,
    row: flipped ? rank : 7 - rank
  }
}

/** { col, row } → 'e4' */
function cellToSquare(col, row, flipped) {
  const file = flipped ? 7 - col : col
  const rank = flipped ? row : 7 - row
  return FILES[file] + (rank + 1)
}

/** 该显示格是否为浅色格（起点 a8 为浅色，与真实棋盘一致） */
function isLightSquare(col, row) {
  return (col + row) % 2 === 0
}

module.exports = {
  FILES,
  isSquare,
  squareToCell,
  cellToSquare,
  isLightSquare
}
