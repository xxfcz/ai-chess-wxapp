# AGENTS.md — 国际象棋 AI 分析小程序

> 面向 AI 助手的快速上手指南。改代码前先读完「核心约束」一节，很多坑是反复踩出来的。

## 1. 这是什么

微信原生小程序「国际象棋 AI 分析」：

- 用户从 **Landing 首页**（`pages/landing`）选模式：**分析棋局**（`pages/analyze`）、
  **开新局**（`pages/play`，与 AI 陪练对弈）、**打谱**（`pages/replay`，导入 PGN 复盘）。
- 分析棋局：用 **视图棋盘** 对弈/模拟 → 引擎给出 **三条最佳路线（MultiPV=3）** 分析 → 可选 **云端 AI 教练** 生成中文局面点评。
- 打谱：PGN 只在导入边界转成 **FEN+UCI 走法树**（含圆括号变例），逐步回放、每步引擎标注、点评里的分支可点开演示。
- 分析有两条实现：**云端 Stockfish**（`engine: remote`，默认，走自建 `ai-chess-server` 的 `POST /v1`）与
  **端上纯 JS 引擎**（`engine: local`，Alpha-Beta + 静态评估 + 静态搜索，弱但离线可用）。
  远端不可用时**自动回落端上**，界面必须标注实际来源（见 §4.1）。
- 云服务只用于「AI 教练点评」（流式 LLM），走云服务内置的大模型网关，**免 API Key**。

云服务应用 id：`wbapp_a2yIza6bMcvSBfKcMQI3CP`（appType=miniprogram，名称「黑白格大师」，同时是发布载体）。
`utils/cloud-config.js#publishableKey` 的前缀**必须**等于当前应用 id（`wbpk_<appId>_…`），
**应用被删除或重建会直接吊销旧凭据**（服务端回 `401 invalid_client`），此时所有 AI 点评都会失败，
必须重新开通云服务换 key——这条不核对，就会出现「界面一切正常、点评永远出不来」。
历史应用（已删除，勿再引用）：`wbapp_WqKyrxADH6O75kZ4NkuiMj`（国象AI分析）、`wbapp_XuxCaYOHVeBjdrJ4UfSMX6`（黑白格大师·旧）、`wbapp_Q0BvUcC34QxiYVHs0aFeay`。

## 2. 技术栈与运行环境

- 微信原生小程序，无第三方框架、无状态管理库（页面内自查状态）。
- 唯一依赖：`@tencent-ai/workbuddy-cloud-sdk`（见 `package.json`、`miniprogram_npm/`）。
- 引擎/规则逻辑是**纯 Node 模块**，不依赖 `wx`/DOM/Canvas，可单独跑测试。
- 预览环境（WorkBuddy 内置网页预览）= 远端模拟器，只实现了微信接口**子集**：已知**缺 `wx.createSelectorQuery`**，且不保证 `getWindowInfo`/`getSystemInfoSync`/`showToast`。因此**任何依赖 wx 的能力都要先探测再降级**，不能靠报错兜底。

## 3. 目录结构

