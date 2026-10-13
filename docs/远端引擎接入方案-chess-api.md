# 远端引擎接入方案：chess-api.com（第三方 Stockfish API）

> 制定日期：2026-10-13 · 状态：**方案待评审** · 关联文档：`能力开关与功能矩阵.md` §5（`engine: remote` 的第三条路径）
>
> 本文只给**契约、决策点、待核实项、验收口径**，不写函数级改造清单（代码会变，契约先锁）。

---

## 0. 结论摘要

1. **服务本身可用、免费、免 Key**：`POST https://chess-api.com/v1`（REST）或 `wss://chess-api.com/v1`（WebSocket），  
   无需鉴权、无文档化限流；实测单次分析 0.4~0.9 秒（100ms 思考预算）。
2. **MultiPV（三线）只有 WebSocket 能给**：REST 的 `variants` 与 `searchmoves` 均被**静默忽略**（实测，见 §1.3），  
   无法用 REST 模拟三条线；WS 的 `variants=3` 会按 multipv 1/2/3 分线流式推送。
3. **最大阻塞项不是技术，是域名备案**：大陆主体小程序的 request / socket 合法域名要求 ICP 备案，  
   chess-api.com 是境外个人运营服务（nginx/Ubuntu + Express，无 CDN），**几乎确定未备案** →  
   正式版不能直连，必须走代理或境外主体。
4. **建议定位**：`engine: remote` 的第一块落点，兼作未来陪练（sparrer）的走子来源；  
   **不替代本地引擎**——远端失败自动回落本地（AGENTS.md §8 铁律不变）。
5. **建议路线**：期一以「不校验合法域名」在开发者工具/真机完成联调（0 成本）；  
   期二按小程序主体类型二选一：境外主体直连 / 大陆主体走微信云托管轻代理（约 22 元/月）。

---

## 1. 实测事实（2026-10-13，curl + node WebSocket 客户端）

> 沙盘网络走透明代理，服务器真实 IP 与归属未能核实（见 §7 待核实）。以下行为均在本机实测复现。

### 1.1 REST：`POST https://chess-api.com/v1`

**请求**（`Content-Type: application/json`，无鉴权头）：

```json
{
  "fen": "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
  "variants": 3,          // max 5，default 1 —— 实测被忽略
  "depth": 12,            // max 18，default 12
  "maxThinkingTime": 100, // max 100(ms)，default 50 —— 更大的值属于捐赠者档位
  "searchmoves": "",      // 实测被忽略
  "taskId": ""            // 实测不回显（服务端自建）
}
```

**响应**：HTTP 200 + **单个 JSON 对象**（即使 variants>1）。字段：  
`text, fen, type("move"/"bestmove"), depth, move(UCI), eval(白方视角, pawn), centipawns(字符串),
mate(字符串), continuationArr(PV, UCI 数组), debug(原始 Stockfish info 行), winChance(0~100),
taskId, turn, color, piece, from, to, san, flags, lan, fromNumeric, toNumeric,
isCapture/isCastling/isPromotion/promotion/captured, continuation(前两手解析版)`

**错误形态（坑）**：**HTTP 200 + body 报错**，`{"type":"error","error":"INVALID_FEN","text":"..."}`。  
已见三种：`INVALID_FEN`（字段不足）、`INVALID_INPUT`（缺 fen）、  
`Cannot evaluate given position - wrong FEN`（轮非行棋方被将军等非法局面）。  
→ **判错必须看 body.type，不能看 statusCode。**

### 1.2 WebSocket：`wss://chess-api.com/v1`

- 连接后服务端先推 2 条 `{"type":"log",...}` + 1 条 `{"type":"info","text":"Waiting for engine. You are #1 in public queue."}`  
  （**公共队列**，高峰要排队——超时要容忍）。
- 客户端发同一份 JSON（带 variants）。
- 随后按深度流式推 `{"type":"move",...}`：**同一 depth 下每个 multipv 一条**，  
  消息体**没有 multipv 字段**，只能从 `debug` 文本用 `/multipv (\d+)/` 解析。
