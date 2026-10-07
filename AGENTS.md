# AGENTS.md — 国际象棋 AI 分析小程序

> 面向 AI 助手的快速上手指南。改代码前先读完「核心约束」一节，很多坑是反复踩出来的。

## 1. 这是什么

微信原生小程序「国际象棋 AI 分析」：

- 用户粘贴 **FEN** → 在 `pages/analyze` 用 **视图棋盘** 对弈/模拟 → 端上引擎给出 **三条最佳路线（MultiPV=3）** 分析 → 可选 **云端 AI 教练** 用大模型生成中文局面点评。
- 分析引擎是**端上纯 JS**（Alpha-Beta + 静态评估 + 静态搜索），**不依赖云端 Stockfish、不使用 web-view**。
- 云服务只用于「AI 教练点评」（流式 LLM），走云服务内置的大模型网关，**免 API Key**。

云服务应用 id：`wbapp_Q0BvUcC34QxiYVHs0aFeay`（appType=miniprogram，名称「国象AI分析」）。

## 2. 技术栈与运行环境

- 微信原生小程序，无第三方框架、无状态管理库（页面内自查状态）。
- 唯一依赖：`@tencent-ai/workbuddy-cloud-sdk`（见 `package.json`、`miniprogram_npm/`）。
- 引擎/规则逻辑是**纯 Node 模块**，不依赖 `wx`/DOM/Canvas，可单独跑测试。
- 预览环境（WorkBuddy 内置网页预览）= 远端模拟器，只实现了微信接口**子集**：已知**缺 `wx.createSelectorQuery`**，且不保证 `getWindowInfo`/`getSystemInfoSync`/`showToast`。因此**任何依赖 wx 的能力都要先探测再降级**，不能靠报错兜底。

## 3. 目录结构

```
app.js / app.json / app.wxss      小程序入口；app.json 顶层必须保留 lazyCodeLoading
pages/analyze/                    唯一页面：analyze.{js,wxml,wxss,json}
                                  布局：唯一的固定元素是棋盘（view 网格，留在上半屏），
                                  状态/控制按钮与 Tab 内容同属一个 scroll-view 整体划动（Tab 内部不再各自滚动），
                                  底部 Tab 栏钉住：局面 / 引擎分析（内含深度选择与「PV走法」）/ AI教练点评 /
                                  走子记录 / 运行日志。FEN 载入在「局面」Tab（最左）内。
                                  状态条已压成单行、优势只显示数值（不画进度条）。
                                  棋盘尺寸按窗口高度约一半做上限，保证留在上半屏。
utils/
  chess.js                         chess.js 0.10.3 本地副本 + 末尾追加 raw_* 扩展（见 §5）
  engine.js                       端上 Alpha-Beta 引擎，analyze() 是对外契约（见 §4）
  game.js                         棋局状态管理（载入/FEN/走子/悔棋/终局/自由模拟双方）
  board-model.js                  棋局状态 → 棋盘视图数据（纯函数）
  geometry.js                     坐标换算（cell↔square、亮暗格、行列）
  ai-client.js                    分析门面 + 分数格式 + 云端点评请求
  cloud.js                        云服务客户端单点初始化（懒加载复用）
  cloud-config.js                 云服务 publicConfig（endpoint + publishableKey）
  cloud-adapter / diagnostics     wx.request 流式/降级适配、超时看门狗
  text-codec.js                   TextDecoder/TextEncoder 兜底（真机缺失时补）
  device.js                       安全取值：窗口宽度 / Toast / 网络能力探测（逐级降级不抛错）
  debug-log.js                    60 条环形缓冲日志，页面「运行日志」卡片可查
.workbuddy/tests/                 纯 Node 自检测试 + 实网探针（见 §7）
docs/                            问题排查与修复记录.md（历史排障笔记）
```

新增页面时：写 `pages/<name>/<name>.{js,wxml,wxss,json}` 并同步把路径加进 `app.json` 的 `pages`。

## 4. 端上引擎契约（冻结，勿改字段）

`utils/engine.js` 的 `analyze({ fen, depth, multiPV })` 输出：

