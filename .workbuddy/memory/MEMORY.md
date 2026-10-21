# 项目长期约定（ai-chess-wxapp）

## 角色命名（用户拍板 2026-10-07）

| 中文 | 英文 | 标识符 |
|---|---|---|
| 教练 | Tutor | `tutor` |
| 陪练 | Sparrer | `sparrer` |

- 统一双写 r = `sparrer`（不是 `sparer`）。**不用 `opponent`/`rival`**——`opponent` 的目的是赢你，
  用它命名会让产品往"提高胜率"优化，结果用户每局被虐。命名影响每个 design trade-off。
- 阶段三代号 `Persistent Tutoring Memory`。
- **既有 `coach` 标识符不重命名**（`COACH_SYSTEM_PROMPT`、`utils/coach-demo.js`、`onCoach`、`coachText`、
  `ai.requestCoachComment()`）——改名收益低、回归风险高（`coachText` 是 setData 键名，牵动 WXML）。
  原则：新增代码用 `tutor`/`sparrer`，既有的不动。

## 文档编码约定（2026-10-21 定）

- **始终用 UTF-8（无 BOM）保存文档（.md 等文本文档）**。本项目 `docs/*.md` 经检测均为合法 UTF-8（无 BOM），这是标准且兼容性最好的格式。
- **不要加 BOM**：BOM 在部分工具（Git GUI/Tk、某些解析器）里不会被剥离，反而显示成 `ï»¿` 乱码或破坏解析；用户已明确要求「不要带 BOM」。
- 若某 Windows 编辑器把无 BOM UTF-8 误判为 GBK 显示乱码，那是**查看器的问题**，解决办法是让查看器以 UTF-8 打开（VS Code 默认正确；记事本可在「文件→另存为/打开」选 UTF-8，或开启系统「Beta: 使用 Unicode UTF-8」），而不是给文件加 BOM。
- **代码 / 配置文件同样无 BOM**（BOM 会破坏 shebang、JSON/JS 解析）。
- 校验/修正用 managed python：`open(p,'rb').read()[:3]==codecs.BOM_UTF8` 应为 False；`decode('utf-8')` 应成功；去除 BOM：`open(p,'w',encoding='utf-8').write(open(p,encoding='utf-8-sig').read())`。

## 数据格式（2026-10-08 定）

- 内部一律 `FEN + UCI`（演示线、分支树节点、错题索引），不用 PGN 存状态；
  PGN 只在进出边界各转换一次（导入 `load_pgn` / 导出 `pgn()`）。
  理由：同一局面经不同顺序到达时 PGN 不同但 FEN 相同，用 PGN 会导致阶段三错题去重失效。
- **不用 PGN 作为 LLM 输出格式**：与 `moves` 数组等价、幻觉风险不变，解析反而更难。
- `utils/game.js` 未暴露 `pgn()`/`loadPgn()`，需经 `this._chess` 或新增转发。

## 回归测试门禁（2026-10-15 更新）

`.workbuddy/tests/`，零依赖（`_harness.js` 是自写的极简断言工具）。managed node：
`C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`

```
engine-and-game.test.js   # 153  规则层/终局/引擎输出/超时降级
analyze-page.test.js      # 200  页面全链路 + WXML 静态守卫 + 引擎来源标注（第 13 节）
cloud-adapter.test.js     #  68  流式适配/降级/看门狗
agent-tools.test.js       #  48  阶段一工具层
remote-engine.test.js     #  76  云端引擎：映射/视角/终局拦截/回落/熔断/环境级屏蔽(GATEWAY_BLOCK)
coach-demo.test.js        # 独立脚本（非 harness），打印 PASS/FAIL
```

- `analyze-page` 对机器负载敏感：等待一律 `waitFor()` 轮询（超时 15s），**不要写死 `sleep`**。
- **页面回归开头 `ai.setEngineMode('local')`**：打桩的 `wx.request` 永不回调，走 remote 会让页面挂在
  `await` 上、进程静默退出（exit 0 + 无 summary，很难查）。远端路径由 `remote-engine.test.js` 与
  `analyze-page.test.js` 第 13 节（自带可控 wx 打桩）覆盖。

## 规划文档

`docs/agent-plan.md`（总纲：术语表 §1.2、命名对照 §1.4、冻结契约、决策 D1~D18）
+ `agent-phase1-tutor.md` / `agent-phase2-react.md` / `agent-phase3-memory.md`
+ `agent-tutor-interactions.md`（交互总览：六条第一性原则、会话状态机、§8 错误文案口径表）
——**改 Tutor 界面/文案前先读它**。阶段二、三不写函数级改造清单，只留契约 + 待决策项 + 验收口径。
+ `docs/平台化产品重构方案.md`（2026-10-21，产品平台化重构总纲：L0/L1/L2 分层、SPA 双视图、四模块版图、§9 界面简化）

