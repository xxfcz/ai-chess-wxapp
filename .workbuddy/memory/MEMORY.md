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
- `docs/平台化重构进度看板.md`（2026-10-22 建：**独立进度看板 + L2 Landing/分包任务分解**，跨会话续做总览）。
- `docs/云服务接入经验总结.md` / `docs/自建引擎服务部署方案.md`。

## 平台化重构（架构与进度）
- 三层：L0 纯功能平台层（棋局会话，已完成）/ L1 共享 UI 组件（已完成）/ L2 模式配置层（Landing + 多模式分包，**未开始**，任务分解见 `docs/平台化重构进度看板.md` §2）。
- 导航：Landing 首页（主包单页）+ 各模式分包 page（subPackage）；加模块=加分包 page + Landing 注册卡片。SPA 双视图降为可选。
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

## 回归测试门禁
`.workbuddy/tests/` 零依赖（`_harness.js`）。managed node：`C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`
- `analyze-page 201` / `engine-and-game 153` / `cloud-adapter 68` / `agent-tools 48` / `remote-engine 82` / `coach-demo`（独立脚本）。
- `analyze-page` 开头 `ai.setEngineMode('local')`；等待一律 `waitFor()` 轮询（超时 15s），不写死 `sleep`。

## 第二轮澄清决策（2026-10-21，方案 §11）
- 服务职责：`engine-service` + `analysis-service`（折叠在 `ai-client.js` 的 `formatScore/buildLineView/evalPercent`）+ `coach-service`。重构即把 analysis/coach **物理拆离** `ai-client.js`。
- `degraded` 语义：`source` 仅 `remote`/`local`；`degraded` 是 `local` 上的标记(`degradedFrom`)，与「用户主动选 local」区分。
- `autoCoach` 设置项(`off/on/remoteOnly`)；`llm-provider` 抽象(`platform`/`openai-compatible`)，前端存 key 会被提取→建议走自有代理（`chess.imex.de5.net/llm`）。
- **剪贴板自动读 FEN/PGN**（纳入 MVP）：`onShow` 调 `wx.getClipboardData()`（仅文本），匹配合法 FEN/PGN 则 `wx.showModal` 询问导入。图片识别改后续阶段（`wx.chooseMedia`+后端 `/recognize`）。
- 内容易迷失：交互研究 backlog（渐进展示/面包屑/聚焦讲解/分支树局部展开），不定稿。
- **deferred**：继续上次棋谱（依赖阶段三 cloud）、练习题库（依赖外部数据）。
