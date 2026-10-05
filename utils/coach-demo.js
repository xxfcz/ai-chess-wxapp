/**
 * coach-demo.js
 * AI 教练点评的「走法演示」纯逻辑层（无 wx / DOM 依赖，可单测）。
 *
 * 解耦要点：
 *   - 只依赖 board-model（共享视图层）与 Game（纯状态层），不 import 页面；
 *   - 页面只通过 DemoSession.view() 取渲染数据，通过几个事件方法驱动，
 *     演示完全跑在临时 Game 副本上，不触碰真实棋局、不触发自动分析。
 *
 * 结构化协议（嵌在点评正文之后）：
 *   ===DEMO===
 *   {"lines":[{"id":"main","label":"主线走法","tone":"good","desc":"一句话说明",
 *              "base":"root","moves":["Kg2","Qxd5"]}]}
 *   ===END===
 *   - base 支持 "root"（被点评局面）或 {"line":"<id>","ply":<第几手，1 起>}（从某条线走几步后继续）；
 *   - tone ∈ good / bad / neutral；moves 使用标准 SAN，逐手校验：非法着法截断保留
 *     前面的合法前缀（合法手数为 0、base 非法或成环才整条丢弃）。
 *
 * 正文与 desc 中的记号会被 tokenizeText 切成可点片段：
 *   - 走法（SAN，须命中某条演示线）→ 点击把该分支演示到第几手；
 *   - 格子（如 e5、h2）→ 点击把对应分支上盘（若是某手的落点则演示到那一手，
 *     否则停在起点），并高亮该格；
 *   - 棋子（如 黑后、f3马）→ 点击按当前语境找到该子的实际格子并高亮（可多格）。
 */
const { Game } = require('./game')
const boardModel = require('./board-model')

const DEMO_START = '===DEMO==='
const DEMO_END = '===END==='
const TONE_RANK = { good: 0, bad: 1, neutral: 2 }
const MAX_LINE_MOVES = 8
const MAX_DESC_CHARS = 80

/** 中文棋子名 → chess.js 兵种字母；颜色：黑 → b，白 → w */
const PIECE_TYPE_OF = { 后: 'q', 车: 'r', 象: 'b', 马: 'n', 王: 'k', 兵: 'p' }

/**
 * 从点评文本抽取并校验演示线。
 * @returns {{ lines: Array, prose: string }}
 */
function parseDemo(rawText, rootFen) {
  const text = typeof rawText === 'string' ? rawText : ''
  const prose = stripDemoBlock(text)
  const out = []
  try {
    const start = text.indexOf(DEMO_START)
    if (start < 0) return { lines: out, prose: prose }
    const rest = text.slice(start + DEMO_START.length)
    const end = rest.indexOf(DEMO_END)
    const jsonStr = (end >= 0 ? rest.slice(0, end) : rest).trim()
    if (!jsonStr) return { lines: out, prose: prose }
    const data = JSON.parse(jsonStr)
    const raw = Array.isArray(data && data.lines) ? data.lines : []
    const byId = {}
    raw.forEach(item => {
      if (item && typeof item.id === 'string') byId[item.id] = item
    })
    raw.forEach(item => {
      const line = normalizeLine(item, byId, rootFen)
      if (line) out.push(line)
    })
    out.sort((a, b) => (TONE_RANK[a.tone] - TONE_RANK[b.tone]) || 0)
  } catch (e) {
    // 解析 / 校验失败一律降级为无演示线，点评正文照常显示
    return { lines: [], prose: prose }
  }
  return { lines: out, prose: prose }
}

/** 把点评正文里的 ===DEMO=== ... ===END=== 结构化块剔除，得到纯人类可读文本 */
function stripDemoBlock(text) {
  const text2 = typeof text === 'string' ? text : ''
  const start = text2.indexOf(DEMO_START)
  if (start < 0) return text2
  const rest = text2.slice(start + DEMO_START.length)
  const end = rest.indexOf(DEMO_END)
  const tail = end >= 0 ? rest.slice(end + DEMO_END.length) : ''
  return (text2.slice(0, start) + tail).trim()
}

