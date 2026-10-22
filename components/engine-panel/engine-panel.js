/**
 * components/engine-panel/engine-panel.js
 * L1 共享组件：引擎分析面板（深度选择 + 「PV走法」 + 三条最佳路线 + 降级提示）。
 *
 * 只负责渲染与把交互透传成语义事件（depthchange / analyze / linepreview），
 * 真实的引擎调用与评分（analysis-service）仍由页面持有。
 */
Component({
  properties: {
    /** 引擎来源徽标文案（远端时带引擎版本） */
    engineLabel: { type: String, value: '' },
    /** 引擎来源：'remote' 云端 / 'local' 端上（决定徽标配色） */
    engineSource: { type: String, value: '' },
    /** 是否正在分析（控制按钮文案与禁用态） */
    analyzing: { type: Boolean, value: false },
    /** 深度选项数组，如 [2,3,4] */
    depthOptions: { type: Array, value: [] },
    /** 当前选中的深度下标 */
    depthIndex: { type: Number, value: 0 },
    /** 三条路线的展示数据 */
    analysisLines: { type: Array, value: [] },
    /** 分析失败文案；非空时优先于路线展示 */
    analysisError: { type: String, value: '' },
    /** 降级提示（云端不可用已回落本地时非空） */
    engineNotice: { type: String, value: '' }
  },

  methods: {
    /** 深度选择器变化：把 picker 的 value（下标）透传 */
    onDepthChange(e) {
      const value = e && e.detail ? e.detail.value : undefined
      this.triggerEvent('depthchange', { value: value })
    },

    /** 「PV走法」按钮：请求立即分析 */
    onAnalyze() {
      this.triggerEvent('analyze')
    },

    /** 点击某条路线：把下标透传，由页面在棋盘上预览 */
    onPreviewLine(e) {
      const index = e && e.currentTarget && e.currentTarget.dataset
        ? e.currentTarget.dataset.index : undefined
      this.triggerEvent('linepreview', { index: index })
    }
  }
})
