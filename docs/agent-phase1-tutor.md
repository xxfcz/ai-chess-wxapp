# 阶段一 · Candidate Grounding（候选落地）

> 把演示线从「模型凭空生成 SAN」改成「模型提意图 → 端上生成合法序列」。
> 总纲见 `docs/agent-plan.md`。本篇包含产品设计、需求说明、系统设计、契约与**近期可执行的落地清单**。
>
> **角色：Tutor（教练）。** 文中出现的 `coach` 均为既有代码标识符（`COACH_SYSTEM_PROMPT`、`utils/coach-demo.js`、`onCoach`、`coachText`），  
> 按总纲 §1.4 **不做重命名**；本阶段新增的一切统一用 `tutor`。
>
> 配套代码：`utils/ai-client.js`、`utils/coach-demo.js`、`utils/engine.js`、`utils/game.js`、`pages/analyze/analyze.js`
> 更新日期：2026-10-07

---

## 1. 目标与边界

### 1.1 目标

让 `===DEMO===` 里出现的**每一个走法都由 chess.js 生成**，模型不参与任何走法的拼写。

### 1.2 边界（本阶段明确**不做**）

| 不做 | 原因 |
|---|---|
| 多轮追问、工具循环 | 阶段二的事 |
| 用户画像、记忆 | 阶段三的事 |
| 更换 `engine.analyze` 的输出契约 | AGENTS.md §4 已冻结，动了要连带改页面 |
| 改 UI 布局 / 新增 Tab | 演示线的数据结构不变，界面无需改 |
| 引入任何新依赖 | 保持小程序零第三方框架 |
| 陪练角色 | 见总纲 §1.3，占位未立项 |

### 1.3 为什么这是性价比最高的一刀

现状的症状不是「错误走法上棋盘」（`resolveMoves` 已经拦住了），而是：

> 模型猜错一手 → 演示线被截断 → 用户看到的那条线短得莫名其妙，
> 或者整条消失 → 正文里提到它的链接跟着失效。

也就是说，**被丢掉的往往是模型最有信心的、最长也最精彩的那条**。修复它不需要任何新能力，只需要把生成权收回端上。

---

## 2. 现状（精确到行）

### 2.1 脆弱点在提示词里

`utils/ai-client.js` 的 `COACH_SYSTEM_PROMPT`（第 29 行附近）：

```
'moves 必须从该线起点起逐手合法且黑白交替：每个子都要真的能走到那个格子
（注意不要被自己或对方的棋子挡住、不要吃不存在的子、将军时才加 +）；
不确定能走到的着法宁可不写，也不要猜测；'
```

这段本质是在**用自然语言描述国际象棋规则**，指望模型隐式完成合法性推理。它是本阶段主要的删除目标。

### 2.2 现有的兜底很靠前，但位置不对

`utils/coach-demo.js#resolveMoves`（第 122 行）：

```js
for (let i = 0; i < item.moves.length; i++) {
  const mv = probe.applySan(normalizeSan(item.moves[i]))
  if (!mv) {
    console.warn('[coach-demo] 线「' + item.id + '」第 ' + (i+1) + ' 手「' + item.moves[i] + '」不合法，截断保留前 ' + applied.length + ' 手')
    break
  }
  applied.push(mv.san)
}
if (!applied.length) return null
```

它的定位是**事后校验**：等模型已经把可能非法的东西写出来，再试图挽救。正确的做法是把它前移成**事前约束**——模型根本没有机会写出非法走法。

> **本阶段的现有兜底一行都不删。** 它是最后一道防线，不是要被替换的东西。
> 新增候选校验后，它会从「经常触发」变成「几乎不触发」。

---

## 3. 产品设计

### 3.1 用户视角的变化

| | 现状 | 阶段一之后 |
|---|---|---|
| 演示线完整度 | 时好时坏，偶尔只有 1 手或整条消失 | **稳定完整**（走法由端上保证合法） |
| 正文里的走法链接 | 偶尔点不动 | 全部可点 |
| 「AVOID 对比线」 | 最容易被丢（模型倾向于少写负面例子） | 稳定出现 |
| 等待时间 | 3~10s | 基本持平（复用已有分析，不额外搜索） |

