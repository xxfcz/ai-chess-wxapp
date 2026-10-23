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
- **真机/预览硬阻塞（2026-10-22 更正）**：`403 移动 UA` 只对 **CloudStudio 预览域名**成立，**不要套到 `chess.imex.de5.net`**——当天用完整 iPhone/Android MicroMessenger UA 实测 `GET /healthz` 与 `POST /v1` 均 **200**（Caddy 反代，Stockfish 15.1，pool 8）。真阻塞只有一处：**WorkBuddy 预览面板**的 `wx.request` 是本地 shim（`resources/extensions/workbuddy-baas-v2/server/index.cjs`），**只校验 pathname、丢弃 host**（`target=pathname+search` 后相对 `fetch` 到预览页 origin）→ 只放行 `/.cloud/*`，任何外部引擎域名（`chess.imex.de5.net` / `ai-chess-server.app.workbuddy.host`）一律 `path not allowed`；**在自己服务器加 `/.cloud` 别名也无效**（host 被丢）。代码侧归类永久屏蔽，**2026-10-23 起按根因拆两个码**：`path not allowed` → `PREVIEW_SANDBOX`（宿主设计行为，真机/体验版不受影响），403+HTML/未配白名单 → `GATEWAY_BLOCK`（配置问题）；`state().blockedKind` 暴露根因，界面/日志/toast 分三套文案（预览那句明说「不是引擎故障」）。另：`ai-chess-server.app.workbuddy.host` 桌面 UA 正常（`/v1` 200）、移动 MicroMessenger UA `POST /v1` 仍 403 + HTML「请在浏览器中打开」→ **只能当浏览器/CI/curl 调试后端，不能用于小程序**。
- **四环境通路矩阵（2026-10-22 结论）**：无单通道能覆盖四个环境，LLM 通道与引擎通道的可用集合近乎互补。
  - 开发者工具「模拟器」「真机调试」：`urlCheck:false` / 调试态免校验 → 引擎与 LLM **都通**（真机调试仍需有效 HTTPS 证书）。
  - 开发者工具「**预览**扫码」：**不校验开关不生效**，必须靠域名白名单。**2026-10-23 已切自有正式 AppID `wxd3f1d012e71052a9`**，且 `chess.imex.de5.net` + `mp-api.app.workbuddy.host` 两个域名已备案并配进 request 合法域名 → 预览/体验/正式均可通。旧测试号 `wxe91834e9c2546603` 时代「不能配服务器域名/云开发 → 双断」的结论已作废。
  - WorkBuddy 预览面板：LLM 通（有分块降级适配器）、引擎断（沙箱路径白名单）。
  - WorkBuddy 真机试用：LLM 通（受管 AppID 白名单已含 mp-api）；引擎按文档 10-16 记录为通，待复验。
  - **2026-10-22 23:45 实测更正（正式号 + 新应用后）**：开发者工具**真机都断**、WorkBuddy **预览都断**、
    体验版真机 **引擎通 / 点评断**。点评断的根因是**凭据被吊销**（非域名、非环境），已换新 key；
    引擎只在「预览面板」被沙箱路径白名单挡住，体验版真机是通的。判断环境限制前先分清**凭据 / 域名白名单 / 沙箱路径**三类。
