# 项目长期约定（ai-chess-wxapp）

> 精简版（2026-10-23 整理，原 18KB 压缩）。历史细节见 `docs/` 与每日日志。

## 角色与术语
- 教练 = Tutor(`tutor`)、陪练 = Sparrer(`sparrer`)。**不用 `opponent`/`rival`**。
- 既有 `coach` 标识符不重命名（`coach-demo.js`/`onCoach`/`coachText`/`requestCoachComment()` 牵动 WXML）；新增代码用 tutor/sparrer。
- 阶段三代号 `Persistent Tutoring Memory`（跨模式画像/错题）。

## 格式约定
- **UTF-8 无 BOM**（.md 与代码/配置）。
- 内部一律 **FEN + UCI**，PGN 只在进出边界转一次，不做 LLM 输出格式。
- **PGN 解析禁止用 chess.js `load_pgn`**（0.10.3 会丢圆括号变例）→ `utils/pgn-tree.js#parsePgn`。

## 能力开关与降级
- 三**独立**开关：`engine: local|remote`、`cloud: off|on`、`llm: off|light|heavy`。
- 措辞：说「本地有一个弱引擎」；`remote` 非 `cloud`（后者被微信原生云占用）。
- 三铁律：① 离线不残废，界面不许空；② LLM 由「值得讲的信号」触发，非每步；③ **降级必须显形**（`degradedFrom`）。
- `cloud:on` 买**连续性**（跨设备存档/题库/画像），非能力。

## 架构分层与进度
- **L0 纯功能层**：`game/board-model/engine/remote-engine/ai-client` + `analysis-service`、`coach-service`、`comment-model`（点评可点走法协议层）、`settings`、`coach-runner`（点评编排）、`session-store`（单例：Game + Session 树 + pendingParams）、`clipboard-import`、`navigation`、`engine-probe` 等。
- **L1 共享组件**（`components/`，5 个）：`board-view` / `session-bar` / `engine-panel` / `comment-card` / `move-list`。统一 `styleIsolation:"apply-shared"`；共享原子类在 `app.wxss`（`.card/.row/.gap/.btn/.chip/.head/.muted/.tiny/.error/.tech-detail/.tone-*`）。
- **L2 页面**：`landing`（四卡片+设置+调试面板）、`placeholder`、`analyze`、`play`、`replay` **已完成（2026-10-22）**；设置页（P5）、练习（P4，依赖外部题库）deferred。任务分解见 `docs/平台化重构进度看板.md` §2。
- **单包结构**（2026-10-22 晚由分包改回，`pkg-*` 已迁入 `pages/`）：内置预览不支持页面跳转（四种 url 形式全失败，真机正常）。加模块 = `pages/` 加页面 + Landing 注册卡片。**不要再加回分包**；主包约 1.06MB / 上限 2MB。
- 页面 handler 双读 `e.detail` + 旧 `currentTarget.dataset`；新增页面 `onLoad` 首行 `options = navigation.mergeLaunchOptions(options)`。

## 渲染/样式硬约束（踩过的坑）
- 棋盘**不用 Canvas**（预览无 `wx.createSelectorQuery`），8×8 view 网格 + 字形；拖拽位移换算不查真实坐标。
- `board-model` 的 `board` 第 0 行是第 8 横线 → 取子必须 `board[7 - rank]`。
- **组件类名必须带组件前缀**（`.cc-seg`、`.board-grid`）：`apply-shared` 下页面 wxss 会漏进组件。
  2026-10-23 回归：`comment-card` 的点评片段用裸 `.seg`，被 `pages/play.wxss` 的分段控件（`display:flex` + 底色 + 边框）命中 → 每段文字/走法各占一行。守卫见 `analyze-page.test.js` §11.1（组件类名不得与页面 wxss 重名，`app.wxss` 全局原子类除外）。
- `session-bar` 根节点必须 `class="card status-card"`；WXML 静态守卫扫 `pages/` + `components/`（先剔注释）。

## 引擎 engine: remote
- 端点 `https://chess.imex.de5.net`（自有域名，香港机，Stockfish 15.1，进程池 8，证书至 2027-01-14）。调用收口 `ai-client.js#analyzePosition`。
- 端点解析 `utils/engine-config.js`（override > storage > `.env` 生成 `engine-config.build.js` > 默认）。改地址：改 `.env` → `npm run config:engine` → 重编译；`build.js` **必须提交**。
- 协议权威：`E:\WorkBuddy\ai-chess-server\docs\05-小程序接入协议.md`。判错看 `body.type==='error'`（HTTP 200 也会报错）；只用 `lines[].scoreCp/scoreMate`（行棋方视角）。
- 行为：终局/非法 FEN 本地前置拦截；失败回落本地带 `degradedFrom`；连续 2 次失败熔断 60s；400 类不回落直接抛。
- `ENGINE_ENDPOINT_DEV` **已停用**：develop 与 release 同走 https 域名，**链路不给 develop 分叉**。
- **403 判定收紧**：只有「403 + 非 JSON（网关 HTML）」才算环境屏蔽；`403 + JSON` 走普通回落+熔断。
- 诊断：`utils/engine-probe.js` + Landing 调试面板「开始探测」，按 `path not allowed`/`not in domain list`/403/超时分类，**先探测再猜**。
- 换域名只改 `remote-engine.js#DEFAULT_ENDPOINT`，别写进 `cloud-config.js`。

