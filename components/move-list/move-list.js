/**
 * components/move-list/move-list.js
 * L1 共享组件：走子记录（SAN 走法列表，纯展示）。
 *
 * 不持有任何交互：落子与历史由页面持有，这里只把 moveRows 渲染成表格。
 */
Component({
  properties: {
    /** 走法行：[{ no, key, white, black }] */
    moveRows: { type: Array, value: [] },
    /** 总手数（用于标题展示） */
    moveCount: { type: Number, value: 0 }
  }
})
