# 项目长期约定（ai-chess-wxapp）

## 角色命名（2026-10-07 拍板）
- 教练=Tutor(`tutor`)、陪练=Sparrer(`sparrer`，双写 r)。**不用 `opponent`/`rival`**（会让产品往"赢你"优化）。
- 既有 `coach` 标识符不重命名（`coach-demo.js`、`onCoach`、`coachText`、`requestCoachComment()` 等，改键名牵动 WXML）。新增代码用 `tutor`/`sparrer`，既有的不动。
- 阶段三代号 `Persistent Tutoring Memory`。

## 文档与数据格式
- **UTF-8 无 BOM**（.md 及代码/配置）。校验/去 BOM：`open(p,'rb').read()[:3]!=codecs.BOM_UTF8`；去 BOM `open(p,'w',encoding='utf-8').write(open(p,encoding='utf-8-sig').read())`。
- 内部一律 **FEN + UCI**（演示线/分支树/错题索引）；PGN 只在进出边界各转一次（导入 `load_pgn` / 导出 `pgn()`，经 `this._chess` 或新增转发）。不用 PGN 作 LLM 输出格式。

## 能力开关（2026-10-10 定稿）
- 三**独立**开关：`engine: local|remote`、`cloud: off|on`、`llm: off|light|heavy`。每个功能点按自己依赖哪个渲染。
- 措辞铁律：说「本地有一个弱引擎」非「没有引擎」；规则=事实、引擎=意见，界面分层。`remote` 非 `cloud`（后者被微信原生云占用）。
- 三条铁律：① 离线不是残废模式，界面不许空；② 调 LLM 的开关是「出现值得讲的信号」非「走了一步」；③ 降级必须显形。
- `cloud:on` 买**连续性**（跨设备存档/题库/画像），非能力。

## 端上保底通道（AGENTS.md §8）
四条不依赖网络：规则判定/走法生成/演示线/本地评分，必须任何环境可用。`utils/engine.js` 是**冻结基线**（维护≈0，`engine:remote` 接通后让位），不要再投入。

## 远程引擎 engine: remote（2026-10-15 落地）
- 端点 `https://chess.imex.de5.net`（自有域名，Stockfish 15.1，进程池 8）。调用收口 `ai-client.js#analyzePosition`（默认 remote）。
- 端点解析 `utils/engine-config.js`（`override>storage>.env注入>默认`），生成 `utils/engine-config.build.js` **必须提交**，`.env` 进 gitignore。改地址：改 `.env`→`npm run config:engine`→生成→重编译。
- 协议权威：`E:\WorkBuddy\ai-chess-server\docs\05-小程序接入协议.md`。判错看 `body.type==='error'`；只用 `lines[].scoreCp/scoreMate`（行棋方视角）。
- 行为：终局/非法FEN 本地前置拦截；失败/超时回落本地带 `degradedFrom`（不静默）；连续 2 次失败熔断 60s；400 类不回落直接抛。
- 换域名只改 `remote-engine.js#DEFAULT_ENDPOINT`，**不要写进 `cloud-config.js`**（那是 LLM 凭据位）。
- **真机/预览硬阻塞**：`app.workbuddy.host` 是 CloudStudio 预览域名——H5 预览 `path not allowed`、真机 403 移动 UA；要让 remote 真机可用必须**自有 ICP 备案域名** + mp 后台配 request 合法域名。代码侧归类为永久屏蔽 `GATEWAY_BLOCK`，界面显形提示。
- 选型结论存档（不再展开）：倾向自建 VPS（非云托管）；香港机 `112.121.168.204` 不能备案→需大陆备案域名；Stockfish 仅服务端运行，二进制/wasm 不进小程序包（GPL 不传染）。`远端引擎接入方案-chess-api.md` 的 D14「WS 为主」已不适用。

## 云服务接入惯例（LLM 点评）
- 凭证只在 `utils/cloud-config.js#publicConfig`（`endpoint`+`publishableKey`，随前端发布）。
- 隐蔽回归点：每次重建/重发后 `publishableKey` 前缀不会自动更新，必须人工核对前缀==当前 applicationId。
- 四步闭环：开通(reuse appId)→改凭证→隐私清单→真实探针（探针用完即删）。隐私清单最小声明（仅 `Clipboard`）。「测试全绿≠云可用」。

## 交互设计三条硬结论
- 不做聊天窗口（挤占棋盘+与 Tab 内不各自滚动冲突），用同 Tab 对话卡片流。
- Tutor 必须能「指」棋盘（move/sq/piece 记号 + focus 高亮）。
- 不新增底部 Tab（5 个上限）；消息数 ≤3 轮。