- 收尾一条 `{"type":"bestmove",...}`，**只含 multipv 1** 的完整结果。
- **同一连接可连续发多次分析**（实测第二次正常返回）。
- 实测时序：connect 574ms → 首条 move 832ms → bestmove 906ms（depth 12 / 100ms 预算）。

### 1.3 关键行为表（对集成有直接影响）

| 行为                    | 实测事实                                                                                         | 对集成的影响                            |
| --------------------- | -------------------------------------------------------------------------------------------- | --------------------------------- |
| `variants`            | REST 忽略（仍回单对象 multipv 1）；**WS 生效**（1~5）                                                      | 三线必须走 WS                          |
| `searchmoves`         | 完全忽略：起始局面排除 e2e4 后仍返回 e2e4                                                                   | 不能用来模拟 MultiPV，排除法死路              |
| `eval` / `centipawns` | **白方视角**（黑方亏后且轮黑走 → `+6.74`，"White is winning"）                                              | 必须换算成行棋方视角才能进现有契约                 |
| `mate`                | **白方视角**、类型是**字符串**（`"1"` / `"-1"`），此时 eval 钳到 ±100                                          | 换算 `parseInt × (turn==='w'?1:-1)` |
| 浅层 PV                 | depth 1 的 move 消息 `continuationArr` 为空数组                                                     | 收集时跳过空 PV，别把空 PV 当最新值             |
| 终局局面                  | **不校验**：已将被死的局面仍返回"最佳着法"（g7g5，非法着）； stalemate 报 `extendMoveInfo: move must not be undefined` | 本地前置判终局，终局不发远端                    |
| 非法局面                  | 轮非行棋方被将军 → body error `wrong FEN`                                                            | 本地 FEN 校验前置（chess.js 已有）          |
| 限流                    | 无文档、无响应头；10 连发全部 200，每次 ~0.75s                                                               | 仍要做客户端节流（善意使用，见 D17）              |
| `taskId`              | 服务端自建，**不回显**请求值                                                                             | 关联只能靠「单连接串行」                      |
| 运营方                   | 个人项目（ChrisC，PayPal 捐赠），服务端跑 Stockfish 18                                                     | 无 SLA → 本地回落是硬要求，不是优化项            |

---

## 2. 与现有架构的对接

### 2.1 接入点（不动冻结契约）

- **门面**：`utils/ai-client.js#analyzePosition` 已是引擎唯一入口（`能力开关与功能矩阵.md` §6.2），  
  按 `engine` 开关分流到本地 / 远端实现，**`analyze()` 输出契约不变**（AGENTS.md §4）。
- **新模块** `utils/remote-engine.js`：对外 `analyze({ fen, depth, multiPV })` 与 `utils/engine.js` **同构**，  
  附加一个 `source` 字段（`'local' | 'remote'`）供界面标注评分来源——只加字段，不改既有字段。
- **开关与探测**：新增 `utils/capabilities.js`（§6.1 已规划的位置）：读 `engine` 当前值；  
  探测 `device.canRequest()` / `wx.connectSocket` 可用性；可选做一次轻量远端探活。  
  页面把 `data.cloudReady / cloudHint` 的同模式扩成 `engineReady / engineHint`。
- **页面**：`doAnalyze()` 主体不动；`analysisMeta` 按 `result.source` 追加速度样  
  （如「深度 12 · 远端 Stockfish · 380ms」/「深度 3 · 本地引擎 · 520ms」），  
  失败回落时同样显形（见 D15）。

### 2.2 字段映射（远端 → 本地契约）

