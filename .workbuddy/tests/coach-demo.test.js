/**
 * coach-demo.test.js
 * 走法演示的纯逻辑单测（无 wx / DOM）：解析、逐手校验、base 锚点、
 * 正文记号切分（走法/格子/棋子 + 分支/黑白两套配色）、重放与位置焦点。
 *
 * 与页面的解耦点：本文件只 require utils/coach-demo，不触碰 analyze 页面与 wx。
 */
const path = require('path')
const coachDemo = require(path.join(__dirname, '../../utils/coach-demo.js'))

let failed = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  -> ' + extra : ''))
  if (!cond) failed++
}

const ROOT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// 自洽的合法演示线：1.e4 e5 2.Nf3 Nc6 3.c4 / 1.d4 d5 / 接在 1.d4 d5 之后的 2.c4 Nc6 3.e4
const PROSE = '黑后在 d6 施压，白方可走 e4 或 d4。===DEMO===\n' +
  '{"lines":[' +
  '{"id":"main","label":"主线走法（e4）","tone":"good","desc":"推荐走 e4 占中心，黑方应以 e5 或 Nc6。","moves":["e4","e5","Nf3","Nc6","c4"]},' +
  '{"id":"avoid","label":"对比走法（d4）","tone":"bad","desc":"避免冲 d4，黑方应以 d5 稳固。","moves":["d4","d5"]},' +
  '{"id":"counter","label":"黑方反击","tone":"neutral","desc":"接 c4 与 Nc6。","base":{"line":"avoid","ply":2},"moves":["c4","Nc6","e4"]}' +
  ']}\n===END==='

console.log('===== coach-demo.parseDemo =====')
const parsed = coachDemo.parseDemo(PROSE, ROOT)
ok('解析出 3 条演示线', parsed.lines.length === 3, parsed.lines.length)
ok('good 线排在前面', parsed.lines[0].tone === 'good', parsed.lines[0].tone)
ok('每条线带合法 moves', parsed.lines.every(l => Array.isArray(l.moves) && l.moves.length > 0))
ok('desc 原样保留（截到 80 字内）', parsed.lines[0].desc.indexOf('占中心') !== -1, parsed.lines[0].desc)
const counter = parsed.lines.find(l => l.id === 'counter')
ok('base 锚点线 resolved 含父线着法', counter && counter.resolved.join(' ').indexOf('d4 d5 c4') === 0, counter && counter.resolved.join(' '))
ok('base 锚点线 resolved 长度 = 父2 + 自身3', counter && counter.resolved.length === 5, counter && counter.resolved.length)
ok('tos 与 resolved 等长且首手落点正确', counter && counter.tos.length === 5 && counter.tos[0] === 'd4', counter && counter.tos.join(','))

console.log('===== 非法着法处理：截断保留 / 整条丢弃 =====')
const BAD = '正文。===DEMO===\n{"lines":[{"id":"x","label":"坏线","tone":"bad","desc":"x","moves":["z9","e4"]}]}\n===END==='
ok('首手就非法（合法手数为 0）整条丢弃', coachDemo.parseDemo(BAD, ROOT).lines.length === 0)
const PARTIAL = '正文。===DEMO===\n{"lines":[{"id":"m","label":"主线走法","tone":"good","desc":"含一手册错误着法","moves":["e4","e5","z9","Nf3"]}]}\n===END==='
const partial = coachDemo.parseDemo(PARTIAL, ROOT)
ok('中途非法不再整条丢弃（保留合法前缀）', partial.lines.length === 1, partial.lines.length)
ok('截断后 moves 只含合法前缀', partial.lines[0] && partial.lines[0].moves.join(' ') === 'e4 e5', partial.lines[0] && partial.lines[0].moves.join(' '))
ok('截断后 resolved 与 tos 同步截断',
  partial.lines[0] && partial.lines[0].resolved.length === 2 && partial.lines[0].tos.length === 2,
  partial.lines[0] && (partial.lines[0].resolved.join(' ') + ' | ' + partial.lines[0].tos.join(',')))