```
app.js / app.json / app.wxss      小程序入口；app.json 顶层必须保留 lazyCodeLoading
pages/landing/                    首页：四张模式入口卡片 + 设置入口 + 调试面板（纯入口，不含棋盘逻辑）
pages/placeholder/                占位页：学习/设置 尚未落地时的过渡页
pages/analyze/                    分析模式 page：analyze.{js,wxml,wxss,json}
                                  布局：唯一的固定元素是棋盘（view 网格，留在上半屏），
                                  状态/控制按钮与 Tab 内容同属一个 scroll-view 整体划动（Tab 内部不再各自滚动），
                                  底部 Tab 栏钉住：引擎分析 / AI教练点评 / 走子记录（5→3 Tab，见方案 §9）。
                                  状态条已压成单行、优势只显示数值（不画进度条）。
                                  棋盘尺寸按窗口高度约一半做上限，保证留在上半屏。
pages/play/                       对弈 page：玩家 vs 陪练（引擎出着）+ 自动分析/点评门控（L2-T6）
pages/replay/                     打谱 page：PGN 导入 → 走法树回放（主线+变例）→ 每步引擎标注 + 点评分支演示（L2-T7）
                                  棋盘只读；走法记录可点定位；当前局面有多条续着时出现「分支」chips。
utils/
  chess.js                         chess.js 0.10.3 本地副本 + 末尾追加 raw_* 扩展（见 §5）
  engine.js                       端上 Alpha-Beta 引擎，analyze() 是对外契约（见 §4）
  remote-engine.js                云端引擎适配层：POST /v1 → 同一份契约 + 失败回落本地（见 §4.1）
  game.js                         棋局状态管理（载入/FEN/走子/悔棋/终局/自由模拟双方）
  board-model.js                  棋局状态 → 棋盘视图数据（纯函数）
  geometry.js                     坐标换算（cell↔square、亮暗格、行列）
  ai-client.js                    分析门面 + 分数格式 + 云端点评请求
  cloud.js                        云服务客户端单点初始化（懒加载复用）
  cloud-config.js                 云服务 publicConfig（endpoint + publishableKey）
  engine-config.js                引擎端点/开关的外部配置解析（见 §4.2）
  engine-config.build.js          ⚠️ 由 npm run config:engine 从 .env 生成，要提交
  cloud-adapter / diagnostics     wx.request 流式/降级适配、超时看门狗
  text-codec.js                   TextDecoder/TextEncoder 兜底（真机缺失时补）
  device.js                       安全取值：窗口宽度 / Toast / 网络能力探测（逐级降级不抛错）
  debug-log.js                    60 条环形缓冲日志，页面「运行日志」卡片可查
  session-store.js                跨页面全局会话仓库（单例）：持有 Game 实例（对弈/分析）+ Session 走法树（打谱）+ 最近分析，退/进不丢（L2-T3）
  clipboard-import.js             剪贴板自动导入 FEN 共享逻辑（Landing 与分析页共用，L2-T5）
  navigation.js                   页面跳转统一封装：url 候选形式自适配 + 失败显形 + 参数经 store 补齐（见 §6.6）
  pgn-tree.js                     PGN 边界解析：头 + 走法 + 圆括号变例 → 走法树（chess.js 的 load_pgn 会删掉变例，故自解析）
  settings.js                     用户偏好（autoCoach / playCoachScope / playKeyCp / playAs / sparrerLevel），wx storage 静默降级
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

### 4.1 云端引擎（engine: remote，当前默认）

`utils/remote-engine.js` 调自建服务 `POST {endpoint}/v1`（当前 `https://chess.imex.de5.net`，
中国香港机，Stockfish 15.1 进程池 8），**输出同一份契约**，只多 `source` / `engineVersion` /
`remote` 三个字段。调用收口在 `ai-client.js#analyzePosition`，页面只读 `source` 相关的展示字段。

**端点不写死在代码里**，由 `utils/engine-config.js` 解析（见 §4.2）。

- **判错一律看 `body.type === 'error'`**（HTTP 200 也会报错体），不看 statusCode。
- **分数只用 `lines[].scoreCp` / `scoreMate`**（服务端已换成行棋方视角）；顶层 `eval` / `centipawns` /
  `mate` 是白方视角，别拿去直接用。
- **失败必须回落本地且显形**：结果带 `source:'local'` + `degradedFrom`，页面据此显示降级提示
  （`ai-client.js#describeEngineSource`）。不许静默切换。
- **终局 / 非法 FEN 本地前置拦截**，不浪费一次往返。
- **连续失败 2 次即熔断 60 秒**，期间直接走本地，避免每次自动分析都干等网络超时。
- 服务端契约与字段口径：`E:\WorkBuddy\ai-chess-server\docs\05-小程序接入协议.md`（唯一权威）。
- 引擎版本从 `GET /healthz` 取（`POST /v1` 不带 engine 字段），只在首次分析时并行探一次并缓存，
  失败静默——徽标退化成「云端引擎」，**不影响分析**。

### 4.2 端点配置（改地址不要动代码）

小程序运行时**读不到 `process.env`，也读不到 `.env`**（包内没有文件系统、没有 node 环境），
所以「外部配置」= **编译前注入 + 运行时覆盖**两条路，都在 `utils/engine-config.js`：

| 优先级 | 来源 | 怎么用 |
| --- | --- | --- |
| 1 | 代码覆盖 `engineConfig.setEndpoint()` | 联调/测试 |
| 2 | 本地缓存 `wx.getStorageSync('ai-chess.engineEndpoint')` | 真机临时换地址，**不用重新编译** |
| 3 | `.env` → `npm run config:engine` → `utils/engine-config.build.js` | **改地址走这条**（生成文件要提交） |
| 4 | 内置默认 `BUILT_IN_ENDPOINT` | 兜底 |