## 交互设计三条硬结论

- **不做聊天窗口**（挤占棋盘 + 与「Tab 内不再各自滚动」冲突），用同 Tab 内对话卡片流。
- **Tutor 必须能「指」棋盘**（move/sq/piece 三类记号 + focus 高亮），否则与通用大模型无差异。
- **不新增底部 Tab**（5 个已是小屏上限）；消息数 ≤ 3 轮。

## 云服务接入惯例（LLM 点评）

- 凭证只在 `utils/cloud-config.js` 的 `publicConfig`（`endpoint` + `publishableKey`，可随前端发布）。
- **隐蔽回归点**：每次「重建/重发应用」后代码里的 `publishableKey` 前缀不会自动更新，
  必须人工核对前缀 == 当前 applicationId，否则调用落到旧账号/旧环境。
- 接入四步闭环：**开通（reuse appId）→ 改凭证指向 → 隐私清单 → 真实探针**。
- 「测试全绿 ≠ 云可用」：真实数据面必须靠一次性探针验证（探针用完即删），详见 `docs/云服务接入经验总结.md`。
- 隐私清单按需最小声明（本项目仅 `Clipboard`）。

## 能力开关（2026-10-10 定稿，规格见 `docs/能力开关与功能矩阵.md`）

三个**独立**开关（L0~L4 线性档位已废弃）：`engine: local|remote`、`cloud: off|on`、`llm: off|light|heavy`。
**每个功能点按自己依赖哪个开关渲染**，不要问"全局是第几档"。

- `remote` 不用 `cloud`：`cloud` 已被「微信原生云」占用；`remote` 只表达"不在端上跑"。
- **措辞铁律**：不许说「本地没有引擎」，要说「本地有一个弱引擎」。`engine` 调的是**强度**不是有无。
  拆三层：规则层（chess.js，零误差，是地基不是引擎）／搜索+评估层（`utils/engine.js`，启发式，
  这才是开关在切的）／输出层（三条线、scoreCp、PV，是结果不是能力）。
  **规则判定 = 事实**（可断言"这步不合法"），**引擎评分 = 意见**（只能说"引擎认为…"），界面必须分层。
- 三条铁律：① 离线不是残废模式，界面不许空；② 调 LLM 的开关是「出现值得讲的信号」不是「走了一步」；
  ③ **降级必须显形**，不要等按钮点下去才报错。
- `cloud: on` 买的是**连续性**（跨设备存档/题库/画像），不是能力。阶段三记忆层需要 `cloud on`。

## 端上保底通道（AGENTS.md §8）

> **四条保底通道不依赖网络：规则判定、走法生成、演示线、本地评分。任何环境下都必须可用。**

约束的是**可用性，不是强度**。端上 `utils/engine.js` 是**冻结的基线、不是待优化项**（维护成本≈0，
`engine: remote` 接通后自动让位），不要再往里投资源。
实测（本机 node22，multiPV=3）：起始 depth2/3/4 = 396/415/793ms，中局 1294/2128/4457ms。

## 云端引擎 `engine: remote`（2026-10-15 已落地）

- 实现：`utils/remote-engine.js` → `POST {endpoint}/v1`，当前 `https://chess.imex.de5.net`
  （2026-10-16 从 `ai-chess-server.app.workbuddy.host` → 自建香港机 → 自有域名；Stockfish **15.1**，
  进程池 8；端到端 400~900ms）。调用收口 `ai-client.js#analyzePosition`（默认 remote）。
- **端点不写死**：`utils/engine-config.js` 按 `override > storage > .env注入 > 内置默认` 解析。
  改地址流程：改 `.env` → `npm run config:engine` → 生成 `utils/engine-config.build.js` → 重新编译
  （小程序运行时读不到 process.env/.env；**生成文件必须提交**，`.env` 进 .gitignore）。
  develop 版优先用 `ENGINE_ENDPOINT_DEV`（可 http+IP:端口），release/trial 只走正式 https。
  地址非 http(s)/空值一律当没配、回落到下一级。详见 `AGENTS.md §4.2`。
- 自建机 `POST /v1` **不带 engine 字段**，版本从 `GET /healthz` 并行懒探一次并缓存（失败静默）。
  契约与 `engine.js#analyze()` 同构，只多 `source` / `engineVersion` / `remote`。