console.log('===== SAN 规范化（挽救常见非标准写法） =====')
const MESSY = '正文。===DEMO===\n{"lines":[{"id":"m","label":"主线走法","tone":"good","desc":"x","moves":["1.e4","e5!?","Nf3.","Nc6?"]}]}\n===END==='
const messy = coachDemo.parseDemo(MESSY, ROOT)
ok('回合号前缀/评注符都被规范化',
  messy.lines.length === 1 && messy.lines[0].moves.join(' ') === 'e4 e5 Nf3 Nc6',
  messy.lines[0] && messy.lines[0].moves.join(' '))
const CASTLE_FEN = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'
const castle = coachDemo.parseDemo('正文。===DEMO===\n{"lines":[{"id":"m","label":"易位","tone":"good","desc":"x","moves":["1.0-0!?"]}]}\n===END===', CASTLE_FEN)
ok('易位零写法 0-0 规范化为 O-O 且可解析',
  castle.lines.length === 1 && castle.lines[0].moves.join(' ') === 'O-O',
  castle.lines[0] && castle.lines[0].moves.join(' '))

console.log('===== 无 demo 段 / JSON 损坏降级 =====')
ok('无 ===DEMO=== 时返回空', coachDemo.parseDemo('普通点评，没有走法数据。', ROOT).lines.length === 0)
ok('JSON 损坏不抛错', coachDemo.parseDemo('===DEMO===\n{不是合法json\n===END===', ROOT).lines.length === 0)

console.log('===== base 成环丢弃 =====')
const CYCLE = '正文。===DEMO===\n{"lines":[' +
  '{"id":"a","label":"A","tone":"good","desc":"a","base":{"line":"b","ply":1},"moves":["e4"]},' +
  '{"id":"b","label":"B","tone":"bad","desc":"b","base":{"line":"a","ply":1},"moves":["e5"]}]}\n===END==='
ok('base 成环时丢弃线', coachDemo.parseDemo(CYCLE, ROOT).lines.length === 0, coachDemo.parseDemo(CYCLE, ROOT).lines.length)

console.log('===== tokenizeText（正文，branch 模式） =====')
const segs = coachDemo.tokenizeText('黑后在 d6 施压，白方可走 e4 或 Nf3。', { lines: parsed.lines, colorMode: 'branch' })
ok('切分出可点记号', segs && segs.some(s => s.kind !== ''), segs && segs.filter(s => s.kind !== '').map(s => s.text).join(','))
ok('黑后识别为棋子记号', segs.some(s => s.kind === 'piece' && s.piece === 'bq'), segs.filter(s => s.kind === 'piece').map(s => s.piece).join(','))
ok('d6 识别为格子记号（无语境线，ply=0）', segs.some(s => s.kind === 'sq' && s.sq === 'd6' && !s.line && s.ply === 0))
ok('e4 命中 main 线第 1 手', segs.some(s => s.kind === 'move' && s.text === 'e4' && s.line === 'main' && s.ply === 1))
ok('Nf3 命中 main 线第 3 手', segs.some(s => s.kind === 'move' && s.text === 'Nf3' && s.line === 'main' && s.ply === 3))
ok('正文记号按分支着色（ln-0）', segs.some(s => s.text === 'e4' && s.cls.indexOf('ln-0') !== -1))
ok('普通文字不被标记', segs.some(s => s.kind === '' && s.text.indexOf('施压') !== -1))
ok('每段带字符串唯一键', segs.every(s => typeof s.key === 'string' && s.key.length > 0))

const kg2 = coachDemo.tokenizeText('Kg2 c1象', { lines: parsed.lines, colorMode: 'branch' })
ok('SAN 内的格子不被误切（Kg2 整体是普通文字）', !kg2.some(s => s.sq === 'g2') && kg2.some(s => s.kind === '' && s.text.indexOf('Kg2') !== -1), kg2.map(s => s.text).join('|'))
ok('「c1象」的 c1 作为格子可点（高亮该格即高亮该子）', kg2.some(s => s.kind === 'sq' && s.sq === 'c1'))