| 本地契约字段                        | 远端来源                           | 换算                                                       |
| ----------------------------- | ------------------------------ | -------------------------------------------------------- |
| `uci` / `san` / `from` / `to` | `move` / `san` / `from` / `to` | 直取                                                       |
| `scoreCp`                     | `centipawns`（字符串）              | `parseInt × (turn==='w' ? 1 : -1)`                       |
| `scoreMate`                   | `mate`（字符串，可 null）             | `parseInt × (turn==='w' ? 1 : -1)`；非 null 时 `scoreCp` 弃用 |
| `pv`                          | `continuationArr`              | 直取（UCI 数组）                                               |
| `pvSan`                       | **本地转换**                       | chess.js 顺序落子生成 SAN（零额外请求，`tools.applyMove` 已有 UCI→对象）   |
| `rank`                        | multipv 序号                     | 1..N                                                     |
| `depth`                       | `depth`                        | 直取                                                       |
| `nodes`                       | `debug` 行 `nodes N`            | 尽力解析，失败记 0                                               |
| `elapsedMs`                   | 客户端计时                          | —                                                        |
| `sideToMove`                  | `turn`                         | 直取                                                       |
| `terminal`                    | **本地算**（`game.js#status`）      | 远端不报终局，也不校验终局                                            |

### 2.3 WS 三线收集算法

1. 每条 `move` 消息按 `debug` 解析 multipv 序号；解析失败的丢弃（只影响 2/3 线，不影响 bestmove 保底）。
2. 每个 multipv 保留「**最新一条 PV 非空**」的消息（浅层空 PV 不覆盖已有 PV）。
3. 收到 `bestmove` → 覆盖 multipv 1，收口返回。
4. 任一 multipv 自始至终没拿到非空 PV → 该线 `pv = [move]`（界面只显示一手，**不编造后续**）。
5. 拿不满 `multiPV` 条 → 有几条出几条（页面对 lines 数量不设死，`buildLineViews` 已兼容）。
6. `onProgress({ reached: depth })` 由 move 消息自然驱动（比本地引擎的进度回调更细）。

---

## 3. 域名与发布路径（最大决策点）

| 路径              | 正式版可用？          | 成本                 | 说明                                                                                                                                                                                                         |
| --------------- | --------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A 直连**        | 大陆主体 ✗ / 境外主体 ✓ | 0                  | `request` 与 `socket` 两个合法域名都要配 `chess-api.com`；开发期用「不校验合法域名」                                                                                                                                               |
| **B 微信云托管反向代理** | ✓               | 常驻 0.25 核 ≈ 22 元/月 | `callContainer` 免域名免备案；容器出口访问 chess-api.com；顺带限流/缓存/可换上游；冷启动风险（最小副本 0 时 20~40s，代理层建议留 1 副本）                                                                                                                |
| **C 自建服务器**     | ✓               | 用户已有（香港）           | **2026-10-13 更新**：用户提供了 `112.121.168.204`（Debian 12，16C/24G，中国香港）。结论：不代理 chess-api.com，改为**在该机直接跑本地 Stockfish**（深度/思考时间/MultiPV 全开放、无第三方依赖），chess-api.com 降为兜底上游。完整部署方案（含安全加固与备案路线图）见 `docs/自建引擎服务部署方案.md` |
| **D 混合（推荐）**    | —               | 期一 0 元             | 期一直连联调；期二域名备案通过后切自建（路线 C），备案受阻则退 B。三者是**同一份契约**，切换只改 `remote-engine.js` 的 baseURL                                                                                                                          |

> 备案结论的把握度：chess-api.com 无 CDN、Server 为 nginx/Ubuntu + Express、运营方为境外个人，  
> 备案概率极低，但**以工信部系统最终查询为准**（§7.2）。

---

## 4. 设计决策（建议编号 D14~D18，评审后并入 `agent-plan.md` §6）

- **D14 WS 为主、REST 为辅。** WS 是免费层唯一的 MultiPV 通道；REST 保留给「只要最佳一手」的场景  
  （未来陪练 sparrer 的走子来源），并作为 WS 不可用时的单线降级。
- **D15 远端失败必须回落本地，且降级显形。** socket/request 失败、超时、body error、拿不满线 →  
  回落 `utils/engine.js`；评分来源随结果下发（`source` 字段），界面标注「本次为本地引擎」。  
  不允许静默切换——用户把启发式评分当确定性事实，正是 `能力开关 §1.1` 要防的事。