function normalizeLine(item, byId, rootFen) {
  if (!item || !Array.isArray(item.moves) || !item.moves.length) return null
  const id = typeof item.id === 'string' && item.id ? item.id : 'line' + Math.random().toString(36).slice(2, 7)
  const tone = item.tone === 'bad' || item.tone === 'good' ? item.tone : 'neutral'
  const label = typeof item.label === 'string' && item.label
    ? item.label
    : (tone === 'good' ? '推荐走法' : tone === 'bad' ? '避免走法' : '演示线')
  const desc = typeof item.desc === 'string' ? item.desc.trim().slice(0, MAX_DESC_CHARS) : ''
  const base = (item.base === 'root' || item.base === undefined || item.base === null)
    ? 'root'
    : (item.base && typeof item.base.line === 'string' ? item.base : 'root')
  const moves = (Array.isArray(item.moves) ? item.moves : []).slice(0, MAX_LINE_MOVES).map(normalizeSan)
  const resolved = resolveMoves({ base: base, moves: moves, id: id }, byId, rootFen, new Set())
  if (!resolved) return null
  // 展示用的 moves 用引擎回吐的规范 SAN，与截断后的实际可重放序列一致
  return { id: id, label: label, tone: tone, desc: desc, base: base, moves: resolved.applied, resolved: resolved.sans, tos: resolved.tos }
}

/**
 * 规范化模型给出的 SAN 写法，尽量挽救常见的非标准格式：
 *  - 去掉首尾空白与误加的回合号前缀（「1.Kg2」→「Kg2」）；
 *  - 去掉尾部的评注符号（「Qc4+!?」→「Qc4+」保留 +/#，去掉 !?．。等）；
 *  - 王车易位用 0 代替 O（「0-0」→「O-O」）。
 */
function normalizeSan(san) {
  if (typeof san !== 'string') return ''
  let s = san.trim()
  s = s.replace(/^\d+\s*\.{1,2}/, '')
  s = s.replace(/[.!?！？．。,，;；]+$/g, '')
  s = s.replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O')
  return s.trim()
}

/**
 * 解析 base 锚点链，得到「从 root 起要连续施加的完整着法序列」及其落点格。
 * 容错策略：本线 moves 逐手校验，遇到非法着法**截断保留合法前缀**（模型偶尔会
 * 写出实际走不到的着法，整条丢弃会让推荐线整个消失、正文里的走法也失去链接）；
 * 只有合法手数为 0（或 base 前缀本身非法/成环）才丢弃整条。
 * @returns {{ sans: string[], tos: string[], applied: string[] }|null}
 *          applied = 本线被接受（规范化后）的着法，作为线展示用的 moves
 */
function resolveMoves(item, byId, rootFen, visited) {
  let sans = []
  let tos = []
  const base = item.base
  if (base && base !== 'root' && typeof base.line === 'string') {
    if (visited.has(base.line)) return null // 成环，丢弃
    visited.add(base.line)
    const parent = byId[base.line]
    if (!parent) return null
    const parentResolved = resolveMoves(parent, byId, rootFen, visited)
    if (!parentResolved) return null
    const ply = (typeof base.ply === 'number' && base.ply > 0)
      ? Math.min(base.ply, parentResolved.sans.length) : parentResolved.sans.length
    sans = parentResolved.sans.slice(0, ply)
    tos = parentResolved.tos.slice(0, ply)
  }
  const probe = new Game(rootFen)
  for (let i = 0; i < sans.length; i++) {
    if (!probe.applySan(sans[i])) return null
  }
  const applied = []
  for (let i = 0; i < item.moves.length; i++) {
    const mv = probe.applySan(normalizeSan(item.moves[i]))
    if (!mv) {
      // 截断保留：记录并用 debug-log 可见的 console.warn 暴露（预览/真机可从「运行日志」看到）
      console.warn('[coach-demo] 线「' + (item.id || '?') + '」第 ' + (i + 1) + ' 手「' +
        item.moves[i] + '」不合法，截断保留前 ' + applied.length + ' 手')
      break
    }
    applied.push(mv.san) // 用引擎回吐的规范 SAN（含消歧/易位正写），展示与重放一致
    tos.push(mv.to)
  }
  if (!applied.length) return null
  return { sans: sans.concat(applied), tos: tos, applied: applied }
}