```js
{ lines: [{ rank, uci, san, from, to, scoreCp, scoreMate, pv, pvSan }],
  terminal, depth, nodes, elapsedMs, sideToMove }
```

- 分数是**行棋方视角**（UCI 惯例，>0 表示该方占优）。界面在 `ai-client.js#formatScore` 换算成白方视角。
- 换真实引擎时**只替换 `utils/engine.js`**，上层 `ai-client` 与页面不动。
- `terminal` 为终局对象 `{ over, inCheck, winner, reason, label }`（见 `game.js#status`）。

## 5. chess.js 本地副本的关键约定

- `utils/chess.js` 是 chess.js 0.10.3 的本地副本，文件末尾追加了 `raw_moves() / raw_move() / raw_undo() / raw_board()`（有注释标明）。
- **搜索树内部禁止用 `chess.moves({verbose:true})`**：SAN 生成是 O(n²)，实测慢约 13 倍。内部走子用 `raw_*`；只在根节点和主变展开时用 `describeMoves()` 生成一次 SAN。
- `validate_fen()` **只校验不载入**——任何地方校验完必须显式 `load(fen)`（`game.js#load` 就是这么做的）。
- 自由模拟双方（拖对方棋子自动翻转行棋方）依赖 `Game.buildProbe()` 在**副本**上算合法落点，**不能在真实实例上改 turn**（见 `game.js#legalTargetsFrom`、`_switchTurn`）。

## 6. 核心约束（改代码前必读）

### 6.1 棋盘渲染：不用 Canvas
- 预览环境不实现 `wx.createSelectorQuery`，Canvas 2D 拿不到节点会直接抛错。
- 棋盘用 8×8 的 `view` 网格 + 格内**文字字形**（`board-model.js#GLYPHS`）。
- 拖拽落点用「手指位移 ÷ 格宽」在原格上做偏移反推，**不需要查询棋盘真实位置**。
- 用到环境信息（窗口宽度、Toast）一律走 `utils/device.js`，它逐级降级且**永不抛错**。

### 6.2 棋盘索引：小心镜像
- `board-model.js` 的 `board` 参数是 chess.js 的 `board()`，**第 0 行是第 8 横线**。
- 按格取子必须 `board[7 - rank]`（rank 为 0 基、a1=0）。写成 `board[rank]` 会整盘上下镜像——起始局面对称看不出，非对称局面全错。`analyze-page.test.js` 有对应回归断言。

### 6.3 高亮与选中态
- 棋盘高亮用 `.cell.last/.hint/.sel/.check` 的 **inset box-shadow 叠色**，不覆盖格子底色。
- 触屏同时提供 `bindtouchstart/move/end`（拖拽）与 `bindtap`（点选）两条路径，预览即使不支持拖拽也能走子。

### 6.4 WXML 模板硬约束（预览渲染限制，写回去即红）
`analyze-page.test.js` 第 13 节对以下三点做静态守卫，**新增/修改 WXML 时务必遵守**：
- **不要在 `wx:for` 元素「自身的属性」里引用循环变量 `index`**（正文子节点里可以用）。预览渲染元素自身属性时取不到 `index`，整行渲染不出来，而同级不依赖 `index` 的文字照常显示。做法：把下标/选中态写进数据（`buildLineViews()` 输出 `idx`/`key`/`active`）。
- `wx:key` 用**字符串字段**（如 `key: 'line' + i`），不要用数字字段。
- 不用 `<block>`，用独立的 `wx:if`。
- 客户端高亮/选中类状态随数据下发更稳（`applyLineActive()` 重建数组），不要依赖 `setData` 的路径语法（`'list[0].x'`）。

### 6.5 状态与配置
- 状态管理保持页面内自查，无第三方状态库。
- `app.json` 顶层**必须保留** `"lazyCodeLoading": "requiredComponents"`。

## 7. 云服务（AI 教练点评）