- **D16 终局与非法局面本地前置拦截。** 调用远端前 chess.js 校验 FEN + `game.js#status` 判终局；  
  终局不发远端（API 不校验，会把已将死的局面分析出一手非法着）。
- **D17 单连接复用 + 串行 + 节流。**
  - 小程序全局只允许 1 个 socket：连接懒建、分析间复用、空闲 60s 关闭、错误即销毁重建；
  - 连续分析串行（页面 `_analyzePromise` 机制天然串行，不额外造队列）；
  - 同 FEN 结果缓存（LRU ~50 条），来回切 Tab/悔棋不重复打上游；
  - remote 模式下走子自动分析的 debounce 拉长（`AUTO_ANALYZE_DELAY` 调大）+ 每日预算上限  
    （建议 300 次/天，超出回落本地并提示）。理由：免费服务 + 公共队列 + 善意使用。
- **D18 默认请求参数集中为常量**：`depth 12`、`maxThinkingTime 100`（免费上限）、`variants = multiPV`（与 UI 三线一致）。  
  页面深度选择器映射到远端时做钳制（远端只表达思考预算，不表达档位）；  
  捐赠者档位的具体上限拿到后再调（§7.4）。

**自动分析策略**（D17 的附问）：保留走子后自动分析——「逐手评分找漏招」是 `engine: remote` 的核心场景，  
砍掉它 remote 就只剩手动玩具；用 debounce + 缓存 + 预算控制上游压力。若实测上游压力大，再退为仅显式触发。

---

## 5. 小程序平台约束（硬事实）

- **合法域名**：`request` 与 `socket` 两份名单都要加 `chess-api.com`（HTTPS / WSS）；  
  **大陆主体需 ICP 备案**，这是 §3 决策的根源。
- **socket 上限**：`wx.connectSocket` 全局同时最多 1 个；必须 `wx.onSocketOpen` 之后才能 `send`；  
  `onSocketMessage` 的 `data` 可能是 string 或 ArrayBuffer（JSON 文本直接 parse）。
- **预览环境**：WorkBuddy 内置预览只实现 wx 子集，`connectSocket` 大概率缺失 →  
  `capabilities.canSocket()` 探测，缺失即回落本地（与既有 `canRequest()` 同模式，见 AGENTS.md §8）。
- **超时**：`wx.request` 自身 timeout 建议 10s（远端正常 <1.5s）；socket 自建看门狗：  
  连接 10s / 总时长 20s / 消息空闲 8s（收到 info/log/queue 消息重置空闲计时）。
- **隐私**：Socket 与 Request 均不在《隐私接口》清单，不新增声明；只发 FEN，不含个人信息。

---

## 6. 法务与运维风险

- **GPL**：仅 HTTP/WSS 调用、不分发任何二进制 → 不触发开源义务（与 `能力开关 §5` 结论一致）。  
  任何 Stockfish 二进制 / wasm 都不进小程序包。
- **服务方风险**：个人运营、无 SLA、随时可能停 → 本地引擎是产品底线，远端只是增强  
  （「四条保底通道不依赖网络」不受影响）。
- **上游滥用风险**：免费 + 公共队列，被刷可能封 IP → 客户端节流（D17）+ 代理层限流（路径 B/C 的附加价值）。

---

## 7. 待核实清单（按优先级）

1. **小程序主体类型**（个人 / 企业 / 境外）——决定 §3 走 A 还是 B/C。从 `project.config.json` 的 appid 到 mp 后台确认。
2. **chess-api.com 备案状态**——本沙盘 DNS 被透明代理劫持（解析到 198.18.0.250），公开备案查询 API 均不可达；  
   需在有外网的开发机上 `nslookup` + 工信部备案系统核实。预期未备案。
3. **云托管容器访问外网**是否需额外购买/配置 NAT（路径 B 的前提）。
4. **捐赠者档位参数上限**（depth>12、maxThinkingTime>100、variants>5 的档位与价格）——官网只写  
   "available for project supporters"，无价目。
5. **上游限流阈值**——实测 10 连发无 429、无响应头，但无文档；联调时可温和摸到边界，不要刻意压挂。
6. **预览环境 socket 可用性**——联调以微信开发者工具 + 真机为准。

