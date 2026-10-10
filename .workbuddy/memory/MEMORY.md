# 项目长期约定（ai-chess-wxapp）

## 角色命名（用户拍板，2026-10-07）

| 中文 | 英文 | 标识符 | 状态 |
|---|---|---|---|
| 教练 | Tutor | `tutor` | 本轮聚焦（阶段一~三） |
| 陪练 | Sparrer | `sparrer` | 占位，未立项 |

- 拼写：`sparer` 才是词典常见形式，本项目**统一双写 r = `sparrer`**，当术语固定。
- **不用 `opponent` / `rival`**。`opponent` 的目的是赢你，用它命名会让产品不自觉往"提高胜率"
  优化，结果用户每局被虐；`sparrer` 的目的是让你练到东西。命名会影响每个 design trade-off。
  （`opponent` 仍可作普通名词指棋局对方，但不指本产品角色。）
- 阶段三代号：`Persistent Tutoring Memory`（原 `Coaching Memory` 已改）。

### 既有 `coach` 标识符不重命名

`COACH_SYSTEM_PROMPT`、`utils/coach-demo.js`、`onCoach`、`coachText`、`ai.requestCoachComment()`
全部保留——改名收益低、回归风险高（`coachText` 是 setData 键名，牵动 WXML）。
原则：**新增代码一律用 `tutor`/`sparrer`，既有的不动**。要避免的是新代码里同概念两种叫法。

## 数据格式约定（2026-10-08 定）

- **内部一律 `FEN + UCI`**（演示线、分支树节点、错题索引）。不用 PGN 存内部状态。
- **PGN 只在进出边界各转换一次**：导入（用户贴外部棋谱，`load_pgn`）／导出（复制分享，`pgn()`）。
- 不用 PGN 当内部主键的功能性理由：同一局面经不同走子顺序到达时 PGN 不同但 FEN 相同，
  会导致阶段三错题去重失效（同类错误记成多条）。
- **不采用 PGN 作为 LLM 输出格式**：PGN movetext = SAN + 回合号，与 `moves` 数组等价，
  幻觉风险不变，解析反而更难（易位/注释/NAG/变体括号/结果标记），且数组可精确截断。
- `utils/game.js` 的 `Game` **未暴露** `pgn()` / `loadPgn()`，需经 `this._chess` 或新增转发。

## 回归测试门禁

`.workbuddy/tests/` 四套，共 454 项断言。跑法（用 managed node 绝对路径）：

```
node .workbuddy/tests/engine-and-game.test.js   # 153
node .workbuddy/tests/analyze-page.test.js      # 185
node .workbuddy/tests/cloud-adapter.test.js     # 68
node .workbuddy/tests/agent-tools.test.js      # 48（阶段一新增）
```

零依赖（`_harness.js` 是自写的极简断言工具）。`analyze-page` 对机器负载敏感——
等待一律用 `waitFor()` 轮询（超时 15s），**不要写死 `sleep`**，否则慢机器上偶发假绿。

## 阶段一 · Candidate Grounding（2026-10-08 完成）

把演示线从「模型凭空生成 SAN」改成「模型提意图（cand 编号 + extend 手数）→ 端上生成合法序列」。
落地清单（对应 `agent-phase1-tutor.md §7`）：

- 新增 `utils/tools.js`：`legalMoves(fen,{only,limit})` 与 `expandLine(fen,moves,{depth,extend})`。
  内部走 `raw_*`，SAN 只在返回处生成一次；不 import 页面/wx。`expandLine` 用引擎最佳应对续手（非随机）。
- `utils/ai-client.js`：新增 `buildToolContext(fen,result,{topN})`（复用 `_lastResult`，零额外搜索；
  候选≤8、文本≤400 token、显式保留一个劣手候选）与 `groundDemoLines(text,candidates,fen)`（cand+extend→真实 moves，
  就近纠正、兼容旧 `moves`、损坏 JSON/终局降级）。`COACH_SYSTEM_PROMPT` 删除合法性教条，改为 cand/extend 协议；
  `buildUserPrompt` 追加候选段。
- `utils/coach-demo.js`：`resolveMoves` 追加可选第六参 `whitelist`（前向兼容钩子，现有逻辑不变），并导出。
- `pages/analyze/analyze.js`：`onCoach` 请求前 `buildToolContext` 取候选，请求后 `groundDemoLines` 落地，再交给 `parseDemo`。
- 关键设计：**候选续手优先复用候选自带 PV（零额外搜索，D4）**，PV 不够长才用 `expandLine` 兜底；
  `chess.move()` 不接受 UCI 字符串，tools 里 `applyMove()` 把 UCI 转成 `{from,to,promotion}` 对象。