## 规划文档
- `docs/agent-plan.md`（总纲：术语表/命名对照/冻结契约/决策 D1~D18）+ `agent-phase1/2/3` + `agent-tutor-interactions.md`（改 Tutor 界面/文案先读）。
- `docs/平台化产品重构方案.md`（2026-10-21：L0/L1/L2 分层 + §9 界面简化 + §11 澄清）。
- `docs/平台化重构进度看板.md`（2026-10-22 建：**独立进度看板 + L2 Landing/多模式页任务分解**，跨会话续做总览）。
- `docs/云服务接入经验总结.md` / `docs/自建引擎服务部署方案.md`。

## 平台化重构（架构与进度）
- 三层：L0 纯功能平台层（棋局会话，已完成）/ L1 共享 UI 组件（已完成）/ L2 模式配置层（Landing + 多模式页，**Landing/analyze/play/replay 已完成（2026-10-22），剩设置页与练习（deferred）**）。
  - Landing 首页 + analyze 已完成（2026-10-22）：`pages/landing`(四卡片+设置+调试)、`pages/placeholder`(过渡)、`pages/analyze`。
  - 全局 store `utils/session-store.js`（单例，持有 Game 实例 + 最近分析 + pendingParams）：analyze 退/进不丢局面与分析。
  - 剪贴板自动导入下沉 `utils/clipboard-import.js`：Landing 与分析页共用，确认后跳 analyze 带 fen。
  - **对弈页已完成（L2-T6，2026-10-22）**：`pages/play`（玩家 vs `sparrer`），复用 L1 组件 + L0 服务，无重复实现。新增 L0：`utils/settings.js`（偏好：autoCoach/playCoachScope/playKeyCp/playAs/sparrerLevel，wx storage 静默降级 + `_setBackend/_reset` 测试钩子）、`utils/coach-runner.js`（点评编排：buildToolContext→requestCoachComment→groundDemoLines→parseDemo→tokenizeText，回调式、AbortSignal 取消静默）。
  - 打谱页（L2-T7）已完成（2026-10-22，见下「打谱模式」）；练习（P4）仍 deferred（依赖外部题库）；设置页（P5）待做。任务分解与 DoD 见 `docs/平台化重构进度看板.md` §2。
- **结构：单包（2026-10-22 晚由分包改回）**。`pkg-analyze|play|replay` 三个目录已移入 `pages/analyze|play|replay`，`app.json` 不再有 `subPackages`。原因：内置预览不支持页面跳转（四种 url 形式全失败，真机一直正常）。加模块 = `pages/` 下加页面 + Landing 注册卡片。**不要再加回分包**；主包约 1.06MB / 上限 2MB。
- MVP：analyze 页平台化 + 简化界面（5→3 Tab；脚注/运行日志Tab/技术细节移调试；优势文字→评估条；FEN/PGN 导入移 Landing）。
- Tutor/Sparrer 上升为横切 `coach-service`，被所有模式消费；阶段三 Persistent Tutoring Memory 仍是跨模式画像/错题。

## L1 共享 UI 组件层（2026-10-22 完成）
5 个真实组件（`components/` 下，由 `pages/analyze/analyze.json#usingComponents` 声明）：
`board-view` / `session-bar` / `engine-panel` / `comment-card` / `move-list`。
- 共享原子类进 `app.wxss` 全局（`.card/.row/.gap/.btn` 及变体/`.chip`/`.head`/`.muted`/`.tiny`/`.error`/`.tech-detail`/`.tone-*`）；组件自带专属样式（`.cell/.line/.seg-move/.status-card/.demo-*` 等）。
- 组件统一 `styleIsolation:"apply-shared"`（默认 isolated 会阻断全局类）。
- `session-bar` 根节点必须是 `class="card status-card"`（`status-card` 只给 margin，卡片外观由 `.card` 提供）。
- 页面 handler 双读 `e.detail` + 旧 `currentTarget.dataset` 形（测试直接调页面方法，无需重写测试）。
- WXML 静态守卫（`analyze-page.test.js §11`）扫描所有 wxml（页面+5组件），先剔除 `<!-- -->` 注释防误伤。

## 页面导航（2026-10-22）
- 一律走 `utils/navigation.js#navigate(url,{host,onFail,onSuccess})`，**不要直接调 `wx.navigateTo`**：内置预览对任何 url 形式都报「未找到页面」（连主包页也失败），故已改单包。候选形式自适应 + 全失败显形；`onSuccess` 报告「第几种形式成功」（Landing 写进运行日志，是判断宿主差异的唯一证据）。
- 新增页面若读 `options.xxx`，`onLoad` 首行必须 `options = navigation.mergeLaunchOptions(options)`（参数可能经 store 送达）。
- Landing 底部「调试」面板（默认收起）：运行日志（复用 `utils/debug-log.js`）+ 10 项宿主接口能力探测。**预览没有剪贴板**，复制按钮必须显形提示「长按选中」，错误正文/日志都带 `user-select`。