- **WorkBuddy 发布有两种方式（官方，2026-10-23 核实）**：①「创建试用版小程序」= 平台试用号（14 天 / 15 人 / **不能转正式**，引擎 ❌）；②「绑定已有小程序账号」= 管理员扫码授权、发到**你自己的 AppID**（体验版+正式版都能发，绑一次即可，体验/正式共用）。WorkBuddy 只是**上传/提审通道**，**能力看 AppID、不看谁发布**。`.wbapp_*.genie#appId` 是平台应用 id，**不是微信 AppID**，永不进 `project.config.json`（历史踩坑：填错 → 真机调试 `-50005`）。同一 AppID 下体验版**只有一个槽位**，开发者工具与 WorkBuddy 两条发布链会互相覆盖。
- **禁止**：不要为了这个去照搬「微信云开发 dev/prod 双环境 + 前端只调 `wx.cloud.callFunction`」通稿——`wx.cloud` 绑你自己的 AppID，WorkBuddy 受管 AppID 里调不通、预览面板也没有 `wx.cloud`；`wx.cloud.callFunction` 确实**免域名白名单**且云函数**出网不受限**，这是「自己 AppID 那半边」的正解，只覆盖微信侧。
- 选型结论存档（不再展开）：倾向自建 VPS（非云托管）；香港机 `112.121.168.204` 不能备案→需大陆备案域名；Stockfish 仅服务端运行，二进制/wasm 不进小程序包（GPL 不传染）。`远端引擎接入方案-chess-api.md` 的 D14「WS 为主」已不适用。
- **`ENGINE_ENDPOINT_DEV` 已停用（2026-10-22）**：原 `http://112.121.168.204:8787` TCP 能连但服务端零响应（开发者工具 `net::ERR_EMPTY_RESPONSE`，与 Chrome 同源）；明文 HTTP + 裸 IP 是最脆一段。现 `.env` 里注释掉，develop 与 release 同走 https 域名（同机同进程，证书有效期至 2027-01-14，`/v1` 实测 200）。**不要在链路上给 develop 分叉**。
- **引擎诊断工具**：`utils/engine-probe.js#probe()` + Landing 调试面板「开始探测」。只读探 `GET /healthz` + `POST /v1`，逐行给状态码/耗时/宿主 errMsg，并按 `path not allowed`（沙箱路径）/`not in domain list`（域名白名单）/403/超时分类。四宿主失败原因完全不同，**先探测再猜**。
- **403 判定已收紧**：`isEnvironmentBlock` 只把「403 + 非 JSON（网关 HTML 页）」当环境屏蔽；`403 + JSON`（服务端风控/限流）走普通回落+熔断，不再把一个会话永久钉在本地引擎上。

## 云服务接入惯例（LLM 点评）
- 当前应用 = **`wbapp_a2yIza6bMcvSBfKcMQI3CP`**（黑白格大师，同时是发布载体），`resourceId=wbcs_NQXWYxRVa9K2OgVm7y6AiH`；旧 `wbapp_WqKyrxADH6O75kZ4NkuiMj` 已删除，勿再引用。
- 凭证只在 `utils/cloud-config.js#publicConfig`（`endpoint`+`publishableKey`，随前端发布）。
- **删应用 = 吊销该应用全部 publishableKey**（2026-10-22 实测：删「黑白格大师」后 `401 invalid_client`，
  点评在**所有**环境同时失效，表象却只是「网络连接失败」）。故前缀必须等于当前 appId，`wbpk_<appId>_…`。
- **凭据死活一条 curl 判定**（不用等真机）：`GET {endpoint}/.cloud/llm/models` + 头 `x-wb-webapp-access-key: <publishableKey>`，
  200=活 / `401 invalid_client`=吊销。LLM 真实调用 = `POST /.cloud/llm/chat/completions`（stream 必须 true）。
- 四步闭环：开通(reuse appId)→改凭证→隐私清单→真实探针（探针用完即删）。隐私清单最小声明（仅 `Clipboard`）。「测试全绿≠云可用」。
- 修改凭证后**必须重新上传体验版/正式版**才生效（已发布的包还是旧 key）。

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
- 页面层：`analyze-page 237` / `play-page 78` / `replay-page 125`（L2-T7 新增）/ `landing 59` / `navigation 35` / `session 46`
- 解析层：`pgn-tree 55`（L2-T7 新增）
- 服务层：`engine-and-game 153` / `cloud-adapter 68` / `remote-engine 85` / `analysis-service 35` / `coach-service 15` / `agent-tools 48` / `comment-model 31` / `engine-config 30` / `coach-demo`（独立脚本）
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
