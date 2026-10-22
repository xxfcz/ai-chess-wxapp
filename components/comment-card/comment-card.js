/**
 * components/comment-card/comment-card.js
 * L1 共享组件：云端 AI 教练点评（流式正文 / 富文本片段 / 走法演示 / 复制）。
 *
 * 负责渲染与把交互透传成语义事件；真实的大模型点评逻辑（coach-service）
 * 与演示会话（coach-demo）仍由页面持有。
 */
Component({
  properties: {
    /** 环境是否有网络请求能力（决定「生成点评」按钮是否禁用） */
    cloudReady: { type: Boolean, value: true },
    /** 是否正在生成点评 */
    commenting: { type: Boolean, value: false },
    /** 生成中的等待说明（带模型名与已等待秒数） */
    commentingHint: { type: String, value: '' },
    /** 流式/纯文本点评正文（已剔除结构化块） */
    coachText: { type: String, value: '' },
    /** 点评失败文案 */
    coachError: { type: String, value: '' },
    /** 网络不可用时给的提示 */
    cloudHint: { type: String, value: '' },
    /** 本次点评实际使用的云端模型名 */
    coachModel: { type: String, value: '' },
    /** 富文本片段（走法/格子/棋子可点） */
    coachSegments: { type: Array, value: [] },
    /** 演示线列表 */
    demoLines: { type: Array, value: [] },
    /** 是否处于演示态 */
    demoActive: { type: Boolean, value: false },
    /** 演示面包屑（当前走到了哪一步） */
    demoBreadcrumb: { type: String, value: '' },
    /** 演示是否正在播放 */
    demoPlaying: { type: Boolean, value: false },
    /** 演示能否上一步 */
    demoCanBack: { type: Boolean, value: false },
    /** 演示能否下一步 */
    demoCanForward: { type: Boolean, value: false },
    /** 点评失败的排查线索（仅调试面板开启时展示） */
    coachDetail: { type: String, value: '' },
    /** 调试面板是否开启 */
    debugEnabled: { type: Boolean, value: false }
  },

  methods: {
    /** 生成 / 取消生成 */
    onCoach() {
      this.triggerEvent('coach')
    },

    /** 复制点评 */
    onCopyCoach() {
      this.triggerEvent('copy')
    },

    /** 长按整段点评正文 */
    onCoachLongPress() {
      this.triggerEvent('coachlongpress')
    },

    /** 点击点评 / 分支描述里的记号（走法 / 格子 / 棋子） */
    onCoachTokenTap(e) {
      const d = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {}
      this.triggerEvent('coachtokentap', d)
    },

    /** 点击分支标签：进入该线演示 */
    onEnterDemo(e) {
      const d = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {}
      this.triggerEvent('demoenter', d)
    },

    /** 演示内上一步 / 下一步 */
    onDemoStep(e) {
      const d = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {}
      this.triggerEvent('demostep', d)
    },

    /** 演示播放 / 暂停 */
    onDemoPlay() {
      this.triggerEvent('demoplay')
    },

    /** 退出演示 */
    onDemoExit() {
      this.triggerEvent('demoexit')
    },

    /** 长按某条分支走法：弹出复制菜单 */
    onLineLongPress(e) {
      const d = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset : {}
      this.triggerEvent('linelongpress', d)
    }
  }
})
