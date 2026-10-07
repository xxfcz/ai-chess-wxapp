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

## 回归测试门禁

`.workbuddy/tests/` 三套，共 401 项断言。跑法（用 managed node 绝对路径）：

```
node .workbuddy/tests/engine-and-game.test.js   # 153
node .workbuddy/tests/analyze-page.test.js      # 180
node .workbuddy/tests/cloud-adapter.test.js     # 68
```

零依赖（`_harness.js` 是自写的极简断言工具）。`analyze-page` 对机器负载敏感——
等待一律用 `waitFor()` 轮询（超时 15s），**不要写死 `sleep`**，否则慢机器上偶发假绿。

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

## 待办

- `DemoSession.view()` 返回 `active/canBack/...`，而 `analyze.wxml` 读 `demoActive/demoCanBack/...`
  ——字段名不一致，演示线控制按钮大概率失效。已用测试钉住，**开阶段一时顺手统一**。
