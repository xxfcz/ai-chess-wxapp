/**
 * coach-demo.js
 * 向后兼容再导出层：实现已迁移到平台层 utils/comment-model.js（L0）。
 *
 * 历史页面与测试通过 require('coach-demo') 取 parseDemo / tokenizeText / DemoSession 等，
 * 这里原样再导出，保证零改动过渡。新增的「内联标记协议」（tokenizeInline / parseComment）
 * 请直接取 comment-model。
 */
module.exports = require('./comment-model')