/** 判断某条线第 moveIndex（0 基）手的行棋方（依据 root 局面的行棋方与 resolved 序号交替） */
function moverOf(line, moveIndex, rootTurn) {
  const idx = line.resolved.length - line.moves.length + moveIndex
  const whiteTurn = idx % 2 === 0
  if (rootTurn === 'w') return whiteTurn ? 'w' : 'b'
  return whiteTurn ? 'b' : 'w'
}

/**
 * 在某条线里找一个格子「作为落点」出现的最晚位置。
 * @returns {number} 1 基的手数（该线上盘到第几手时该格刚被走到）；0 表示不是落点（起点语境）
 */
function plyOfSquare(line, sq) {
  const baseLen = line.resolved.length - line.moves.length
  let found = 0
  for (let i = baseLen; i < line.resolved.length; i++) {
    if (line.tos[i] === sq) found = i - baseLen + 1
  }
  return found
}

/** 记号边界：前后都不能是字母/数字（避免 c1象、Kg2 里的 g2 被误当格子） */
function boundaryOk(text, start, len) {
  const prev = start > 0 ? text[start - 1] : ' '
  const next = (start + len < text.length) ? text[start + len] : ' '
  return !/[a-zA-Z0-9]/.test(prev) && !/[a-zA-Z0-9=]/.test(next)
}

/**
 * 把点评正文（或分支描述）切成片段，走法/格子/棋子记号带点击 payload 与配色类。
 *
 * @param {string} text 正文或分支描述
 * @param {object} opts
 *   - lines: 演示线数组（parseDemo 的输出，可空）
 *   - ctxLineId: 上下文线 id（分支描述传该线的 id；正文传 ''）
 *   - colorMode: 'branch'（正文：按分支着色）| 'side'（分支列表：按黑白方着色）
 *   - rootTurn: 'w'|'b'，root 局面行棋方（side 模式算行棋方用）
 * @returns {Array<{key,text,kind,cls,line,ply,sq,piece}>|null} null 表示文本为空
 *
 * 配色方案（cls 由数据下发，不依赖模板循环变量）：
 *   - branch 模式：ln-0 / ln-1 / ln-2 按线的序号着色（蓝 / 橙 / 紫）；
 *   - side 模式：side-w（亮白）/ side-b（灰）按该手的行棋方着色；
 *     格子/棋子记号继承上下文最近一手（或本线第一手）的行棋方颜色。
 */