## 云服务 / LLM 点评
- 应用 = **`wbapp_a2yIza6bMcvSBfKcMQI3CP`**（黑白格大师，兼发布载体），`resourceId=wbcs_NQXWYxRVa9K2OgVm7y6AiH`。
- 凭据只在 `utils/cloud-config.js#publicConfig`；前缀必须 `wbpk_<当前 appId>_…`。
- **删应用 = 吊销全部 publishableKey**（表象只是「网络连接失败」）。一条 curl 判死活：`GET {endpoint}/.cloud/llm/models` + `x-wb-webapp-access-key`，200 活 / `401 invalid_client` 吊销。真实调用 `POST /.cloud/llm/chat/completions`（stream 必须 true）。
- 四步闭环：开通(reuse appId) → 改凭证 → 隐私清单（最小声明仅 Clipboard）→ 真实探针（用完即删）。**改凭证后必须重新上传体验版/正式版**。

## 环境通路（2026-10-22/23 结论）
- 正式 AppID **`wxd3f1d012e71052a9`**，`chess.imex.de5.net` 与 `mp-api.app.workbuddy.host` 已配进 request 合法域名 → 预览扫码/体验/正式均通。旧测试号 `wxe91834e9c2546603` 时代「双断」结论作废。
- 开发者工具「模拟器/真机调试」：`urlCheck:false` → 引擎与 LLM 都通。
- WorkBuddy 预览面板：LLM 通；引擎断（`wx.request` 是本地 shim，只校验 pathname、丢弃 host → 只放行 `/.cloud/*`；**在自己服务器加 `/.cloud` 别名也无效**）。代码按根因拆两码：`PREVIEW_SANDBOX`（沙箱路径，宿主设计行为）与 `GATEWAY_BLOCK`（403+HTML/未配白名单），`state().blockedKind` 暴露根因，文案分三套。
- WorkBuddy 发布两条路：平台「试用版」（14 天/15 人/不能转正/引擎 ❌）vs **「绑定已有小程序账号」**（发到自己的 AppID，正路）。WorkBuddy 只是上传提审通道，**能力看 AppID**。`.wbapp_*.genie#appId` 不是微信 AppID，永不进 `project.config.json`（填错 → 真机调试 -50005）。同一 AppID 体验版只有一个槽位，两条发布链互相覆盖。
- 判断限制前先分清三类：**凭据 / 域名白名单 / 沙箱路径**。
- 不要照搬「微信云开发双环境 + `wx.cloud.callFunction`」通稿：它只在自有 AppID 侧成立，受管 AppID 与预览面板都没有 `wx.cloud`。

## 页面导航与预览限制
- 一律 `utils/navigation.js#navigate(url,{host,onFail,onSuccess})`，**不要直接 `wx.navigateTo`**；候选 url 形式自适应 + 全失败显形，`onSuccess` 报告第几种形式成功（Landing 写运行日志）。
- 预览没有剪贴板 → 复制按钮必须显形提示「长按选中」；错误正文/日志带 `user-select`。
- Landing 调试面板（默认收起）：运行日志 + 10 项宿主接口能力探测。

## 对弈（pages/play）要点
- 走子护栏 `_canPlayerMove()`：仅己方行棋方、轮到己方、AI 不在思考/演示；`pressSquare` 拒绝选中对方棋子（与 analyze 自由模拟语义相反）。
- `engineMove()`：玩家落子→自动分析→轮到 sparrer 取最佳应着；任何失败都复位思考态。
- 点评门控 `maybeAutoCoach()`：`autoCoach=off` 从不自动；关键步 = |Δcp|≥`playKeyCp`(80) 或吃子/将军/送将（纯引擎判定，不走 LLM）。
- 玩家选黑：初始 `myTurn=false`，由 sparrer（白）`scheduleAnalyze('kickoff')→afterAnalyze→engineMove` 先走；`undo` 连退两步。

## 打谱（pages/replay）要点
- `parsePgn` → `Session.loadPgnTree`；树语义：变例是被替换那一步的兄弟，主线恒 `children[0]`。
- 棋盘**只读**；导航=后退/前进/重置/到末尾；走法记录可点（`move-list` 的 `interactive`）。
- 每步引擎标注走**节点级缓存**（`_cache` + `Session.cacheAnalysis`），`_cacheDepth` 记请求深度，跨页面恢复或深度一致才复用。
- 点评**手动触发**；切步清点评与演示；演示跑在 DemoSession 临时副本上，退出不改棋谱位置。
- `session-store` 里 `_session/_sessionMeta` 与 `_session`（Game）并存，按 mode 取用。

## 回归测试门禁
`.workbuddy/tests/` 零依赖（`_harness.js`）。managed node：`C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`
- 页面层：`analyze-page 253` / `play-page 78` / `replay-page 125` / `landing 60` / `navigation 35` / `session 46`
- 解析层：`pgn-tree 55`
- 服务层：`engine-and-game 153` / `remote-engine 88` / `cloud-adapter 68` / `agent-tools 48` / `analysis-service 43` / `comment-model 31` / `engine-config 30` / `coach-service 15` / `coach-demo`（独立脚本）
- 页面测试开头 `ai.setEngineMode('local')`；等待一律 `waitFor()` 轮询（15s），不写死 sleep；引擎回着/收尾分析等 `myTurn===true`。

## 文档索引
- `AGENTS.md`（总纲 + 核心约束）、`docs/agent-plan.md`（术语/D1~D18）、`agent-phase1/2/3`、`agent-tutor-interactions.md`（改 Tutor 界面/文案先读）、`走法演示交互设计.md`。
- `docs/平台化产品重构方案.md`（L0/L1/L2 + §9 界面简化 + §11 澄清）、`docs/平台化重构进度看板.md`（跨会话续做总览）。
- `docs/云服务接入经验总结.md` / `docs/自建引擎服务部署方案.md`。