- 既有 `coach` 标识符一律保留（见上方命名约定）；新增函数名按契约（`buildToolContext`/`groundDemoLines`），
  未引入 `tutor` 前缀——因为阶段一契约在 `agent-plan.md §6` 已锁死这些工具层函数名。

## 规划文档

`docs/agent-plan.md`（总纲：术语表 §1.2、命名对照 §1.4、冻结契约、决策 D1~D10）
+ `agent-phase1-tutor.md` / `agent-phase2-react.md` / `agent-phase3-memory.md`
+ `agent-tutor-interactions.md`（**交互总览**：六条第一性原则、会话状态机、§8 错误文案口径表）。
阶段文档讲机制，交互文档讲「用户看到什么」——**改 Tutor 界面/文案前先读它**。

用户要求：阶段二、三**不写函数级改造清单**，只留契约 + 待决策项 + 验收口径（代码会变）。

## 交互设计的三条硬结论（详见 interactions §1、§5）

- **不做聊天窗口**：挤占棋盘 + 与本页「Tab 内不再各自滚动」架构冲突。用同 Tab 内对话卡片流。
- **Tutor 必须能「指」棋盘**（move/sq/piece 三类记号 + focus 高亮），否则与通用大模型无差异。
- **三个阶段都不新增底部 Tab**（5 个已是小屏上限）；消息数 ≤ 3 轮，`scroll-into-view` 可用。

## 云服务接入惯例（2026-10-08 定）

- 应用「生成点评」等 LLM 功能依赖真实云端：凭证只在 `utils/cloud-config.js` 的 `publicConfig`
  （`endpoint` + `publishableKey` 可随前端发布，**不**放长期密钥/环境 id/服务端凭据）。
- **隐蔽回归点**：每次「重建 / 重发应用」之后，代码里的 `publishableKey` 前缀**不会自动跟着变**，
  仍停留在上次构建写入的旧 applicationId。必须人工核对前缀 == 当前 applicationId，否则 LLM 调用
  落到旧账号/旧环境（失败或扣错额度）。
- 接入四步闭环：**开通（reuse 指定 appId）→ 改凭证指向 → 隐私清单 → 真实探针**。
- 「测试全绿 ≠ 云可用」：单元测试只 mock 配置、覆盖逻辑，真实数据面必须靠一次性真实探针验证，
  探针用完即删。详见 `docs/云服务接入经验总结.md`。
- 隐私清单按需声明：先 grep 仓库用到哪些 `wx.` 隐私接口（本项目仅 `Clipboard` / `wx.setClipboardData`），
  最小集合声明，避免微信审核被拒。

## 待办

- 【已修复 2026-10-08】`DemoSession.view()` 字段名与 WXML 不一致：原返回 `active/canBack/canForward/playing/breadcrumb`
  （未加 `demo` 前缀），而 `analyze.wxml` 读 `demoActive/demoCanBack/demoCanForward/demoPlaying/demoBreadcrumb`，
  导致 `setData(this.demo.view())` 后这五个页面 data 字段永远是 `data()` 默认值、演示控制条
  （上一步/下一步/播放/退出）永不激活。已在 `coach-demo.js view()` 把五个键改名为 `demo*` 前缀，
  对齐页面 data 约定（页面 data() 本就初始化 `demoActive/demoCanBack/...`）；`analyze-page.test.js`
  的缺陷钉（断言旧字段 `active` 存在）改为修复验证（断言 `demo*` 产出且旧名 `active` 不再出现）。
  全套回归仍绿（454 项）。

## 能力开关 Capability Switches（2026-10-10 定稿）

**定稿：用三个独立开关，不用 L0/L1/L2/L3/L4 这类线性档位（已废弃，不再使用）。**

**规格文档：`docs/能力开关与功能矩阵.md`**（开关定义 + 功能矩阵 + 三条铁律 + 接入点），
决策编号 `agent-plan.md` §6 的 D12/D13；`AGENTS.md §10` 有指引条目。

| 开关 | 取值 | 含义 |
|---|---|---|
| `engine` | `local` \| `remote` | 端上 JS 引擎 / 远程 Stockfish |
| `cloud` | `off` \| `on` | 有无原生云（DB / 存储 / 题库下发） |
| `llm` | `off` \| `light` \| `heavy` | 大模型参与度 |

- **`engine: remote` 是后续升级项**，两条实现路径：managed container（微信云托管）或 VPS（自建），
  详见下两节。当前一律 `local`。
- **`remote` 不用 `cloud`**：`cloud` 已被「微信原生云/云开发」占用；远程引擎实现路径不止一种
  （云托管容器 / 自建 VPS / 第三方 API），`remote` 只表达"不在端上跑"。
