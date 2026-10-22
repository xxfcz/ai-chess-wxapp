/**
 * components/board-view/board-view.js
 * L1 共享 UI 组件：棋盘（8×8 视图网格 + 评估条 + 拖拽浮层）。
 *
 * 纯展示 + 原始事件透传：不持有棋局状态，只渲染 `cells` 并向上抛出语义事件。
 * 拖拽/点选的「落点反推」判定仍由页面（持有 game）完成，组件只把 (sq, x, y) 透传出去，
 * 这样不同模式（对弈/分析/打谱）可各自决定如何处理走子，组件本身保持无逻辑复用。
 *
 * 事件：
 *   celltap         { sq }
 *   celltouchstart  { sq, x, y }
 *   celltouchmove   { x, y }
 *   celltouchend    { x, y }
 */
Component({
  properties: {
    /** 64 个棋格视图数据（由 board-model.buildCells 产出） */
    cells: { type: Array, value: [] },
    boardSize: { type: Number, value: 336 },
    cellSize: { type: Number, value: 42 },
    pieceFont: { type: Number, value: 38 },
    labelFont: { type: Number, value: 9 },
    /** 拖拽浮层（drag.moved 时由页面算好坐标传下来） */
    ghost: { type: Object, value: null },
    /** 评估条占比 0~100（同色填充从底部升起，白优升高） */
    evalPercent: { type: Number, value: 50 }
  },

  methods: {
    tapCell(e) {
      const sq = e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.sq : ''
      this.triggerEvent('celltap', { sq: sq })
    },

    startCell(e) {
      const sq = e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.sq : ''
      const t = e.touches && e.touches[0] ? e.touches[0] : null
      this.triggerEvent('celltouchstart', {
        sq: sq,
        x: t ? t.clientX : 0,
        y: t ? t.clientY : 0
      })
    },

    moveCell(e) {
      const t = e.touches && e.touches[0] ? e.touches[0] : null
      this.triggerEvent('celltouchmove', {
        x: t ? t.clientX : 0,
        y: t ? t.clientY : 0
      })
    },

    endCell(e) {
      const t = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : null
      this.triggerEvent('celltouchend', {
        x: t ? t.clientX : 0,
        y: t ? t.clientY : 0
      })
    }
  }
})