**界面上没有任何新增控件。** 用户感知到的唯一变化是「演示线不再莫名其妙地断掉」。

### 3.2 反面——哪些东西不该变

- 演示线的**最大条数**（3 条）、每条**最多 6 手**：保持现状，不要因为「现在可靠了」就放宽限制。
  理由：这是一个手机小屏上的功能，6 手已经接近用户愿意逐步点完的上限。
- `tone`（good/bad/neutral）与 `desc` 的结构：保持现状。
- 「优选措辞靠 annotation，`===DEMO===` 只做数据」的分工：保持现状。

---

## 4. 需求说明（可验收条目）

编号便于在 Smoke 测试与代码评审时逐条勾选。

| # | 需求 | 验收方式 |
|---|---|---|
| **R1** | 演示线中的每一手**必须**来自端上生成的合法走法序列 | 单测：构造 20 个局面 × 3 个模拟模型输出，全部字段级断言无非法走法 |
| **R2** | 模型不再需要拼写任何 SAN——只需选择候选编号 | 检查 `COACH_SYSTEM_PROMPT` 中已无合法性相关约束 |
| **R3** | 模型仍输出 `moves` 时，系统**不退化**（向后兼容） | 单测：老格式输入仍能产出演示线 |
| **R4** | 候选上下文的引入**不显著增加端到端延迟** | 实测：复用已有分析结果，额外耗时 < 50ms（不计 LLM 侧） |
| **R5** | 候选池不得过大，避免挤占输出预算 | 单测：候选条目 ≤ 8，候选上下文 ≤ 400 token |
| **R6** | 端上分析仍与云端能力解耦 | AGENTS.md §8：无网络时 `analyzePosition` 可用 |
| **R7** | 三套既有回归全绿 | 见 §8.1 |
| **R8** | 搜索树内部仍走 `raw_*`，不在树内生成 SAN | 静态检查 + 性能对比（不得出现数量级退化） |
| **R9** | 模型选定候选后，可要求端上**继续展开若干手** | 单测：`extend`=2 时产出 3 手（1 首手 + 2 展开） |
| **R10** | 演示线第一手必须是被点评局面下的合法走法 | 单测：所有出品线的首手在 `legalMoves` 集合中 |

---

## 5. 系统设计

### 5.1 数据流

```
用户点「生成点评」
      │
      ▼
页面：this._lastResult（已有分析结果，含 3 条线与其 PV）
      │
      ├──► buildToolContext(fen, result)
      │      ① 候选 = 引擎三条线的首手 + 它们的 PV 第二手作为「后续」
      │      ② 候选不足时，用 legalMoves 补足到 topN（不过度依赖）
      │      ③ 每条候选标注 #编号 / SAN / 白方视角分 / 后续 2 手
      │
      ├──► buildUserPrompt() 追加第二段「合法候选」
      │
      ▼
LLM ──► 正文 + ===DEMO==={ lines:[ {id,label,tone,desc,base,cand,extend} ] }
      │
      ▼
页面：groundDemoLines(parsed, candidates, fen)
      │      把 cand+extend → 真实 moves 数组（端上生成）
      │      cand 非法？→ 就近纠正 → 仍失败则走现有 resolveMoves 校验
      ▼
现有 coach-demo.parseDemo()（输入结构未变，零改动或极小改动）
```

**关键设计点：`groundDemoLines` 的输出格式与现有 `lines[*].moves` 完全一致**，
因此 `coach-demo.js` 原有的解析、`DemoSession`、富文本链接、复制等链路**全部不受影响**。

### 5.2 成本为何为零（重要）

早先的设想是「点评前额外跑一次浅深度搜索」。实测不需要：

页面正点评时必定已有 `_lastResult`（三条线，各自带 `pvSan`）。候选 = 三条线的首手，
后续 = 各自 PV 的第 2~3 手。**直接复用，一次额外搜索都不跑。**

仅在 `_lastResult` 缺失（例如用户尚未触发分析就点点评）时，才补跑一次轻量搜索。

### 5.3 候选上下文的格式

喂给模型的形式应当**紧凑且不易误读**：