- 矩阵中 **`off` 不单列**（off 是基线，单列没有信息量）；图例 ● 完整 / ◐ 降级 / ○ 缺失 / — 不由该开关决定。
- **措辞铁律（2026-10-10 补）**：不许说「本地没有引擎」，要说「本地有一个弱引擎」。
  `engine` 开关调的是**强度**（弱/强），不是**有无**——两端都有引擎。
  拆三层：规则层（chess.js，零误差，不受开关影响，不是引擎是地基）／搜索+评估层
  （`utils/engine.js`，启发式，这才是开关在切的）／输出层（三条线、scoreCp、PV，是结果不是能力）。
  **规则判定 = 事实**（可断言"这步不合法"），**引擎评分 = 意见**（只能说"引擎认为…"），
  界面必须分层，否则用户会把本地引擎的启发式评分当确定性事实。
- **为什么不用单一档位**：真实最常见的组合是 `cloud on + engine local + llm light`
  （有云、有大模型、没 Stockfish）——线性阶梯里没有它的位置，按档位判定会把点评入口误隐藏。
  **每个功能点按自己依赖哪个开关渲染**，不要问"全局是第几档"。

三条铁律：

1. **走子、判定、评分、演示线全部 L0 完成**——离线不是残废模式，缺的只是"语言"。
   离线时界面不许空，要显示"功能都在，只是不讲话"。
2. **调 LLM 的开关不是「走了一步」，而是「出现值得讲的信号」**：分数跳变超阈值 / 终局 /
   用户主动提问 / 答错题目。触发后仍受预算约束（次数上限 + 冷却）。**不做每步点评**。
3. **降级必须显形**：提前在界面说明当前缺哪个能力、点了会怎样，不要等按钮点下去才报错。

两个硬事实：

- **本项目没有 Stockfish**（端上纯 JS Alpha-Beta，业余棋力）。所以「逐手评分找漏招」与
  「AI 棋力」两项**不受 llm 开关影响，也不受 cloud 开关影响，只受 `engine` 影响**——
  开到 heavy LLM 也救不了，只有 `engine: remote` 能救。
- `cloud: on` 买的是**连续性**（跨设备存档、画像不丢），不是能力；阶段三记忆层需要 `cloud on`。
- 全 off 时（`engine local + cloud off + llm off`）产品必须仍是完整的：棋盘、走子、三条线、
  演示线、PGN 导入导出、战术题判定与正解播放全部可用，缺的只是"语言"。离线界面不许空。

## 端上分析保底通道（2026-10-10 精确化）

AGENTS.md §8 原话「端上分析在任何环境下都可用」**措辞已精确化**，保证本身不变，收紧的是表述：

> **四条保底通道不依赖网络：规则判定、走法生成、演示线、本地评分。任何环境下都必须可用。**

要点：**约束的是可用性，不是强度**。端上引擎（`utils/engine.js`）是**冻结的基线，不是待优化项**——
维护成本约等于零，`engine: remote` 接通后自动让位。不要再往里投资源。

术语「保底通道 / Fallback Path」已进 `agent-plan.md` §1.2 术语表，全项目统一；
AGENTS.md §8 / §11、`plan §5 表第 6 行`、`plan §7.1 第 3 条`、
`agent-phase1-tutor.md R6`、`agent-phase2-react.md R4`、`agent-phase3-memory.md`、
`能力开关与功能矩阵.md §6` 已全部同步。

**背景（为什么不能放宽）**：2026-10-10 讨论过「用轻量 LLM 替代端上分析」，已否决。
三条理由：① LLM 触发信号「分数跳变超阈值」依赖本地评分，没有它就只能每步都问 LLM
（退回 chess_tutor）；② 评分是不可验证输出——走法错了还有 `resolveMoves` 兜底，评分错了没有校验器，
且 LLM 输出不可复现，无法跨局比较、排不出稳定 MultiPV 序；③ 工具层会从零延迟变成网络往返，
`plan §4.1` 的 ReAct 预算模型会崩（一轮三次工具调用 10~30s）。

**实测耗时**（本机 node 22，multiPV=3）：起始局面 depth2/3/4 = 396 / 415 / 793ms；
中局 = 1294 / 2128 / 4457ms。对照组 LLM 单次往返 3~10s（`plan §5.1`）。端上快 3~25 倍、零成本、离线可用。
页面默认 depth=2；`ai-client.js:419` 的 `groundDemoLines` 默认 depth=3。

**可行，形态是「微信云托管」容器服务，不是插件**。已核实的事实：

- 现有 WorkBuddy 云服务（wbapp_Q0BvUcC34QxiYVHs0aFeay）是 BaaS，**不能**跑原生二进制；
  微信小程序"插件"是前端复用机制，也不行。必须另开云托管环境，Dockerfile 装 Stockfish，
  用 `wx.cloud.callContainer` 内网直连（免备案、免公网流量费、防 DDoS）。