`.env` 支持 4 个键（模板 `.env.example`，**系统环境变量同名变量优先于 `.env`**，CI 可覆盖）：

```
ENGINE_ENDPOINT=https://chess.imex.de5.net   # 通用/正式
ENGINE_ENDPOINT_DEV=                          # 默认关闭，见下（打开时：http://裸IP:端口）
ENGINE_MODE=remote                           # remote | local
ENGINE_TIMEOUT_MS=10000                      # 留空用默认 10000
```

- 换地址流程：改 `.env` → `npm run config:engine` → 重新编译小程序。
- **`ENGINE_ENDPOINT_DEV` 当前默认关闭（2026-10-22 实测）**：原值 `http://112.121.168.204:8787` 在当前网络下
  TCP 能连上但服务端零响应（开发者工具报 `POST http://…:8787/v1 net::ERR_EMPTY_RESPONSE`）。
  明文 HTTP + 裸 IP 是全链路里最脆的一段（境外 IP 的自定义端口常被中间设备干扰），
  而 `https://chess.imex.de5.net` 同机同进程、证书有效（Let's Encrypt，至 2027-01-14）、实测 `/v1` 200。
  所以开发版改用正式地址：develop 与 release 只在白名单校验上有差别，**不该在链路上分叉**。
  真要回内网 http 调试，在 `.env` 里取消注释并重新生成即可。
- `ENGINE_ENDPOINT_DEV` 只在 `envVersion === 'develop'` 时生效，正式/体验版自动用正式地址——
  **http + 裸 IP + 端口只能在「开发者工具 / 真机调试 + 不校验合法域名」下用**，release 下不可用。
- 地址一律经 `normalizeEndpoint()`：非 http(s) / 空值当没配，回落到下一级，不让拼错的地址把引擎搞挂。
- **排查「连不上云端引擎」先点 Landing 调试面板的「开始探测」**（`utils/engine-probe.js`）：它只读地探
  `GET /healthz` + `POST /v1`，把状态码/耗时/宿主 errMsg 逐行显形，并按 `path not allowed` /
  `not in domain list` / 403 / 超时分类给结论。四个宿主的失败原因完全不同，别靠猜。
- 发布前记得在 mp 后台把正式域名加进 **request 合法域名**。本项目要加**两个**：
  `https://chess.imex.de5.net`（云端引擎）与 `https://mp-api.app.workbuddy.host`（云服务 / AI 点评）。
  少加后者 = 引擎正常、点评永远失败，而报错只显示「网络连接失败」（已在此分类里单独识别并点名域名）。

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

### 6.6 页面导航（预览运行时的 url 解析差异）
- **不要直接调 `wx.navigateTo`**，统一走 `utils/navigation.js#navigate(url, {host, onFail})`。
- 起因：内置预览里 `navigateTo` 报 `navigationTo: fail 未找到页面`，连主包 `pages/placeholder` 也找不到。四种 url 形式（带 query / 去 query / 相对路径 / 相对去 query）**在预览里全部失败**，而真机一直正常。
- **结论：项目已放弃分包（2026-10-22 晚）**。三个模式页 `pkg-*` 已移入主包 `pages/analyze|play|replay`，`app.json` 不再有 `subPackages`。**不要再加回分包**，直到确认预览支持分包导航；加模式 = 在 `pages/` 下加一个页面 + 在 Landing 注册一张卡片。
- 处理方式仍是「**候选形式依次尝试**」：原样 → 去 query → 相对路径（去前导 `/`）→ 相对路径去 query → 兜底 `redirectTo` / `reLaunch`；任一成功即停。**全部失败必须回调 `onFail` 并显示在界面上**（Landing 顶部有「这个入口没打开」卡片 + 复制详情），不许静默。
- 参数不能丢：一旦走了「不带 query」的形式，query 解析结果写进 `sessionStore.setPendingParams()`，目标页 `onLoad` 第一行用 `navigation.mergeLaunchOptions(options)` 取回（一次性语义，显式 options 优先）。**新增页面若读 `options.xxx`，就必须加这一行。**
- 环境既不回调 `success` 也不回调 `fail` 时，只上报一次（`NO_CALLBACK_MS`），**不再盲试下一个 url** —— 可能其实已经跳走，重试会重复跳页。
- `onSuccess({url,attempts,via})` 会报告「第几种形式成功」，Landing 把它写进运行日志：**这是判断宿主差异的唯一证据**（原生应是「第 1 种形式」，预览若退到第 2/3 种就说明它对 query 或前导 `/` 挑剔）。
- **Landing 底部有「调试」入口**（默认收起）：运行日志 + 10 个宿主接口的能力探测（`navigateTo`/`redirectTo`/`setClipboardData`/`setEnableDebug` 等，✗ 表示宿主没实现）。预览面板没有可翻看的控制台，这里是唯一出口；日志块与错误详情都带 `user-select`，**预览常常没有剪贴板接口，复制按钮无效时必须靠长按选中**（按钮会显形提示，不许无反应）。