```
合法候选（供演示线引用，编号前的 # 不要写进 desc，禁止自行拼写任何走法）：
#1 Nf3  白方视角 +0.32  后续 Bc4 d6
#2 d4   白方视角 +0.28  后续 c4 e6
#3 Bc4  白方视角 +0.15  后续 d3 Nf6
#4 h3   白方视角 -0.40  后续 ...（劣手，可作对比）
```

设计取舍：

- **用编号而非走法作为引用键**：模型选编号比拼写 SAN 的容错高一个数量级；编号错了还能被「非法编号」精确检出。
- **带上分数**：让模型有能力解释「为什么选它」，而不是只被允许在候选里挑一个。
- **带上后续**：模型写 `desc` 时需要知道这条线往哪走，否则它依然会去猜——把幻觉从「走法」转移到了「描述」。这是最容易忽略的一步。
- **显式保留一个劣手候选**：现状之下模型的 `tone=bad` 对比线最容易出现也最容易出错，主动给它一个安全的负面样本。

### 5.4 `===DEMO===` 协议的演进（向后兼容）

新格式（**推荐路径**，模型完全不碰走法）：

```json
{"lines":[
  {"id":"main","label":"主线","tone":"good","desc":"稳住中心并尽快出子",
   "base":"root","cand":"#1","extend":2},
  {"id":"avoid","label":"对比","tone":"bad","desc":"过早出后被反先",
   "base":"root","cand":"#4","extend":1}
]}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `cand` | string | **候选编号**，必须存在于本次下发的候选表中。必填（新路径） |
| `extend` | number | 从候选**之后再**由端上展开几手（0~4，默认 0） |
| `base` | object\|string | 沿用现有语义（从另一条线的第几手继续） |
| `moves` | string[] | **仍接受**（旧路径）。存在且无 `cand` 时走现有校验流程 |

> `extend` 的实现依赖 `tools.expandLine`，而它的展开结果应当是**引擎对该局面的最佳应对**，
> 而不是随机走法——否则演示线会变成「随机对局」，讲解价值为零。

### 5.5 就近纠正（Rescue）

模型填了非法编号（如 `#9`，或填了走法文本）时，不应当直接丢弃该线：

```
1. 精确解析失败 → 尝试按「兵种 + 落点」在候选中匹配唯一项
   （模型写了 "Nf3" 而候选里有 Nf3 → 命中）
2. 仍不唯一 → 按当前分数最高的候选降级使用该 Δ（并在日志留痕）
3. 完全无法对应 → 丢弃该线，但**不影响正文**
4. 所有线都失败 → 不产出演示线，正文照常显示
```

第 4 步的「不影响正文」很重要：演示线是增强，不是主产物。

---

## 6. 契约

落地时以下接口形状应尽量保持稳定；如必须改动，请同步更新本节并说明原因。

```js
// utils/tools.js（新增）

legalMoves(fen, { only, limit })
  → [{ uci, san, from, to, piece, capture, check, mate }]

expandLine(fen, moves, { depth })
  → { path: [{ ply, san, uci, fenAfter, whiteCp, best }],
      complete: boolean, failedAt: number|null }
```

```js
// utils/ai-client.js（新增导出）

buildToolContext(fen, result, { topN })
  → { candidates: [{ no, san, uci, whiteCp, next: string[] }], text: string }
  // text 为拼进 user prompt 的候选段落；便于单测与锁定 token 预算

groundDemoLines(parsed, candidates, fen)
  → { lines: [...], warnings: string[] }
  // 输出形状与现有 lines[*].moves 一致；warnings 供调试日志/运行日志卡片
```

```js
// utils/coach-demo.js（签名扩展，行为兼容）

resolveMoves(item, byId, rootFen, visited, whitelist)
  // whitelist 可选；不传时行为与今天完全一致。
```

> 最后一条：现有五个位置参数与返回值形状**一律不动**，`whitelist` 作为**追加的可选第六参**。
> 现有调用方不传它，行为与今天完全一致。

---

## 7. 落地清单

> 本阶段设计已收敛且近期开工，故保留较具体的清单。
> 若实现过程中发现更优路径，**以代码为准，回来改这一节**。