- **刊例价**：CPU 0.055 元/(核·小时)、内存 0.032 元/(GB·小时)；**实例缩容到 0 不计费**；
  首环境送 3 个月免费额度（CPU 720 核·小时 / 内存 1440 GB·小时）。
  粗算每天 500 次分析 × 2 秒 CPU ≈ **不到 2 元/月**。
- **雷区**：云托管 Serverless MySQL 0.342 元/(个·小时) ≈ 250 元/月（有读写就产生）——别用，
  改用云开发 NoSQL 或对象存储。
- **性能**：用 `go movetime 1000~2000` 而不是 `go depth`（时间预算可控）；0.5 核容器约
  depth 15~20；MultiPV 默认 1、需要对比才开 3。缩容到 0 后冷启动 1~3 秒，需预热引擎进程。
- **GPL 问题在服务端方案下消失**：GPLv3 传染性来自"分发二进制"，把 stockfish.js 打进小程序
  才算分发（这是当初选型文档判它死刑的原因）；**仅服务端运行 + HTTP 调用不触发开源义务**
  （GPLv3 无 AGPL 的网络条款）。前提：任何 GPL 代码都不进小程序包。

**何时开**：现在不开（零用户 + 沙盘/闯关用不到 + 新增运维面）。触发条件 = 复盘或陪练立项。
**现在要做的准备**：在 `utils/ai-client.js`（现成的分析门面）按 `engine` 开关选择实现，
保持 `analyze()` 契约不变（AGENTS.md §4），云端失败/超时**必须回落端上引擎**——
"端上分析任何环境都可用"是硬要求。
待核实：云托管开通是否受小程序主体类型限制；`wx.cloud.init` 与现有云服务 SDK 的初始化顺序。

## 自建 Stockfish 服务 vs 云托管（2026-10-10 查证）

用户提出第二条路：自建服务器跑 Stockfish。**已核实的关键事实**（官方文档）：

- **云托管免域名免备案**（`callContainer` 走微信私有协议，无需在 mp 后台配服务器域名）；
  **自建必须**：已 ICP 备案的 HTTPS 域名 + 后台配 request 合法域名 + TLS≥1.2 +
  不能用 IP/端口（端口配了就绑死）。备案 7~20 个工作日。
- **云托管硬约束**：仅 HTTP（不支持 tcp/udp/mqtt）、**不支持公网 IP 访问**、
  `CallContainer` **超时 ≤15s**、请求体 ≤100K、容器无持久化存储、不支持 Docker Compose、
  默认公网域名性能有限制**不可用于生产**。
- **冷启动是云托管的致命项**：最小副本设 0 → 半小时无请求缩容到 0，再请求重启；
  官方说"耗时由启动速度决定"，实测社区反馈 **20~40 秒**。解法是把最小副本设为 1，
  但那就持续计费：**0.25核0.5G 常驻 ≈ 21.7 元/月 ≈ 260 元/年；1核1G 约 63 元/月 ≈ 760 元/年**。
- **0.25 核对 Stockfish 偏弱**（引擎要 depth 15~20 至少 1 核）。要算力就得加规格，成本逼近自建。
- **自建成本**：轻量 2核2G 首年活动价 38~79 元/年，**续费通常是首年的 3~5 倍**（≈300~500 元/年），
  域名 30~60 元/年，SSL 免费。长期 ≈ 300~600 元/年，但**算力是 2 核、无冷启动、还能顺带跑
  题库 API / 用户系统 / 订单 / PGN 存储 / LLM 代理**，边际成本为零。
- **自建的额外代价**：自己 code2session 拿 openid（要保管 AppSecret）、SSL 续期、
  公网暴露必须做限流防刷（否则 CPU 被打满）、自建监控。
  **简化办法**：引擎服务做成**无状态、无登录的纯函数服务**（FEN 进、评估出），
  只做 IP/频率限流，AppSecret 都不用碰 —— 鉴权复杂度可拉回与云托管同量级。
- **多端复用**是自建的独有价值：云托管绑定微信生态，自建可同时服务 Web/H5/App。
  ⚠️ 但做 Web 版时**绝不能把 wasm 版 Stockfish 打进前端**——那构成"分发"，GPL 复活；
  Web 端也必须走同一个 API。
- **GPL 结论两端相同**：只服务端运行不触发传染，前提是不分发二进制。

**当前判断**：零用户阶段两者都不建。真要做时**倾向自建**——因为冷启动与算力两项把云托管的
成本优势抵消掉了，而商业化项目迟早要有一台可控后端（用户系统/题库/付费），自建的边际成本为零。
无论哪条路，`utils/ai-client.js` 的引擎适配层不变。