- **协议唯一权威**：`E:\WorkBuddy\ai-chess-server\docs\05-小程序接入协议.md`。要点：
  判错一律看 `body.type === 'error'`（HTTP 200 也会报错体）／**只用 `lines[].scoreCp`/`scoreMate`**
  （已是行棋方视角；顶层 `eval`/`centipawns`/`mate` 是白方视角）／`lines[]` 没有 `captured`（取顶层，仅第 1 线）。
- 四条行为约定：终局 + 非法 FEN **本地前置拦截**不打扰远端；失败/超时**回落本地且带 `source:'local'`
  + `degradedFrom`**（不许静默）；**连续失败 2 次熔断 60 秒**（期间直接走本地，避免每次自动分析干等超时）；
  400 类（`INVALID_FEN`/`GAME_OVER`…）**不回落**，直接抛（属本地 bug）。
- UI 深度→远端参数：2→depth12/300ms、3→14/500、4→16/800。实测端到端：首次约 5s（含连接建立），
  之后中局约 1s。
- ⚠️ **`app.workbuddy.host` 是 CloudStudio 开发预览域名，天生不能当小程序后端**：
  - 服务端本身**不鉴权**（curl 直连 200 正常分析），但前面是 `CloudStudio Gateway`；
  - **H5 预览**：预览环境的 `wx.request` 只允许 `/.cloud/` 路径，其余一律 `request:fail path not allowed`；
  - **真机**：网关识别微信移动端 UA（完整 `MicroMessenger` iPhone UA）→ HTTP 403 + HTML「请在浏览器中打开」
    （curl 实测：裸 `microMessenger/8.0` → 200，完整 iPhone UA → 403）；
  - 之前"实测端到端 1s"是在**微信开发者工具**（桌面 Chrome UA，不触发拦截）测的，**不代表真机/预览可用**。
  - **结论**：要让 `engine: remote` 在真机可用，必须把引擎部署到**自有 ICP 已备案域名**（路线 C），
    仅靠 `app.workbuddy.host` 永远跑不通预览与真机。
- ⚠️ 换域名只改 `remote-engine.js` 的 `DEFAULT_ENDPOINT` 或 `configure({endpoint})`；**不要**写进
  `cloud-config.js`（那是 LLM 凭据位）。
- 代码侧已把这类「环境级屏蔽」归类为**永久屏蔽** `GATEWAY_BLOCK`（区别于普通网络抖动/熔断）：命中后
  本会话不再发请求、不再刷屏，界面给出明确提示「开发预览域名在微信内不允许直连，正式版需自有已备案域名」。
- 真机/发布前：request 合法域名加该域名；`project.config.json` 当前 `urlCheck:false`（联调态）。
- 探针：`.workbuddy/tests/remote-engine-live-probe.js`（真连服务端，含杀棋/终局/不可达回落）。

## 远端引擎选型（结论存档，不再展开）

- **自建 VPS vs 微信云托管 → 倾向自建**：云托管冷启动 20~40s、0.25 核对 Stockfish 偏弱、
  常驻 0.25 核 ≈260 元/年；自建 2 核无冷启动 ≈300~600 元/年，且能顺带跑题库/用户/付费，边际成本为零。
  云托管硬约束：仅 HTTP、无公网 IP、`CallContainer` ≤15s、无持久化存储。
- **chess-api.com**（第三方，免 Key）：REST 的 `variants`/`searchmoves` 被忽略（MultiPV 只有 WS 给）、
  不校验终局、无 SLA。降格为「可选兜底上游」；客户端判错方式与自建同构，换上游只改 baseURL。
- **香港机 `112.121.168.204`**（Debian 12，16C/24G）：可跑 Stockfish，但**香港不能备案**，
  大陆主体小程序合法域名必须有备案号 → 域名+备案是关键路径（7~20 工作日）。
  安全：曾实测 27017/9000 公网暴露，已要求 ufw 收口 + mongod bindIp 127.0.0.1。
  方案文档 `docs/自建引擎服务部署方案.md`。
- **GPL**：只服务端运行 + HTTP 调用不触发传染；前提是**任何 Stockfish 二进制/wasm 都不进小程序包**
  （将来做 Web 版也不能打进前端）。

## 产品架构方向（2026-10-21 定）—— 平台化重构

- 决策：把「棋局会话（FEN/PGN + 走子树 + 引擎分析 + AI点评）」抽成**无 UI 纯功能平台层（L0）**
  → 共享 UI 组件层（L1） → 模式配置层（L2：对弈/分析/打谱/练习）。
