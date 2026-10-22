/**
 * comment-model.js  —— L0 平台层：AI 点评的「可点走法」协议层（平台级一等公民）
 *
 * 这是产品区别于同类的关键差异化能力，重构后从页面的私有逻辑上升为平台契约：
 * 让 AI 点评能「指」棋盘（Tutor 交互硬约束），且被对弈/分析/打谱/练习全复用。
 *
 * 两条互补的标记协议：
 *   1) 结构化演示线（沿用现有、最稳健）：正文后的 ===DEMO=== JSON 块，由 parseDemo 解析为
 *      可重放的演示线（DemoSession 负责在临时副本上逐步演示 + 位置焦点高亮）。
 *   2) 内联标记（文档约定的平台级协议，新增）：正文里直接写
 *         [move:e2e4]           —— 走法链接（UCI；可选带 ;FEN 定位）
 *         [branch:main]         —— 分支链接（跳到某条演示线）
 *      tokenizeInline / parseComment 把正文切成 token 流（text / moveLink / branch），
 *      点击 → session.gotoNode(对应局面) 或 DemoSession 进入对应分支 + BoardView.focus 高亮。
 *
 * 复用：board-model（共享视图层）与 Game（纯状态层）。不 import 页面、不依赖 wx/DOM/Canvas，可单测。
 * 注意：复用 game.js 的 Game 是为了演示会话跑在临时副本上，不触碰真实棋局。
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
 * 容错策略：本线 moves 逐手校验，遇到非法着法**截断保留合法前缀**。
 * @returns {{ sans: string[], tos: string[], applied: string[] }|null}
 */
function resolveMoves(item, byId, rootFen, visited) {
  let sans = []
  let tos = []
  const base = item.base
  if (base && base !== 'root' && typeof base.line === 'string') {
    if (visited.has(base.line)) return null
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
      console.warn('[comment-model] 线「' + (item.id || '?') + '」第 ' + (i + 1) + ' 手「' +
        item.moves[i] + '」不合法，截断保留前 ' + applied.length + ' 手')
      break
    }
    applied.push(mv.san)
    tos.push(mv.to)
  }
  if (!applied.length) return null
  return { sans: sans.concat(applied), tos: tos, applied: applied }
}

/** 判断某条线第 moveIndex（0 基）手的行棋方 */
function moverOf(line, moveIndex, rootTurn) {
  const idx = line.resolved.length - line.moves.length + moveIndex
  const whiteTurn = idx % 2 === 0
  if (rootTurn === 'w') return whiteTurn ? 'w' : 'b'
  return whiteTurn ? 'b' : 'w'
}

/** 在某条线里找一个格子「作为落点」出现的最晚位置（1 基；0 表示不是落点） */
function plyOfSquare(line, sq) {
  const baseLen = line.resolved.length - line.moves.length
  let found = 0
  for (let i = baseLen; i < line.resolved.length; i++) {
    if (line.tos[i] === sq) found = i - baseLen + 1
  }
  return found
}

/** 记号边界：前后都不能是字母/数字 */
function boundaryOk(text, start, len) {
  const prev = start > 0 ? text[start - 1] : ' '
  const next = (start + len < text.length) ? text[start + len] : ' '
  return !/[a-zA-Z0-9]/.test(prev) && !/[a-zA-Z0-9=]/.test(next)
}

/**
 * 把点评正文（或分支描述）切成片段，走法/格子/棋子记号带点击 payload 与配色类。
 * @returns {Array<{key,text,kind,cls,line,ply,sq,piece}>|null}
 */
function tokenizeText(text, opts) {
  const o = opts || {}
  const lines = Array.isArray(o.lines) ? o.lines : []
  const colorMode = o.colorMode === 'side' ? 'side' : 'branch'
  const rootTurn = o.rootTurn === 'b' ? 'b' : 'w'
  if (typeof text !== 'string' || !text) return null

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
    const last = out[out.length - 1]
    if (last && last.kind === '') last.text += text[i]
    else out.push({ key: 'seg' + (seq++), text: text[i], kind: '', cls: '', line: '', ply: 0, sq: '', piece: '' })
    i += 1
  }
  return out
}

/* ------------------------------------------------------------ 纯文本导出 */

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

function linePlainText(line, rootTurn) {
  if (!line) return ''
  const head = line.label + '（' + (line.moves || []).length + '手）'
  const desc = line.desc ? '：' + line.desc : ''
  const moves = movesPlainText(line.resolved, rootTurn)
  return '• ' + head + desc + (moves ? '\n  走法：' + moves : '')
}