## 回归测试门禁
`.workbuddy/tests/` 零依赖（`_harness.js`）。managed node：`C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`
- 页面层：`analyze-page 237` / `play-page 78` / `replay-page 125`（L2-T7 新增）/ `landing 46` / `navigation 35` / `session 46`
- 解析层：`pgn-tree 55`（L2-T7 新增）
- 服务层：`engine-and-game 153` / `cloud-adapter 68` / `remote-engine 82` / `analysis-service 35` / `coach-service 15` / `agent-tools 48` / `comment-model 31` / `engine-config 30` / `coach-demo`（独立脚本）
- 页面测试开头 `ai.setEngineMode('local')`；等待一律 `waitFor()` 轮询（超时 15s），不写死 `sleep`。引擎回着/收尾分析要等 `myTurn===true`（而非仅 moveCount），否则会读到 `engineThinking` 未复位的中间态。
- WXML 静态守卫扫 `pages/` + `components/`（单包后已无分包 root；代码保留 `subPackages` 兼容分支，改名不会静默漏扫）。

## 打谱模式（pages/replay）设计要点（2026-10-22，L2-T7）
- **PGN 不要走 chess.js 的 `load_pgn`**：0.10.3 会删掉圆括号变例（只留主线）。打谱用 `utils/pgn-tree.js#parsePgn` 自解析 → `Session.loadPgnTree(pgn)` 灌树（内部仍是 FEN+UCI，PGN 仅边界一次）。`Session.loadPgn` 保留原语义给老调用方。
- 树语义：变例 `(3... Nf6)` 是「被替换那一步」的兄弟；落地先主线占 `children[0]`，再 `forkFrom` 变例，`children[0]` 恒为主线。
- 棋盘**只读**（不在别人的棋谱上落子）；导航=后退/前进/重置(回起点)/跳到末尾；走法记录每手可点（`move-list` 的 `interactive`，默认 false）。
- 每步引擎标注走**节点级缓存**：页面 `_cache` + `Session.cacheAnalysis`，用 `_cacheDepth` 记请求深度，只有「深度未知(跨页面恢复)」或「深度一致」才复用——否则改深度会拿旧结果冒充。
- 点评**手动触发**（不逐 step 调 LLM）；切步清点评与演示（点评属于上一个局面）；演示跑在 DemoSession 临时副本上，退出不改棋谱位置。
- `session-store` 新增 `_session/_sessionMeta`：Game（线性）与 Session（树）并存，按 mode 取用。

## 对弈模式（pages/play）设计要点（2026-10-22，L2-T6）
- 走子护栏 `_canPlayerMove()`：仅玩家自己行棋方（`playAs`）且轮到玩家、且 AI 不在思考/不在演示时才能落子；`pressSquare` 拒绝选中对方棋子（杜绝自由模拟，与 analyze 的自由模拟语义相反）。
- 引擎回着 `engineMove()`：玩家落子→自动分析→轮到 sparrer 时取最佳走法应着；**任何失败都复位思考态**（本地引擎是冻结基线不会失败，真实环境不进此态）。
- 点评门控 `maybeAutoCoach()`：`autoCoach=off` 从不自动；`on/remoteOnly` 受 `cloudReady` 约束；`playCoachScope=keySteps` 时关键步 = |Δcp|≥`playKeyCp`(默认80) 或吃子/将军/送将（纯引擎确定性判定，不走 LLM）。
- 黑方玩家：按规则白先走，故初始 `myTurn=false`，由 sparrer（白）经 `scheduleAnalyze('kickoff')→afterAnalyze→engineMove` 先走。
- `undo` 连退两步（玩家+sparrer），把行棋权交回玩家。

## 第二轮澄清决策（2026-10-21，方案 §11）
- 服务职责：`engine-service` + `analysis-service`（折叠在 `ai-client.js` 的 `formatScore/buildLineView/evalPercent`）+ `coach-service`。重构即把 analysis/coach **物理拆离** `ai-client.js`。
- `degraded` 语义：`source` 仅 `remote`/`local`；`degraded` 是 `local` 上的标记(`degradedFrom`)，与「用户主动选 local」区分。
- `autoCoach` 设置项(`off/on/remoteOnly`)；`llm-provider` 抽象(`platform`/`openai-compatible`)，前端存 key 会被提取→建议走自有代理（`chess.imex.de5.net/llm`）。
- **剪贴板自动读 FEN/PGN**（纳入 MVP）：`onShow` 调 `wx.getClipboardData()`（仅文本），匹配合法 FEN/PGN 则 `wx.showModal` 询问导入。图片识别改后续阶段（`wx.chooseMedia`+后端 `/recognize`）。
- 内容易迷失：交互研究 backlog（渐进展示/面包屑/聚焦讲解/分支树局部展开），不定稿。
- **deferred**：继续上次棋谱（依赖阶段三 cloud）、练习题库（依赖外部数据）。