- 导航（**2026-10-21 第二轮修正**）：**Landing 首页（主包单页）+ 各模式分包 page**（subPackage）。澄清：
  小程序无 HTML 页面；多 page ≠ 主包增大（靠分包去重）；重建可控（全局 store 保 session + 引擎无状态/纯函数）。
  SPA 单页双视图降为可选方案。架构 = 加模块即加一个分包 page + Landing 注册一张卡片。
- 模块版图：对弈(人机)/分析(已有)/打谱(PGN复盘)/练习(战术·开局) 全部纳入；**MVP 先把现有 analyze 页平台化 + 简化界面**。
- 差异化能力：AI点评的「走法分支 + 点击链接走子/定位」上升为**平台级一等公民**（comment-model 协议层），所有模式复用。
- UI 简化（借鉴 chess_tutor）：删底部脚注/运行日志Tab/点评技术细节/引擎元信息（移入调试模式）；优势文字→**评估条**；
  FEN/PGN 导入移到 Landing 入口（可折叠）；Workspace Tab 由 5 个降到 3 个（引擎分析/AI点评/走子记录）。
- 既有的 `agent-plan` 不废弃：Tutor/Sparrer 从「某功能阶段」上升为**横切教练能力（coach-service）**，被所有模式消费；
  阶段三 Persistent Tutoring Memory 仍是跨模式的用户画像/错题记忆。
- 设计文档：`docs/平台化产品重构方案.md`（含 §9 界面简化清单、§11 第二轮澄清决策，精确到 analyze.wxml 行号）。

## 平台化重构 · 第二轮澄清决策（2026-10-21，详见方案 §11）

- **服务职责**：3 线 MultiPV = `engine-service`(算原始 N 线，已独立) + `analysis-service`(读成 3 线+评分+节点级缓存，当前折叠在 `ai-client.js` 的 `formatScore`/`buildLineView`/`evalPercent`)；AI 点评 = `coach-service`(`requestCoachComment` + `coach-demo.js`)。依赖链 engine→analysis→coach 已清晰，重构即把 analysis/coach 物理拆离 `ai-client.js`。
- **`degraded` 语义**：`source` 仅 `'remote'`/`'local'`；`degraded` 不是第三种来源，是 `source:'local'` 上的标记(`degradedFrom`)，表示「本想用 remote、远端不可用、被动回落 local、棋力偏弱」，须与「用户主动选 local」区分。
- **自动点评**：新增设置项 `autoCoach`(`off`/`on`/`remoteOnly`)，用户自定；模式配置层「点评触发」读该设置而非写死。
- **第三方 LLM 可配置**：新增 `llm-provider` 抽象（`platform`=公众平台云 SDK 现状 / `openai-compatible`=BASE_URL+API_KEY+model），设置页可切换。安全提醒：前端存 key 会被提取，建议走自有代理(`chess.imex.de5.net` 加 `/llm`)；直连需加第三方合法域名。
- **剪贴板自动读 FEN/PGN**：Landing/page `onShow` 调 `wx.getClipboardData()`(仅文本)，匹配合法 FEN/PGN 则 `wx.showModal` 询问导入（纳入 MVP）。**图片无法读剪贴板**（`wx.getClipboardData` 只回文本）→ 改后续阶段：用户主动 `wx.chooseMedia` 选图 + 后端 `/recognize` 识别。
- **内容易迷失**：列为交互研究 backlog（渐进展示/面包屑回溯/聚焦讲解模式/分支树局部展开），不现在定稿。
- **暂不展开**：继续上次/最近棋谱（依赖阶段三 cloud 存档）、练习题库（依赖外部数据）→ 移出 MVP，标 deferred。

## 待办

- **`engine: remote` 真机/预览可用性的硬阻塞**：`app.workbuddy.host` 是 CloudStudio 预览域名，
  预览（`path not allowed`）与真机（403 移动端 UA）都直连不通；必须把引擎部署到**自有 ICP 已备案域名**
  （路线 C），并在 mp 后台配 request 合法域名，才能真正在真机用上云端 Stockfish。
- `docs/远端引擎接入方案-chess-api.md` 的 D14「WS 为主」在自建服务下已不适用（REST 就能拿 MultiPV），
  落地以 `05-小程序接入协议.md` 为准。
- **平台化重构待拍板（已收口）**：「继续上次/最近棋谱」与「练习题库」**已决定暂不展开**（deferred，移出 MVP），前者依赖阶段三 cloud 跨设备存档、后者依赖外部题库数据，待平台层稳定后再议。
