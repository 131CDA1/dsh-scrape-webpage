/**
 * dsh-scrape-webpage —— 文本统计与关键词分析（纯函数，无依赖）。
 *
 * 负责：高频关键词（中文二元组 + 英文单词，含停用词过滤）、
 * 字符/词数统计与阅读时长估算、语言倾向判断、工具结果文本渲染。
 */

const CJK_RANGE = '[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]'

const STOP_CJK = new Set(('的了是在和与及或有个中为上到下被把从对之这那也都而就不们我你他她它说要会能以样才子再但只又更最并且用着过得地所其每各此该如果若无没非应由向比让给去很已还则使将仍呢吗吧啊哦').split(''))
const STOP_LATIN = new Set(('the a an and or of to in on for with is are was were be been being as at by from this that it its you your we they he she i not no but if then than so can will would should could may also into about over more most other some such only new has have had do does did which who whom what when where how all any each both few many much their them there here just out up down off our us').split(' '))

function topKeywords(text, limit) {
  const freq = new Map()
  const bump = (w) => {
    if (!w) return
    freq.set(w, (freq.get(w) || 0) + 1)
  }
  const cjkChars = String(text).match(new RegExp(CJK_RANGE, 'g')) || []
  for (let i = 0; i < cjkChars.length - 1; i++) {
    const a = cjkChars[i]
    const b = cjkChars[i + 1]
    if (STOP_CJK.has(a) || STOP_CJK.has(b)) continue
    bump(a + b)
  }
  const words = String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => /^[a-z][a-z0-9'-]{1,}$/.test(w) && !STOP_LATIN.has(w))
  for (const w of words) bump(w)
  return Array.from(freq.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit || 30)
}

function computeStats(text, headingCount, linkCount) {
  const cjk = (String(text).match(new RegExp(CJK_RANGE, 'g')) || []).length
  const latinWords = (String(text).toLowerCase().match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) || []).length
  const charCount = String(text).replace(/\s/g, '').length
  const wordCount = cjk + latinWords
  const reading = Math.round(Math.max(cjk / 400, latinWords / 200) * 10) / 10
  const ratio = charCount > 0 ? cjk / charCount : 0
  const language = ratio > 0.35 ? '中文为主' : ratio > 0.05 ? '中英混合' : '英文为主'
  return { charCount, wordCount, cjkCount: cjk, headingCount, linkCount, readingTimeMinutes: reading, language }
}

function formatScrapeText(value) {
  if (value && value.error) {
    return '网页抓取失败：' + value.error + (value.url ? '\n目标 URL：' + value.url : '')
  }
  const stats = value.stats || {}
  const lines = []
  lines.push('网页抓取成功：' + (value.title || value.url || ''))
  lines.push('URL：' + (value.url || '') + '（HTTP ' + (value.statusCode === undefined ? '?' : value.statusCode) + (value.truncated ? '，内容已截断' : '') + '）')
  if (value.description) lines.push('页面描述：' + value.description)
  if (stats.language) lines.push('语言：' + stats.language)
  lines.push('统计：字符 ' + stats.charCount + '，词/字 ' + stats.wordCount + '，标题 ' + stats.headingCount + '，链接 ' + stats.linkCount + '，预计阅读 ' + stats.readingTimeMinutes + ' 分钟')
  if (value.keywords && value.keywords.length) {
    lines.push('高频关键词：' + value.keywords.slice(0, 20).map((k) => k.word + '×' + k.count).join('，'))
  }
  if (value.headings && value.headings.length) {
    lines.push('标题结构：')
    for (const h of value.headings.slice(0, 30)) lines.push('  ' + h)
  }
  if (value.text) lines.push('--- 正文 ---\n' + value.text)
  if (value.images && value.images.length) {
    lines.push('--- 已下载图片（可用 read_image 工具读取本地路径进行视觉分析）---')
    for (const img of value.images) lines.push('- ' + (img.relPath || img.filePath || '') + ' ← ' + img.url + '（' + (img.mime || 'image') + '，' + (img.size || 0) + ' 字节）')
  }
  if (value.imageNote) lines.push('图片备注：' + value.imageNote)
  if (value.imageAnalysis && value.imageAnalysis.length) {
    lines.push('--- 识图分析器结果 ---')
    for (const a of value.imageAnalysis) lines.push('[' + a.analyzerId + '] ' + (a.relPath || a.url || '') + '：' + a.text)
  }
  if (value.links && value.links.length) {
    lines.push('--- 链接（前 30 条）---')
    for (const l of value.links.slice(0, 30)) lines.push('- ' + (l.text || l.href) + ' → ' + l.href)
  }
  return lines.join('\n')
}

export { topKeywords, computeStats, formatScrapeText }
