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