- 只用一个入口：`@tencent-ai/workbuddy-cloud-sdk/miniprogram`；`utils/cloud.js` 单点初始化，懒加载复用；**必须同时传 `publicConfig.endpoint` 与 `publishableKey`**（小程序没有 `location.origin`，缺 endpoint 直接初始化失败），并挂 `createDiagnosticWx(wx)` 适配器。
- **真机必须补 `TextDecoder`**：SDK 的 SSE 解析器内部 `new TextDecoder('utf-8')` 并要求增量 `decode`，而**微信真机没有这个全局对象**（预览有 → 只在真机暴露「TextDecoder is not defined」）。`utils/text-codec.js` 提供兜底（`installTextCodec()` 只在缺失时装、绝不覆盖原生），`app.js` 与 `utils/cloud.js` 顶部各装一次。**不要删这两处安装，也不要改成覆盖原生实现。**
- 该 SDK **只支持流式**（`stream:false` 会抛 `request_stream_required`），底层无条件调用 `task.onChunkReceived(...)`；适配器做了「原生分块 → 一次性请求 + 整包当单分片」的自适应降级。
- **`task.abort()` 会回调 `fail({errMsg:'request:fail abort'})`**：适配器在放弃探测请求时**必须先置 `state.abandoned = true` 并忽略其后一切回调**，否则这个自己造成的 abort 会抢先判负，界面报 `gateway_network_error · ... request:fail abort`。打桩的假 wx 也要还原此行为，否则测不出来。
- **模型选择：按「够快」挑，不要默认 `auto`**。`ai-client.js` 的 `MODEL_PREFERENCE = ['deepseek-v4-flash','hunyuan-chat','glm-5.3-flash']`，其后才 `auto`/`default`/第一条可用；跑通过的模型缓存并排首位。`llm.models.list()` 实测返回约 31 个模型（免 Key）。**响应分片的 `chunk.model` 才是真正服务的模型**，界面显示在点评下方（厂商由 `providerOf()` 按 id 前缀推断）。
- **点评带 `max_tokens: 480`**，限制输出长度直接决定等待时间。
- **失败自动换模型重试一次**（`MAX_ATTEMPTS=2`），但只对 `shouldTryNextModel()` 认的几类：`timeout` / 空正文 / `model_*`。链路类（`gateway_network_error`）、鉴权、额度、参数错误不重试；用户取消后绝不能偷偷再发。
- **超时必须与「网络不通」分开报**：判定条件为「`code` 以 `gateway_` 开头 **且** `detail` 含 `timeout`」→ `kind:'timeout'`。**必须带 code 前缀判断**，否则裸的 `new Error('request:fail timeout')` 会被误判。
- `describeLLMError()` / `llmErrorInfo()`：`gateway_network_error` = **请求本身失败，不是模型故障**，不要混报成「模型服务暂时不可用」；报错时把 `code` + 逐层 `cause.message` 汇总成 `detail`。
- **时限常量集中在适配器顶部**：一次性请求兜底 `PLAIN_CEILING_MS=75s`、分块空闲看门狗 `CHUNK_IDLE_MS=25s`、`wx.request` 自身 `timeout=80s`（略大于兜底时限）、`app.json` 另有 `networkTimeout.request=90000` 兜一层。自检要缩短时限时用 `createDiagnosticWx(wx,{plainCeilingMs,chunkIdleMs})` 第二参，生产代码不要传。

## 8. 预览环境能力探测

- 网页版预览只实现微信接口子集。**任何依赖 wx 接口的能力都要先探测再降级。**
  - `device.js#canRequest()` 探测 `wx.request` 是否存在。
  - `ai-client.js#requestCoachComment()` 入口用它，缺网络时抛 `error.code='env_no_network'`（文案 `ENV_NO_NETWORK_TEXT`）；`describeLLMError()` 负责把它和原始 `TypeError` 都翻成中文。
  - 页面结果写进 `data.cloudReady` / `data.cloudHint`，`analyze.wxml` 据此置灰按钮。
- **端上引擎分析与 wx 接口无关，任何环境下都必须可用**，不要把它和云端能力绑在一起。

## 9. 测试与质量门禁

`.workbuddy/tests/` 下是纯 Node 脚本（打桩最小 wx/Page/云 SDK），直接用 node 跑：