| # | 文件 | 动作 |
|---|---|---|
| 1 | `utils/tools.js` | **新增**。`legalMoves` / `expandLine`；内部用 `raw_*`，SAN 只在返回处生成一次；不 import 页面、不碰 `wx` |
| 2 | `utils/ai-client.js` | **新增** `buildToolContext(fen, result, opts)`：优先复用传入的已有分析结果；候选补齐到 topN（≤8），并保留一个劣手 |
| 3 | `utils/ai-client.js` | **改** `buildUserPrompt`：追加候选段。现有第一段（FEN + 引擎路线）保持不变 |
| 4 | `utils/ai-client.js` | **改** `COACH_SYSTEM_PROMPT`：删除第 29 行那段合法性教条；改为「演示线的 moves 由系统生成，你只需指定 cand 编号与 extend 手数」 |
| 5 | `utils/ai-client.js` | **新增** `groundDemoLines(parsed, candidates, fen)`：把 cand+extend 落地为真实走法；含就近纠正；兼容旧 `moves` |
| 6 | `utils/coach-demo.js` | **改** `resolveMoves`：追加可选第六参 `whitelist`。**现有逻辑一行不动** |
| 7 | `pages/analyze/analyze.js` | **小改** `onCoach`：请求前后插入工具预取与 `groundDemoLines`；`coachDemo.parseDemo` 的输入结构不变 |
| 8 | `.workbuddy/tests/agent-tools.test.js` | **新增**：`tools` 三个函数的单元集 + `groundDemoLines` 的纠错矩阵 |

**不需要动**：`engine.js`（契约冻结）、`app.json`、`analyze.wxml`、`analyze.wxss`、`DemoSession`。

---

## 8. 测试与验收

### 8.1 门禁

```bash
node .workbuddy/tests/engine-and-game.test.js   # 现 153 项
node .workbuddy/tests/analyze-page.test.js      # 现 180 项
node .workbuddy/tests/cloud-adapter.test.js     # 现 68 项
node .workbuddy/tests/agent-tools.test.js       # 阶段一新增
```

### 8.2 阶段一必测矩阵

| 场景 | 期望 |
|---|---|
| 模型输出合法 `cand` | 演示线按 `extend` 展开到指定手数，全部合法 |
| 模型输出 `extend:0` | 只有候选首手自己 |
| 模型输出非法编号 `#99` | 就近纠正；无法纠正则该线降级处理，正文不受影响 |
| 模型仍输出旧 `moves` 且有非法手 | 行为与今天一致（截断保留），不退化 |
| `===DEMO===` 的 JSON 损坏 | 降级为无演示线，正文干净 |
| 局面为终局（无合法走法） | 候选为空，不产出演示线，点评正文正常 |
| `_lastResult` 缺失 | 补跑轻量搜索，功能不中断 |
| 网络不可用 | 端上候选仍可生成；点评侧走现有 `env_no_network` 文案 |

### 8.3 度量

上线前后各采集一轮（本地即可，不必埋点）：

- **演示线数量分布**（0/1/2/3 条）——目标：0 条的比例趋近 0
- **平均演示线长度**——目标：从当前实际值升到接近 6 手上界
- **点评端到端耗时**——目标：与现状持平（±10%）

---

## 9. 已知风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 候选段落使 prompt 变长 | 输入 token 上升、延迟微增 | 限 topN ≤ 8；候选行去修辞、只留编号+走法+分数+后续 |
| 模型不遵循 `cand`、仍输出 `moves` | 新机制形同虚设 | 兼容旧路径（R3）；同时在系统提示里明确「禁止拼写走法」 |
| `extend` 展开出的后续质量差 | 演示线看起来像随机对局 | `extend` 的每一步都用引擎最佳应对，而非随机合法走法 |
| 候选 Loss 与 user 视角不一致 | 排序看起来反直觉 | 统一用 `AI-client#formatScore` 换算白方视角，别在工具层另起一套 |
| 过度相信「现在可靠了」而放宽条数上限 | UI 拥挤 | 维持 3 条 × 6 手不变（见 §3.2） |