---

## 8. 实施分期与验收口径

### 期一 · 直联联调（不发布，0 成本）

- 落地：`utils/capabilities.js`（开关 + 探测）、`utils/remote-engine.js`（WS 主 / REST 辅 + 映射 + 回落）、  
  `utils/ai-client.js` 分流、页面 source 标注与降级文案。
- 验收口径：
  1. 开发者工具开「不校验合法域名」，三个局面（开局 / 中局 / 杀局）三线分析成功，  
     SAN 全部合法、分数符号正确（含一个轮黑走的亏分局面验证白方视角换算）；
  2. 断网 / socket 失败 → 回落本地三线，界面显形「本地引擎」，无 error 弹窗；
  3. 终局局面点分析 → 不发远端，直接显示终局标签；
  4. 新增 `.workbuddy/tests/remote-engine.test.js`（mock wx socket/request，还原真实行为：  
     onSocketOpen 延迟、按 multipv 分线的消息序列、body 200 报错、超时）：  
     符号换算 / 空 PV 跳过 / REST 单线回落 / 超时回落 / 终局拦截全绿；既有四套 454 项回归全绿。

### 期二 · 域名方案落地

- 按 §7.1 结论选 A/B/C；B/C 时代码只改 `remote-engine.js` 的 baseURL / 容器名（契约不变）。
- 验收：体验版/正式版跑通远端三线；代理层限流生效（模拟 20 连发不穿透上游）。

### 期三 · 可选增强

结果缓存命中率统计、日预算计数与提示、WS 重连退避、捐赠者档位评估。

---

## 9. 附：实测样本（2026-10-13）

**WS 三线消息流**（fen: 意大利开局局面，variants=3, depth=14, maxThinkingTime=100）：

```
[577ms] LOG  Welcome to Chess-API.com! ...
[577ms] LOG  I'm serving data using Stockfish 18 ...
[800ms] INFO Waiting for engine. You are #1 in public queue.
[832ms] MOVE depth=1 mpv=1 Ng5  eval=0.38 pv=[]        ← 浅层 PV 为空，须跳过
[833ms] MOVE depth=1 mpv=2 d3   eval=0.24 pv=[]
[833ms] MOVE depth=1 mpv=3 Qe2  eval=-0.33 pv=[]
[866ms] MOVE depth=5 mpv=1 d4   eval=0.35 pv=3
...
[906ms] BESTMOVE depth=12 mpv=1 d2d3 eval=0.23
        continuationArr=[a7a6 e1g1 f8c5 c2c3 c5a7 h2h3 h7h6]
        debug="info depth 12 seldepth 23 multipv 1 score cp 23 nodes 2927884 ... time 100 pv d2d3 ..."
```

**REST 单对象响应**（同局面，depth=12）：

```json
{
  "type": "bestmove", "move": "d2d3", "san": "d3", "eval": 0.29,
  "centipawns": "29", "mate": null, "depth": 12,
  "continuationArr": ["f8c5","e1g1","d7d6","h2h3","a7a6","c2c3","c5a7","f1e1","e8g8","c4b3","c6e7","b1d2"],
  "turn": "w", "from": "d2", "to": "d3", "taskId": "55oamooc2"
}
```

**错误样本**（HTTP 200，body 判错）：

```json
{"type":"error","error":"INVALID_FEN","text":"Invalid FEN: must contain six space-delimited fields"}
{"type":"error","error":"INVALID_INPUT","text":"Cannot evaluate given position - wrong FEN."}
{"type":"error","error":"INVALID_INPUT","text":"extendMoveInfo: move must not be undefined"}   // stalemate 局面
```


````

**符号换算验证**（`6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1`，Rd8#）：

```json
{"move":"d1d8","san":"Rd8#","eval":100,"mate":"1","centipawns":"10000","turn":"w"}
````

镜像局面（轮黑走，Rd1#）：`eval=-100, mate="-1"` → 换算后 scoreMate 均为行棋方视角的 +1。
