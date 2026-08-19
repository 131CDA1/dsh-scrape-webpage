/**
 * dsh-scrape-webpage —— HTML / 文本解析工具（纯函数，无依赖）。
 *
 * 负责：HTML 标签剥离与实体解码、URL 归一化（相对路径 → 绝对 URL）、
 * 正文/标题结构/链接提取、内容图片 URL 提取。
 */

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ')
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
      const code = parseInt(h, 16)
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (m, d) => {
      const code = parseInt(d, 10)
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function cleanText(s) {
  return decodeEntities(s).replace(/[ \t\r\f\v]+/g, ' ').trim()
}

function normalizeUrl(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('URL 为空，请提供要抓取的网址')
  let candidate = raw
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate
  if (!/^https?:\/\/[^/\s?#]+/i.test(candidate)) throw new Error('无效的 URL：' + raw)
  return candidate
}

// 手工 URL 归一化（相对路径 → 绝对 URL）
function resolveUrl(base, href) {
  const h = String(href || '').trim()
  if (!h) return null
  if (/^https?:\/\//i.test(h)) return h
  if (h.startsWith('//')) return base.slice(0, base.indexOf(':')) + ':' + h
  if (h.startsWith('#') || /^(data:|javascript:|about:)/i.test(h)) return null
  const m = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?/i.exec(base)
  if (!m) return null
  const origin = m[1] + '://' + m[2]
  const basePath = m[3] || '/'
  let resolved
  if (h.startsWith('/')) resolved = h
  else resolved = basePath.slice(0, basePath.lastIndexOf('/') + 1) + h
  const parts = resolved.split('/')
  const out = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return origin + '/' + out.join('/')
}

// 从 HTML 提取内容图片 URL（跳过图标/logo 等噪音）
function extractImages(html, baseUrl, limit) {
  const found = []
  const seen = new Set()
  const src0 = String(html || '').replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  const re = /<img\b[^>]*>/gi
  let m
  while ((m = re.exec(src0)) !== null) {
    const tag = m[0]
    const srcM = /\bsrc=["']([^"']+)["']/i.exec(tag) || /\bdata-src=["']([^"']+)["']/i.exec(tag) || /\bsrcset=["']([^"']+)["']/i.exec(tag)
    if (!srcM) continue
    let src = String(srcM[1])
    if (src.includes(',')) src = src.split(',')[0].trim().split(/\s+/)[0]
    if (/^(data:|javascript:|about:|#)/i.test(src)) continue
    const abs = resolveUrl(baseUrl, src)
    if (!abs) continue
    if (/\.(svg|ico)(\?|#|$)/i.test(abs)) continue
    if (/(icon|logo|avatar|emoji|badge|qr|sprite|loading)/i.test(abs)) continue
    if (seen.has(abs)) continue
    seen.add(abs)
    found.push(abs)
    if (found.length >= limit) break
  }
  return found
}

function extractFromHtml(html) {
  const src0 = String(html || '')
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(src0)
  const title = titleMatch ? cleanText(stripTags(titleMatch[1])) : ''
  const descMatch = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i.exec(src0)
    || /<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i.exec(src0)
  const description = descMatch ? cleanText(descMatch[1]) : ''
  let src = src0
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  const headingList = []
  src = src.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (m, level, inner) => {
    const text = cleanText(stripTags(inner))
    if (text) headingList.push({ level: Number(level), text })
    return '\n' + text + '\n'
  })
  const linkList = []
  src = src.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (m, href, inner) => {
    const h = String(href || '').trim()
    const text = cleanText(stripTags(inner))
    if (h && !/^(javascript:|mailto:|tel:|data:)/i.test(h)) linkList.push({ href: h, text: text || h })
    return ' ' + (text || '') + ' '
  })
  src = src
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|ul|ol|table|dd|dt|figcaption)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '  ')
  const rawText = decodeEntities(stripTags(src))
  const text = rawText.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n')
  return { title, description, headings: headingList.slice(0, 100), links: linkList.slice(0, 100), text }
}

export { stripTags, decodeEntities, cleanText, normalizeUrl, resolveUrl, extractImages, extractFromHtml }