function tokenizeText(text, opts) {
  const o = opts || {}
  const lines = Array.isArray(o.lines) ? o.lines : []
  const colorMode = o.colorMode === 'side' ? 'side' : 'branch'
  const rootTurn = o.rootTurn === 'b' ? 'b' : 'w'
  if (typeof text !== 'string' || !text) return null

  // 走法记号：branch 模式收全部线；side 模式只收上下文线（desc 讲的就是这条线）
  const moveMarks = []
  lines.forEach((l, li) => {
    if (colorMode === 'side' && o.ctxLineId && l.id !== o.ctxLineId) return
    ;(l.moves || []).forEach((san, i) => {
      moveMarks.push({
        san: san, lineId: l.id, lineIndex: li, ply: i + 1,
        side: moverOf(l, i, rootTurn)
      })
    })
  })
  const byLen = moveMarks.slice().sort((a, b) => b.san.length - a.san.length)
  // 同名走法优先命中上下文线（desc 里提到的走法以本线为准）
  if (o.ctxLineId) {
    byLen.sort((a, b) => (b.lineId === o.ctxLineId ? 1 : 0) - (a.lineId === o.ctxLineId ? 1 : 0))
  }

  const lineIndexById = {}
  lines.forEach((l, li) => { lineIndexById[l.id] = li })
  const firstSideOf = {}
  lines.forEach(l => {
    firstSideOf[l.id] = l.moves.length ? moverOf(l, 0, rootTurn) : ''
  })

  const out = []
  let i = 0
  let seq = 0
  // 上下文：正文里格子/棋子记号继承最近一手的线；分支列表里固定为本线
  let lastMoveMark = null
  const ctxOf = () => {
    if (colorMode === 'side') return o.ctxLineId || ''
    return lastMoveMark ? lastMoveMark.lineId : ''
  }
  const sideOf = (mark) => {
    if (colorMode !== 'side') return ''
    if (mark && mark.side) return mark.side
    if (lastMoveMark && lastMoveMark.side) return lastMoveMark.side
    const ctx = ctxOf()
    return ctx ? (firstSideOf[ctx] || '') : ''
  }
  const clsOf = (mark, hasLine) => {
    if (colorMode === 'side') {
      const side = sideOf(mark)
      return side === 'w' ? 'seg-move side-w' : side === 'b' ? 'seg-move side-b' : 'seg-move'
    }
    return hasLine ? 'seg-move ln-' + (mark ? mark.lineIndex : 0) : 'seg-move'
  }

  while (i < text.length) {
    // 1) 走法（SAN，须命中演示线的 moves，长度优先、上下文线优先）
    let matched = null
    for (const m of byLen) {
      if (text.substr(i, m.san.length) === m.san && boundaryOk(text, i, m.san.length)) { matched = m; break }
    }
    if (matched) {
      out.push({
        key: 'seg' + (seq++), text: matched.san, kind: 'move',
        cls: clsOf(matched, true), line: matched.lineId, ply: matched.ply, sq: '', piece: ''
      })
      lastMoveMark = matched
      i += matched.san.length
      continue
    }
    // 2) 棋子（黑后 / 白马；「d6象」里的 d6 已单独成为格子记号，象保持正文）
    const pieceHead = text.charAt(i)
    const pieceBody = text.charAt(i + 1)
    if ((pieceHead === '黑' || pieceHead === '白') && PIECE_TYPE_OF[pieceBody] && boundaryOk(text, i, 2)) {
      const color = pieceHead === '白' ? 'w' : 'b'
      const ctx = ctxOf()
      out.push({
        key: 'seg' + (seq++), text: text.substr(i, 2), kind: 'piece',
        cls: clsOf(lastMoveMark, !!ctx), line: ctx, ply: 0, sq: '', piece: color + PIECE_TYPE_OF[pieceBody]
      })
      i += 2
      continue
    }
    // 3) 格子（如 e5、h2；Kg2/Rad1 这类 SAN 内的格子被边界检查挡住）
    const c0 = text.charAt(i)
    const c1 = text.charAt(i + 1)
    if (c0 >= 'a' && c0 <= 'h' && c1 >= '1' && c1 <= '8' && boundaryOk(text, i, 2)) {
      const sq = c0 + c1
      const ctx = ctxOf()
      const ctxLine = ctx ? lines[lineIndexById[ctx]] : null
      const ply = ctxLine ? plyOfSquare(ctxLine, sq) : 0
      out.push({
        key: 'seg' + (seq++), text: sq, kind: 'sq',
        cls: clsOf(lastMoveMark, !!ctx), line: ctx, ply: ply, sq: sq, piece: ''
      })
      i += 2
      continue
    }
    // 4) 普通文字：与上一段纯文本合并，减少片段数量
    const last = out[out.length - 1]
    if (last && last.kind === '') last.text += text[i]
    else out.push({ key: 'seg' + (seq++), text: text[i], kind: '', cls: '', line: '', ply: 0, sq: '', piece: '' })
    i += 1
  }
  return out
}

/* ------------------------------------------------------------ 纯文本导出（复制用） */

/**
 * 把一条演示线的走法序列写成棋谱式纯文本（带回合号）。
 * resolved 已经是「祖先前缀 + 本线着法」的完整序列，序号从被点评局面起算。
 */
function movesPlainText(resolved, rootTurn) {
  const sans = Array.isArray(resolved) ? resolved : []
  const out = []
  sans.forEach((san, i) => {
    const whiteMove = rootTurn === 'b' ? i % 2 === 1 : i % 2 === 0
    const no = Math.floor(i / 2) + 1
    if (i === 0 || whiteMove) out.push(no + (whiteMove ? '.' : '...'))
    out.push(san)
  })
  return out.join(' ')
}

/**
 * 把一条演示线的「本线走法」切成可点片段（带回合号），供分支列表直接展示完整步骤。
 * 只列本线自己的 moves（base 前缀视作已下完的起始语境，不重复列出）。
 * 每个走法片段携带 line + ply（1 基），点击即把该分支演示到那一手；落点/手数前的
 * 回合号是纯文本片段（line 为空，不可点）。行棋方配色 side-w / side-b。
 */