### 6.7 组件样式边界：`apply-shared` 会让页面样式漏进组件
- 5 个 L1 组件统一 `styleIsolation:"apply-shared"`（为了能用 `app.wxss` 的全局原子类），代价是**页面 wxss 也会作用到组件节点上**。
- 所以**组件内部使用的类名必须带组件前缀**：`comment-card` 用 `.cc-seg`、`board-view` 用 `.board-grid`。裸类名（`.seg`、`.grid`）一旦与某个页面的同名规则撞上，就会静默改掉组件外观。
- 真实回归（2026-10-23）：`comment-card` 的点评片段用裸 `.seg`，被 `pages/play.wxss` 的分段控件（`display:flex` + 底色 + 边框）命中，**正文里每个走法/文字片段都单独占一行**，看上去像被拆成了列表。
- `analyze-page.test.js` §11.1 有「类名跨层重名守卫」：组件 wxml 用到的类名不得与任何页面 wxss 的类名重名（`app.wxss` 的全局原子类例外）。新增组件类名先想清楚归属层。
- 片段拼接还有两个配套细节：`.coach-text` 等容器用 `white-space: pre-wrap` 保住片段之间的空格；内层 `wx:for` **紧贴父标签书写**，否则模板缩进会渲染成空行。

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
- **四条保底通道不依赖网络：规则判定、走法生成、演示线、本地评分。** 任何环境下都必须可用
  （关掉网络也要能用），不要把其中任何一条和云端能力绑在一起。
  注意这条约束的是**可用性**，不是强度：见 `docs/能力开关与功能矩阵.md` §1.1——
  本地是一个**弱引擎**（业余棋力），它的定位是冻结的基线而非待优化项，
  维护成本约等于零，`engine: remote` 接通后自动让位。

## 9. 测试与质量门禁

`.workbuddy/tests/` 下是纯 Node 脚本（打桩最小 wx/Page/云 SDK），直接用 node 跑：

```bash
node .workbuddy/tests/engine-and-game.test.js   # raw 接口一致性、规则层、终局、引擎输出与超时降级
node .workbuddy/tests/analyze-page.test.js      # 页面初始化、走子(拖/点)、历史、FEN、自动分析、云端点评与错误分支、模板可渲染性静态守卫
node .workbuddy/tests/cloud-adapter.test.js     # UTF-8 编码、原生分块透传、降级、中止探测不判负、看门狗等
node .workbuddy/tests/agent-tools.test.js       # 阶段一工具层与演示线落地
node .workbuddy/tests/remote-engine.test.js     # 云端引擎：字段映射、分数视角、终局拦截、回落显形、熔断
node .workbuddy/tests/engine-config.test.js     # 端点外部配置：优先级、地址规整、develop/release 分流
node .workbuddy/tests/session.test.js           # L0 走法树：主线/分支/导航/节点缓存/PGN 边界
node .workbuddy/tests/pgn-tree.test.js          # PGN 边界解析：头、变例、注释/NAG、非法输入、灌入 Session
node .workbuddy/tests/play-page.test.js         # 对弈页：走子护栏、sparrer 回着、点评门控、撤销
node .workbuddy/tests/replay-page.test.js       # 打谱页：PGN 导入、逐步回放、分支切换、节点缓存、点评演示、跨页面恢复
node .workbuddy/tests/landing.test.js           # Landing 卡片导航 + 剪贴板导入
```

- 改完引擎或页面后**跑这几套，全绿再交付**。
- **页面回归默认把引擎开关锁成 `local`**（`ai.setEngineMode('local')`）：打桩的 `wx.request`
  永远不会回调，走 remote 会让整个页面挂在 `await` 上、进程静默退出。远端路径由
  `remote-engine.test.js` 与 `analyze-page.test.js` 第 13 节（自带可控 wx 打桩）覆盖。