console.log('===== tokenizeText（分支描述，side 模式） =====')
const mainLine = parsed.lines[0]
const descSegs = coachDemo.tokenizeText(mainLine.desc, { lines: parsed.lines, ctxLineId: 'main', colorMode: 'side', rootTurn: 'w' })
ok('描述里的 e4 是白方手（side-w）', descSegs.some(s => s.text === 'e4' && s.cls.indexOf('side-w') !== -1), descSegs.filter(s => s.kind === 'move').map(s => s.text + ':' + s.cls).join(','))
ok('描述里的 e5 / Nc6 是黑方手（side-b）',
  descSegs.some(s => s.text === 'e5' && s.cls.indexOf('side-b') !== -1) &&
  descSegs.some(s => s.text === 'Nc6' && s.cls.indexOf('side-b') !== -1))
ok('描述里不串线（d4 不出现在 main 的描述记号里）', !descSegs.some(s => s.line === 'avoid'))
const counterSegs = coachDemo.tokenizeText(counter.desc, { lines: parsed.lines, ctxLineId: 'counter', colorMode: 'side', rootTurn: 'w' })
ok('分支描述里的 Nc6 命中本线（counter 第2手，黑方）',
  counterSegs.some(s => s.text === 'Nc6' && s.line === 'counter' && s.ply === 2 && s.cls.indexOf('side-b') !== -1),
  counterSegs.filter(s => s.kind === 'move').map(s => s.text + ':' + s.cls).join(','))

console.log('===== DemoSession 重放 =====')
const session = new coachDemo.DemoSession(parsed.lines, ROOT, { flipped: false })
session.enter('main')
let v = session.view()
ok('进入后 active', v.active === true)
ok('棋盘渲染 64 格', v.cells.length === 64, v.cells.length)
ok('面包屑含线标签', v.breadcrumb.indexOf('主线走法') !== -1, v.breadcrumb)
ok('初始 cursor=0 且只能前进', v.cursor === 0 && v.canBack === false && v.canForward === true)
session.step(1)
v = session.view()
ok('前进一步 cursor=1', v.cursor === 1 && v.canBack === true)
ok('面包屑显示当前手', v.breadcrumb.indexOf('e4') !== -1, v.breadcrumb)
session.step(1)
session.step(1)
session.step(1)
session.step(1)
v = session.view()
ok('到末尾 canForward=false', v.canForward === false && v.cursor === 5)
session.step(-1)
v = session.view()
ok('后退 cursor=4 且可前进', v.cursor === 4 && v.canForward === true)
session.enterAt('counter', 2)
v = session.view()
ok('enterAt 跳到 counter 第2步', v.lineId === 'counter' && v.cursor === 2, v.lineId + '/' + v.cursor)
ok('counter 第2步为 Nc6', v.breadcrumb.indexOf('Nc6') !== -1, v.breadcrumb)
ok('counter 面包屑标明继承自 avoid', v.breadcrumb.indexOf('对比走法（d4）') !== -1, v.breadcrumb)

console.log('===== 位置焦点（focus） =====')
session.setFocus(['d6'])
v = session.view()
ok('setFocus 后对应格打上 focus 标记', v.cells.some(c => c.sq === 'd6' && c.cls.indexOf('focus') !== -1))
session.enterAt('main', 2)
v = session.view()
ok('换线后焦点自动清除', !v.cells.some(c => c.cls.indexOf('focus') !== -1))
session.enter('main')
ok('findPieces 在起始局面找到黑后 d8', session.findPieces('bq').join(',') === 'd8', session.findPieces('bq').join(','))
session.step(1)
ok('走一步后 findPieces 找黑后仍是 d8', session.findPieces('bq').join(',') === 'd8', session.findPieces('bq').join(','))