function buildMoveSegs(line, rootTurn, rootFullmove) {
  const moves = (line && line.moves) || []
  const resolved = (line && line.resolved) || []
  const prefixLen = resolved.length - moves.length
  const segs = []
  let k = 0
  moves.forEach((san, p) => {
    const gi = prefixLen + p
    const whiteMove = rootTurn === 'b' ? (gi % 2 === 1) : (gi % 2 === 0)
    const no = rootFullmove + Math.floor(gi / 2)
    if (p === 0 || whiteMove) {
      segs.push({ key: 'mvn' + (k++), cls: '', line: '', ply: 0, sq: '', piece: '', text: (whiteMove ? no + '.' : no + '...') + ' ' })
    }
    segs.push({
      key: 'mvm' + (k++),
      cls: whiteMove ? 'side-w' : 'side-b',
      line: line.id,
      ply: p + 1,
      sq: '',
      piece: '',
      text: san + ' '
    })
  })
  return segs
}

/** 单条分支的纯文本：标签 + 手数 + 短评 + 走法序列 */
function linePlainText(line, rootTurn) {
  if (!line) return ''
  const head = line.label + '（' + (line.moves || []).length + '手）'
  const desc = line.desc ? '：' + line.desc : ''
  const moves = movesPlainText(line.resolved, rootTurn)
  return '• ' + head + desc + (moves ? '\n  走法：' + moves : '')
}

/** 全部分支的纯文本（每条一行起头，走法另起一行缩进） */
function branchPlainText(lines, rootTurn) {
  return (lines || []).map(l => linePlainText(l, rootTurn)).filter(Boolean).join('\n')
}

/** 整段点评的纯文本：正文 + 分支走法，供一键复制 */
function coachPlainText(prose, lines, rootTurn) {
  const body = (prose || '').trim()
  const branches = branchPlainText(lines, rootTurn)
  if (!body) return branches
  if (!branches) return body
  return body + '\n\n分支走法：\n' + branches
}

/**
 * 走法演示会话：在临时 Game 副本上按线重放，产出棋盘 cells 与「当前位置」面包屑。
 * 完全不触碰页面真正的棋局与自动分析。支持「位置焦点」：点评里点到的格子/棋子
 * 用独立配色高亮在演示棋盘上。
 */
class DemoSession {
  constructor(lines, rootFen, opts) {
    opts = opts || {}
    this.lines = lines || []
    this.rootFen = rootFen
    this.rootTurn = (typeof rootFen === 'string' && rootFen.split(' ')[1] === 'b') ? 'b' : 'w'
    const _fm = (typeof rootFen === 'string' && rootFen.split(' ')[5]) ? parseInt(rootFen.split(' ')[5], 10) : 1
    this.rootFullmove = (isNaN(_fm) || _fm < 1) ? 1 : _fm
    this.rootFlipped = !!opts.flipped
    this.active = false
    this.lineId = null
    this.cursor = 0
    this.playing = false
    this.focus = []
    this._game = new Game(rootFen)
    if (this.rootFlipped) this._game.flip()
    this._timer = null
  }

  /** 分支列表视图：标签（按线序号配色）+ 描述片段（按黑白方配色） */
  lineViews() {
    return this.lines.map((l, i) => ({
      idx: i,
      key: 'demo' + i,
      id: l.id,
      label: l.label,
      tone: l.tone,
      cls: 'demo-label-' + i,
      total: l.moves.length,
      segs: tokenizeText(l.desc || '', {
        lines: this.lines, ctxLineId: l.id, colorMode: 'side', rootTurn: this.rootTurn
      }) || [],
      moves: buildMoveSegs(l, this.rootTurn, this.rootFullmove)
    }))
  }

  enter(lineId) {
    const line = this.lines.find(l => l.id === lineId)
    if (!line) return
    this._stopTimer()
    this.active = true
    this.playing = false
    this.lineId = lineId
    this.cursor = 0
    this.focus = []
    this._rebuild()
  }

  /** 进入某线并直接定位到第 ply 手（1 基；0 表示停在起点） */
  enterAt(lineId, ply) {
    this.enter(lineId)
    if (this.lineId !== lineId) return
    const line = this._current()
    const max = line ? line.moves.length : 0
    this.cursor = Math.max(0, Math.min(ply | 0, max))
    this._rebuild()
  }

  step(dir) {
    if (!this.active) return
    const line = this._current()
    if (!line) return
    this._stopTimer()
    this.playing = false
    this.cursor = Math.max(0, Math.min(this.cursor + (dir > 0 ? 1 : -1), line.moves.length))
    this.focus = []
    this._rebuild()
  }

