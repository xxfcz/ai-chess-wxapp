/**
 * components/session-bar/session-bar.js
 * L1 共享 UI 组件：单行状态条 + 历史控制按钮。
 *
 * 纯展示 + 语义事件：自身不持有棋局，只渲染状态并把「后退/前进/重置/翻转」透传为事件，
 * 由页面（持有 game）决定如何执行。对弈/分析/打谱/练习四种模式共用同一份。
 *
 * 事件：undo / redo / reset / flip
 */
Component({
  properties: {
    statusLabel: { type: String, value: '' },
    statusTone: { type: String, value: 'even' },
    turnClass: { type: String, value: 'w' },
    flipped: { type: Boolean, value: false },
    evalLabel: { type: String, value: '' },
    terminalLabel: { type: String, value: '' },
    canUndo: { type: Boolean, value: false },
    canRedo: { type: Boolean, value: false }
  },

  methods: {
    onTap(e) {
      const act = e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.act : ''
      if (act) this.triggerEvent(act, {})
    }
  }
})