console.log('===== 分支列表视图（lineViews） =====')
const views = session.lineViews()
ok('每条线带按序号着色的标签类', views[0].cls === 'demo-label-0' && views[1].cls === 'demo-label-1')
ok('描述切成了可点片段', views[0].segs.length > 0 && views[0].segs.some(s => s.kind === 'move' && s.cls.indexOf('side-w') !== -1), views[0].segs.filter(s => s.kind !== '').map(s => s.text).join(','))
ok('描述片段 key 为字符串', views.every(l => l.segs.every(s => typeof s.key === 'string')))
ok('每条线都带完整走法片段（主线 5 手）', views[0].moves.length >= 5 && views[0].moves.filter(m => m.line).length === 5, views[0].moves.map(m => m.text).join('|'))
ok('走法片段按本线顺序含全部手', views[0].moves.filter(m => m.line).map(m => m.text.trim()).join(' ') === 'e4 e5 Nf3 Nc6 c4', views[0].moves.filter(m => m.line).map(m => m.text.trim()).join(' '))
ok('走法片段 ply 为 1 基且递增', views[0].moves.filter(m => m.line).map(m => m.ply).join(',') === '1,2,3,4,5')
ok('走法按行棋方着色（白 side-w / 黑 side-b）', views[0].moves.filter(m => m.line).map(m => m.cls).join(',') === 'side-w,side-b,side-w,side-b,side-w', views[0].moves.filter(m => m.line).map(m => m.cls).join(','))
ok('走法片段点击跳到对应分支（line=main）', views[0].moves.filter(m => m.line).every(m => m.line === 'main'))
ok('白方步前标回合号、黑方步跟随（5手中白3黑2 → 3 个纯文本回合号）', views[0].moves.filter(m => !m.line).length === 3 && views[0].moves.filter(m => !m.line).every(t => /\d+\./.test(t.text)), views[0].moves.map(m => (m.line ? '[' + m.text.trim() + ']' : m.text.trim())).join(' '))
ok('首个片段是回合号 1.', views[0].moves[0].text.indexOf('1.') === 0, views[0].moves[0].text)
ok('base 锚点线只列本线走法（counter 列 c4 Nc6 e4，不含前缀 d4 d5）', views.find(l => l.id === 'counter').moves.filter(m => m.line).map(m => m.text.trim()).join(' ') === 'c4 Nc6 e4', views.find(l => l.id === 'counter').moves.filter(m => m.line).map(m => m.text.trim()).join(' '))

console.log('===== 翻转 / 退出 / 播放 =====')
session.flip()
v = session.view()
ok('翻转后棋盘朝向改变（首格不再是 a8）', v.cells[0].sq !== 'a8', v.cells[0].sq)
session.exit()
v = session.view()
ok('退出后 active=false', v.active === false)

const s2 = new coachDemo.DemoSession(parsed.lines, ROOT, { flipped: false })
s2.enter('main')
s2.play()
ok('播放中 playing=true', s2.playing === true)
s2.pause()
ok('暂停后 playing=false 且计时器清除', s2.playing === false && s2._timer === null)
s2.exit()

console.log('\n===== 纯文本导出（复制用） =====')
const plain = coachDemo.linePlainText(parsed.lines.find(l => l.id === 'main'), 'w')
ok('单条分支导出含标签与手数', plain.indexOf('主线走法') !== -1 && plain.indexOf('手）') !== -1, plain)
ok('单条分支导出含走法序列', /走法：\d+\./.test(plain), plain)
const all = coachDemo.branchPlainText(parsed.lines, 'w')
ok('全部分支导出合并多条', all.split('\n').filter(s => s.indexOf('•') === 0).length === 3, all)
const full = coachDemo.coachPlainText('白方略优。', parsed.lines, 'w')
ok('整段点评导出 = 正文 + 分支', full.indexOf('白方略优') !== -1 && full.indexOf('分支走法') !== -1, full)
ok('无分支时整段点评只剩正文', coachDemo.coachPlainText('只有正文', [], 'w') === '只有正文')
ok('空正文 + 分支 导出分支', coachDemo.coachPlainText('   ', parsed.lines, 'w') === all)

console.log('\n' + (failed === 0 ? 'ALL PASSED' : failed + ' CHECK(S) FAILED'))
process.exit(failed === 0 ? 0 : 1)
