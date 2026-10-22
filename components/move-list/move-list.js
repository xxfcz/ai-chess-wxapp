/**
 * components/move-list/move-list.js
 * L1 共享组件：走子记录（SAN 走法列表）。
 *
 * 默认纯展示（对弈/分析页只看不改）；打谱模式下传 interactive=true，
 * 每一步变成可点定位的入口——点某一手就跳到对应节点（事件 movetap，payload { node }）。
 * 节点 id 由页面写进 rows 的 whiteKey/blackKey，组件本身不持有棋局。
 */
Component({
  properties: {
    /** 走法行：[{ no, key, white, black, whiteKey?, blackKey?, whiteActive?, blackActive? }] */
    moveRows: { type: Array, value: [] },
    /** 总手数（用于标题展示） */
    moveCount: { type: Number, value: 0 },
    /** 是否允许点击某一步定位（打谱模式开启） */
    interactive: { type: Boolean, value: false }
  },

  methods: {
    onMoveTap(e) {
      if (!this.data.interactive) return
      const node = e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.node : ''
      if (!node) return
      this.triggerEvent('movetap', { node: node })
    }
  }
})