```bash
node .workbuddy/tests/engine-and-game.test.js   # raw 接口一致性、规则层、终局、引擎输出与超时降级
node .workbuddy/tests/analyze-page.test.js      # 页面初始化、走子(拖/点)、历史、FEN、自动分析、云端点评与错误分支、模板可渲染性静态守卫
node .workbuddy/tests/cloud-adapter.test.js     # UTF-8 编码、原生分块透传、降级、中止探测不判负、看门狗等
```

- 改完引擎或页面后**跑这三套，全绿再交付**。
- `analyze-page.test.js` 的打桩环境**故意不提供** `createSelectorQuery`/`getWindowInfo`/`getSystemInfoSync`，重新引入这些接口会当场红。
- 实网探针（需网络、消耗少量云服务额度，**不属常规回归**，按需跑）：
  - `cloud-live-probe.js`：真实云服务 + 模拟「不支持分块流式」的 wx，验证点评链路端到端。
  - `cloud-model-probe.js`：用真实提示词跑一次，看实际服务模型/耗时/请求明细。
  - `cloud-model-bench.js [模型id ...]`：逐个比候选模型耗时（选型结论靠它复现）。
  - `cloud-realdevice-probe.js`：模拟「原生分块可用 + 无全局 TextDecoder」的真机形态，跑真实云服务验证真机链路。

## 10. 常见任务指引

- **改棋盘渲染**：动 `board-model.js`（视图数据）与 `analyze.wxml/wxss`。遵守 §6.1–§6.4；坐标换算走 `geometry.js`。
- **改引擎**：只动 `utils/engine.js`，保持 `analyze()` 输出契约（§4）。内部用 `raw_*`，别在搜索树里生 SAN。
- **改云端点评**：动 `ai-client.js`（提示词/模型/超时/重试）与 `cloud-adapter`（看门狗/降级）；配置在 `cloud-config.js`。遵守 §7，发布前在微信开发者工具执行「构建 npm」。
- **加新页面/功能**：页面内自查状态，新页面加进 `app.json#pages`，保留 `lazyCodeLoading`。
- **排查真机/预览问题**：先看界面「运行日志」卡片（环形缓冲）；`onToggleEnableDebug()` 走 `wx.setEnableDebug` 打开真机调试面板（重进小程序才生效）。
- **Agent 化（Tutor / Sparrer）**：先读 `docs/agent-plan.md`（角色定义、术语表、冻结契约、决策记录），
  再按阶段读 `docs/agent-phase1-tutor.md` / `agent-phase2-react.md` / `agent-phase3-memory.md`。
  **改 Tutor 界面/文案前先读 `docs/agent-tutor-interactions.md`**（六条交互第一性原则、三个阶段共用的
  会话状态机、错误文案口径表 §8）；它不重复阶段的机制设计，只约束「用户看到什么、能做什么」。
  三条跨阶段铁律：**走法只能由 chess.js 产生**（LLM 只输出意图/候选编号，不拼写 SAN）；
  工具层跑在端上（`utils/tools.js`，用 `raw_*`）；工具结果压缩后才回传模型。
  术语：教练 = `tutor`，陪练 = `sparrer`（**不用 `opponent`/`rival`**，理由见 plan §1.1）。
  注意：**既有 `coach` 标识符不重命名**（`COACH_SYSTEM_PROMPT`、`coach-demo.js`、`onCoach`、`coachText`），
  见 plan §1.4；新增的一切统一用 `tutor` / `sparrer`。

## 11. 一句话避坑清单

- 不引入 web-view；分析引擎是端上的，换引擎只改 `engine.js`。
- 棋盘不用 Canvas，用 8×8 视图网格 + 字形；取子 `board[7-rank]` 别写成 `board[rank]`。
- WXML：`wx:for` 自身属性不引用 `index`；`wx:key` 用字符串；不用 `<block>`。
- 环境信息走 `device.js`，永不抛错；能力先探测再降级。
- 真机缺 `TextDecoder` → `text-codec.js` 兜底，`app.js` 与 `cloud.js` 都要装。
- 云服务别默认 `auto`（慢 50s+）；快模型排前面；`max_tokens=480`；超时 vs 网络错误分开报。
- 改完跑三套测试，全绿再交付。