- `analyze-page.test.js` 的打桩环境**故意不提供** `createSelectorQuery`/`getWindowInfo`/`getSystemInfoSync`，重新引入这些接口会当场红。
- 实网探针（需网络、消耗少量云服务额度，**不属常规回归**，按需跑）：
  - `cloud-live-probe.js`：真实云服务 + 模拟「不支持分块流式」的 wx，验证点评链路端到端。
  - `cloud-model-probe.js`：用真实提示词跑一次，看实际服务模型/耗时/请求明细。
  - `cloud-model-bench.js [模型id ...]`：逐个比候选模型耗时（选型结论靠它复现）。
  - `cloud-realdevice-probe.js`：模拟「原生分块可用 + 无全局 TextDecoder」的真机形态，跑真实云服务验证真机链路。
  - `remote-engine-live-probe.js`：真连 `ai-chess-server`（含杀棋/终局/服务不可达回落），验证云端引擎端到端。不消耗云服务额度，只消耗自建服务算力。

## 10. 常见任务指引

- **改棋盘渲染**：动 `board-model.js`（视图数据）与 `analyze.wxml/wxss`。遵守 §6.1–§6.4；坐标换算走 `geometry.js`。
- **改引擎**：端上只动 `utils/engine.js`，云端只动 `utils/remote-engine.js`，两边都保持 `analyze()` 输出契约（§4 / §4.1）。内部用 `raw_*`，别在搜索树里生 SAN。
- **换云端引擎地址**：**改 `.env` 再跑 `npm run config:engine`**（见 §4.2），不要直接改代码。
  调试期临时换可以运行时 `remoteEngine.configure({ endpoint })` 或改本地缓存
  `wx.setStorageSync('ai-chess.engineEndpoint', 'https://…')`（真机免重新编译）。
  **不要**把引擎地址写进 `cloud-config.js`——那是云服务 LLM 的凭据位。
- **改云端点评**：动 `ai-client.js`（提示词/模型/超时/重试）与 `cloud-adapter`（看门狗/降级）；配置在 `cloud-config.js`。遵守 §7，发布前在微信开发者工具执行「构建 npm」。
- **加新页面/功能**：页面内自查状态，新页面加进 `app.json#pages`，保留 `lazyCodeLoading`。
- **判断"某个功能在当前环境能不能用"**：查 `docs/能力开关与功能矩阵.md`。能力由**三个独立开关**
  决定——`engine: local|remote`（端上 JS 引擎 / 远程 Stockfish）、`cloud: off|on`（有无原生云）、
  `llm: off|light|heavy`（大模型参与度）。**每个功能点按自己依赖哪个开关渲染**，不要问"全局是第几档"。
  L0~L4 那种线性档位已废弃，文档或代码里出现即视为笔误。`engine` 用 `remote` 不用 `cloud`
  （后者已被"微信原生云"占用，且远程引擎不止一种实现）。
- **排查真机/预览问题**：先看界面「运行日志」卡片（环形缓冲）；`onToggleEnableDebug()` 走 `wx.setEnableDebug` 打开真机调试面板（重进小程序才生效）。
- **Agent 化（Tutor / Sparrer）**：先读 `docs/agent-plan.md`（角色定义、术语表、冻结契约、决策记录），
  再按阶段读 `docs/agent-phase1-tutor.md` / `agent-phase2-react.md` / `agent-phase3-memory.md`。
  **改 Tutor 界面/文案前先读 `docs/agent-tutor-interactions.md`**（六条交互第一性原则、三个阶段共用的
  会话状态机、错误文案口径表 §8）；它不重复阶段的机制设计，只约束「用户看到什么、能做什么」。
  四条跨阶段铁律：**走法只能由 chess.js 产生**（LLM 只输出意图/候选编号，不拼写 SAN）；
  工具层跑在端上（`utils/tools.js`，用 `raw_*`）；工具结果压缩后才回传模型；
  **内部数据一律 `FEN + UCI`，PGN 只在导入/导出的边界各转换一次**（plan §4.4）。
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
- 四条保底通道（规则判定 / 走法生成 / 演示线 / 本地评分）不依赖网络；本地是**弱引擎**不是没引擎，别写「无引擎 / 无法分析」。
- 改完跑三套测试，全绿再交付。