function branchPlainText(lines, rootTurn) {
  return (lines || []).map(l => linePlainText(l, rootTurn)).filter(Boolean).join('\n')
}

function coachPlainText(prose, lines, rootTurn) {
  const body = (prose || '').trim()
  const branches = branchPlainText(lines, rootTurn)
  if (!body) return branches
  if (!branches) return body
  return body + '\n\n分支走法：\n' + branches
}

/* ------------------------------------------------------------ 走法演示会话 */

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

  setFocus(squares) {
    this.focus = (Array.isArray(squares) ? squares : []).filter(sq => typeof sq === 'string' && sq)
  }

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
      demoActive: this.active,
      lineId: this.lineId,
      label: line ? line.label : '',
      tone: line ? line.tone : '',
      cursor: this.cursor,
      total: total,
      demoCanBack: this.cursor > 0,
      demoCanForward: this.cursor < total,
      demoPlaying: this.playing,
      demoBreadcrumb: breadcrumb,
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

/* ----------------------------------------------------- 新增：内联标记协议 */

const INLINE_RE = /\[(move|branch):([^\]]+)\]/g

function _pushText(out, text, seqRef) {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.kind === 'text') last.text += text
  else out.push({ key: 'cm' + (seqRef.n++), kind: 'text', text: text, cls: '', line: '', ply: 0, sq: '', piece: '', uci: '', branchId: '' })
}

/**
 * 平台级内联标记解析：把正文切成 token 流。
 * 支持两类标记（文档 §3 协议）：
 *   [move:e2e4]          走法链接（UCI；可选 ;FEN 指定目标局面，用于从任意局面定位）
 *   [branch:main]        分支链接（跳到某条演示线）
 * 其余文字保持为 text 片段（相邻 text 合并以减少片段数）。
 *
 * @param {string} text 点评正文（已剔除结构化 ===DEMO=== 块后的 prose）
 * @param {object} [opts] { rootFen, lines }
 * @returns {Array<{key,kind,text,cls,line,ply,sq,piece,uci,branchId}>|null}
 */
function tokenizeInline(text, opts) {
  const o = opts || {}
  const rootFen = o.rootFen || ''
  if (typeof text !== 'string' || !text) return null

  const out = []
  const seq = { n: 0 }
  let i = 0
  let m
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text)) !== null) {
    const whole = m[0]
    const kind = m[1] === 'move' ? 'move' : 'branch'
    const inner = (m[2] || '').trim()
    if (m.index > i) _pushText(out, text.slice(i, m.index), seq)
    if (kind === 'move') {
      const parts = inner.split(';')
      const uci = parts[0].trim()
      const fen = (parts[1] || '').trim() || rootFen
      const sq = uci.length >= 4 ? uci.slice(-2) : ''
      out.push({
        key: 'cm' + (seq.n++), kind: 'move', text: uci, cls: 'seg-move',
        line: '', ply: 0, sq: sq, piece: '', uci: uci, branchId: '', fen: fen
      })
    } else {
      out.push({
        key: 'cm' + (seq.n++), kind: 'branch', text: inner, cls: 'seg-move',
        line: inner, ply: 0, sq: '', piece: '', uci: '', branchId: inner, fen: rootFen
      })
    }
    i = m.index + whole.length
  }
  if (i < text.length) _pushText(out, text.slice(i), seq)
  return out.length ? out : null
}

/**
 * 总入口：解析一次点评文本，得到「演示线 + 纯文本 + 内联 token 流」。
 * 这是 comment-model 作为平台契约对外暴露的核心函数，UI（CommentCard）据此渲染
 * 可点链接；点击 moveLink / branch → 触发 session.gotoNode / DemoSession 进入对应分支。
 *
 * @param {string} rawText 原始点评（可能含 ===DEMO=== 块）
 * @param {string} rootFen 被点评局面的 FEN
 * @returns {{ lines, prose, tokens }}
 */
function parseComment(rawText, rootFen) {
  const parsed = parseDemo(rawText, rootFen)
  const tokens = tokenizeInline(parsed.prose, { rootFen: rootFen, lines: parsed.lines }) || []
  return { lines: parsed.lines, prose: parsed.prose, tokens: tokens }
}

module.exports = {
  parseDemo,
  stripDemoBlock,
  tokenizeText,
  tokenizeInline,
  parseComment,
  movesPlainText,
  linePlainText,
  branchPlainText,
  coachPlainText,
  DemoSession,
  resolveMoves,
  DEMO_START,
  DEMO_END
}