  reset() {
    if (!this.active) return
    this._stopTimer()
    this.playing = false
    this.cursor = 0
    this.focus = []
    this._rebuild()
  }

  play(onTick) {
    if (!this.active) return
    const line = this._current()
    if (!line) return
    if (this.cursor >= line.moves.length) this.cursor = 0
    this._stopTimer()
    this.playing = true
    this.focus = []
    this._timer = setInterval(() => {
      const ln = this._current()
      if (!ln || this.cursor >= ln.moves.length) {
        this.playing = false
        this._stopTimer()
        if (onTick) onTick()
        return
      }
      this.cursor += 1
      this._rebuild()
      if (onTick) onTick()
      if (this.cursor >= ln.moves.length) { this.playing = false; this._stopTimer() }
    }, 350)
  }

  pause() {
    this.playing = false
    this._stopTimer()
  }

  /** 设置「位置焦点」格子（可多格），独立紫色高亮；换线/走子后自动清除 */
  setFocus(squares) {
    this.focus = (Array.isArray(squares) ? squares : []).filter(sq => typeof sq === 'string' && sq)
  }

  /** 依据记号（如 'bq'=黑后）在当前演示局面上找该子的格子 */
  findPieces(token) {
    if (typeof token !== 'string' || token.length < 2) return []
    return this._game.pieceSquares(token.charAt(0), token.charAt(1))
  }

  flip() {
    if (!this._game) return
    this._game.flip()
    this.rootFlipped = this._game.flipped
  }

  exit() {
    this.active = false
    this.playing = false
    this._stopTimer()
    this.lineId = null
    this.cursor = 0
    this.focus = []
  }

  game() { return this._game }

  _current() { return this.lines.find(l => l.id === this.lineId) || null }

  _stopTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  }

  _rebuild() {
    const line = this._current()
    this._game = new Game(this.rootFen)
    if (this.rootFlipped) this._game.flip()
    if (!line) return
    // resolved = 祖先前缀 + 本线 moves；cursor 是本线步数，需跳过祖先前缀
    const baseLen = Math.max(0, line.resolved.length - line.moves.length)
    const upto = baseLen + this.cursor
    for (let k = 0; k < upto; k++) this._game.applySan(line.resolved[k])
  }

  view() {
    const line = this._current()
    const total = line ? line.moves.length : 0
    const game = this._game
    const status = game.status()
    let breadcrumb = ''
    if (this.active && line) {
      const stepNo = this.cursor
      const curMove = stepNo > 0 ? line.moves[stepNo - 1] : null
      let src = '被点评局面'
      if (line.base && line.base !== 'root' && line.base.line) {
        const parent = this.lines.find(l => l.id === line.base.line)
        const ply = (typeof line.base.ply === 'number' && line.base.ply > 0)
          ? line.base.ply : (parent ? parent.moves.length : 0)
        if (parent) src = '「' + parent.label + '」第 ' + ply + ' 步后'
      }
      breadcrumb = '演示线：' + line.label + ' · 第 ' + stepNo + '/' + total + ' 步'
      if (curMove) breadcrumb += ' · ' + curMove
      breadcrumb += '（自' + src + '起）'
    }
    return {
      active: this.active,
      lineId: this.lineId,
      label: line ? line.label : '',
      tone: line ? line.tone : '',
      cursor: this.cursor,
      total: total,
      canBack: this.cursor > 0,
      canForward: this.cursor < total,
      playing: this.playing,
      breadcrumb: breadcrumb,
      statusLabel: status.label,
      turnClass: game.getTurn(),
      terminalLabel: status.over ? status.label : '',
      cells: boardModel.buildCells({
        board: game.getBoard(),
        flipped: game.flipped,
        selected: null,
        legalTargets: [],
        lastMove: game.lastMove(),
        checkSquare: game.kingSquareUnderCheck(),
        hint: null,
        hiddenSquare: null,
        focus: this.focus
      })
    }
  }
}

module.exports = {
  parseDemo,
  stripDemoBlock,
  tokenizeText,
  movesPlainText,
  linePlainText,
  branchPlainText,
  coachPlainText,
  DemoSession,
  DEMO_START,
  DEMO_END
}
