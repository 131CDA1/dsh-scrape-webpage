/**
 * dsh-scrape-webpage —— 网页抓取与分析插件（宿主组合行，Host-only，零依赖）。
 *
 * 能力：
 *  - 注册模型工具 `scrape_webpage`：抓取网页并提取标题/描述/正文/标题结构/链接，
 *    统计字符数、词数、预计阅读时长，计算高频关键词（中文二元组 + 英文单词，含停用词过滤）。
 *  - 可选下载页面内容图片（images 参数，上限 6 张）到会话工作区 .scrape-images 目录，
 *    返回本地路径供视觉模型 read_image 分析。
 *  - 提供 `scrape.imageAnalyzer` 服务（register/list/analyze）：识图插件注册分析器后，
 *    下载的图片自动交给分析器，结果附在工具输出的 imageAnalysis 中。
 *
 * 抓取链路与安全：
 *  - 优先使用宿主 web 服务的 fetch provider（若部署了）；否则经 shell 服务调用 curl.exe。
 *  - 默认在沙箱内（会话策略）执行；HTTPS 因沙箱 TLS 凭据受限失败时返回
 *    escalation available 提示，模型可用 sandbox_permissions="danger-full-access"
 *    + justification 重试一次，由审批弹窗决定（与 pwsh 工具的升级契约一致）。
 *  - 依赖宿主服务：tools、systemPrompt、timer（硬依赖）；web、shell、sandboxPolicy、
 *    approval、sessions（可选，缺失时优雅降级报错）。
 */

export const name = 'dsh-scrape-webpage'
export const inject = ['timer', 'tools', 'systemPrompt']

// ===== HTML / 文本工具函数 =====

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

const CJK_RANGE = '[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]'

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

// ===== 统计与关键词 =====

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

// ===== 插件主体 =====

export function apply(ctx) {
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const cancel = ctx.timeout(() => reject(new Error('抓取超时（超过 ' + Math.round(ms / 1000) + ' 秒）')), ms)
      promise.then(
        (v) => { cancel(); resolve(v) },
        (err) => { cancel(); reject(err) }
      )
    })
  }

  // ===== 识图分析器扩展接口（发布到宿主 realm，供识图插件注册） =====
  const analyzerRegistry = {
    analyzers: new Map(),
    register(analyzer) {
      if (analyzer === null || typeof analyzer !== 'object' || typeof analyzer.analyze !== 'function') {
        throw new Error('scrape.imageAnalyzer.register 需要 { id, analyze(image) } 对象')
      }
      const id = String(analyzer.id || 'anon-' + Date.now())
      this.analyzers.set(id, analyzer)
      return () => { this.analyzers.delete(id) }
    },
    list() {
      return Array.from(this.analyzers.keys())
    },
    async analyze(image) {
      for (const entry of Array.from(this.analyzers.entries())) {
        try {
          const r = await entry[1].analyze(image)
          if (r && typeof r === 'object' && typeof r.text === 'string' && r.text) {
            return { analyzerId: entry[0], text: r.text }
          }
        } catch (err) {
          console.error('scrape image analyzer failed:', err)
        }
      }
      return null
    },
  }
  ctx.provide('scrape.imageAnalyzer', analyzerRegistry)

  function resolveSessionPolicy(exec, sessionId) {
    const sp = ctx.get('sandboxPolicy')
    if (sp === undefined) return undefined
    let session = undefined
    if (exec && exec.agent && exec.agent.session) session = exec.agent.session
    else if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
      const sessions = ctx.get('sessions')
      session = sessions ? sessions.get(sessionId) : undefined
    }
    const resolved = sp.resolve(session !== undefined ? { session } : {})
    return { mode: resolved.mode, workspaceRoot: resolved.workspaceRoot, sessionId: resolved.sessionId }
  }

  function buildCurlCommand(u) {
    const psUrl = String(u).replace(/'/g, "''")
    return [
      "$ProgressPreference='SilentlyContinue';",
      '& curl.exe -sS -L --max-time 20 --connect-timeout 8',
      "-A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'",
      '-w "`n__DSH_META__:%{http_code}|%{content_type}|%{url_effective}"',
      "'" + psUrl + "'"
    ].join(' ')
  }

  async function fetchViaShell(shell, url, policy, signal) {
    const request = {
      command: buildCurlCommand(url),
      timeoutMs: 30000,
      stdoutMaxBytes: 1500000
    }
    if (signal !== undefined) request.signal = signal
    if (policy !== undefined) request.sandboxPolicy = policy
    let result = null
    try {
      result = await shell.run(shell.resolve(request))
    } catch (err) {
      throw new Error('命令执行失败：' + String((err && err.message) || err))
    }
    const out = String((result && result.stdout && result.stdout.text) || '')
    const markerIdx = out.lastIndexOf('__DSH_META__:')
    if (markerIdx === -1) {
      const errText = String((result && result.stderr && result.stderr.text) || '').trim()
      const code = result && result.exitCode
      const parts = []
      if (result && result.timedOut) parts.push('抓取超时')
      if (result && result.aborted) parts.push('抓取被中断')
      if (code !== 0 && code !== undefined && code !== null) parts.push('curl 退出码 ' + code)
      if (errText) parts.push(errText.slice(0, 400))
      throw new Error(parts.join('；') || '无法解析抓取结果')
    }
    const metaLine = out.slice(markerIdx + '__DSH_META__:'.length).split('\n')[0]
    const firstBar = metaLine.indexOf('|')
    const codeStr = firstBar >= 0 ? metaLine.slice(0, firstBar) : metaLine
    const rest = firstBar >= 0 ? metaLine.slice(firstBar + 1) : ''
    const secondBar = rest.indexOf('|')
    const contentType = secondBar >= 0 ? rest.slice(0, secondBar) : rest
    const finalUrl = secondBar >= 0 ? rest.slice(secondBar + 1) : ''
    const statusCode = Number(codeStr)
    if (!Number.isFinite(statusCode) || statusCode === 0) {
      const errText = String((result && result.stderr && result.stderr.text) || '').trim()
      throw new Error('抓取失败' + (errText ? '：' + errText.slice(0, 400) : ''))
    }
    const content = out.slice(0, markerIdx).replace(/\r?\n$/, '')
    const truncated = Boolean(result && result.stdout && result.stdout.truncated) || content.length > 1500000
    return {
      url: finalUrl || url,
      statusCode,
      truncated,
      body: { kind: String(contentType || '').includes('html') ? 'html' : 'text', content: content.slice(0, 1500000) }
    }
  }

  function buildImageCommand(url, binPath) {
    const psUrl = String(url).replace(/'/g, "''")
    const psPath = String(binPath).replace(/'/g, "''")
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
    const parts = []
    parts.push("$ProgressPreference='SilentlyContinue';")
    parts.push("$f='" + psPath + "';")
    parts.push('$meta = (& curl.exe -sS -L --max-time 8 --connect-timeout 6')
    parts.push("-A '" + ua + "'")
    parts.push('-w "`n__DSH_META__:%{http_code}|%{content_type}"')
    parts.push('-o $f')
    parts.push("'" + psUrl + "'")
    parts.push(')')
    parts.push('-join "`n";')
    parts.push('$size = -1;')
    parts.push('if ($LASTEXITCODE -eq 0 -and (Test-Path $f)) { $size = (Get-Item $f).Length };')
    parts.push('$line = ($meta -split "`n" | Where-Object { $_ -like "__DSH_META__:*" } | Select-Object -Last 1);')
    parts.push("$ct = ''; if ($line -match '\\|([^|]*)$') { $ct = $Matches[1] };")
    parts.push('if ($size -gt 0) {')
    parts.push("  $ext = 'bin'; switch -Wildcard ($ct) { 'image/png*' {$ext='png'} 'image/jpeg*' {$ext='jpg'} 'image/webp*' {$ext='webp'} 'image/gif*' {$ext='gif'} 'image/avif*' {$ext='avif'} 'image/bmp*' {$ext='bmp'} };")
    parts.push("  $new = $f -replace '\\.bin$', ('.' + $ext); if ($new -ne $f) { Move-Item -Force $f $new; $f = $new };")
    parts.push('} else { Remove-Item -Force -ErrorAction SilentlyContinue $f };')
    parts.push('Write-Output ("META:" + $line);')
    parts.push('Write-Output ("CT:" + $ct);')
    parts.push('Write-Output ("FILE:" + $f);')
    parts.push('Write-Output ("SIZE:" + $size)')
    return parts.join(' ')
  }

  async function downloadImages(shell, urls, dir, workspaceRoot, policy, signal) {
    const notes = []
    const images = []
    if (!urls || urls.length === 0) return { images, note: '' }
    const mkdir = [
      "$ProgressPreference='SilentlyContinue';",
      "New-Item -ItemType Directory -Force -Path '" + String(dir).replace(/'/g, "''") + "' | Out-Null"
    ].join(' ')
    try {
      await shell.run(shell.resolve({ command: mkdir, timeoutMs: 15000, ...policy !== undefined ? { sandboxPolicy: policy } : {}, ...signal !== undefined ? { signal } : {} }))
    } catch (err) {
      return { images, note: '创建图片目录失败：' + String((err && err.message) || err) }
    }
    const rootLen = String(workspaceRoot).replace(/[\\\/]+$/, '').length + 1
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      const binPath = dir + '\\img-' + String(i + 1).padStart(3, '0') + '.bin'
      try {
        const result = await shell.run(shell.resolve({
          command: buildImageCommand(url, binPath),
          timeoutMs: 20000,
          stdoutMaxBytes: 20000,
          ...policy !== undefined ? { sandboxPolicy: policy } : {},
          ...signal !== undefined ? { signal } : {}
        }))
        const out = String((result && result.stdout && result.stdout.text) || '')
        const metaM = /META:__DSH_META__:(\d+)\|([^\r\n]*)/.exec(out)
        const sizeM = /SIZE:(-?\d+)/.exec(out)
        const fileM = /FILE:([^\r\n]*)/.exec(out)
        const statusCode = metaM ? Number(metaM[1]) : 0
        const contentType = metaM ? String(metaM[2] || '') : ''
        const size = sizeM ? Number(sizeM[1]) : -1
        const filePath = fileM ? String(fileM[1]).trim() : binPath
        if (statusCode === 200 && size > 0) {
          const relPath = filePath.slice(rootLen)
          images.push({ url, filePath, relPath, mime: contentType || '', size })
        } else {
          const errText = String((result && result.stderr && result.stderr.text) || '').trim()
          notes.push('第 ' + (i + 1) + ' 张下载失败（HTTP ' + statusCode + '）' + (errText ? '：' + errText.slice(0, 120) : '') + ' → ' + url)
        }
      } catch (err) {
        notes.push('第 ' + (i + 1) + ' 张下载异常：' + String((err && err.message) || err))
      }
    }
    return { images, note: notes.slice(0, 5).join('；') }
  }

  function resolveEscalationPolicy(input, exec, basePolicy, signal) {
    const requested = input && input.sandbox_permissions
    if (requested === undefined || requested === null) return { policy: basePolicy, error: null }
    const justification = String((input && input.justification) || '').trim()
    if (justification === '') {
      return { policy: undefined, error: '使用 sandbox_permissions 时必须同时提供 justification（一句话说明为何需要更宽权限）' }
    }
    if (requested !== 'danger-full-access') {
      return { policy: undefined, error: '不支持的 sandbox_permissions：' + requested + '（仅支持 danger-full-access）' }
    }
    const effective = basePolicy ? basePolicy.mode : 'workspace-write'
    if (effective === 'danger-full-access') {
      return { policy: { mode: 'danger-full-access' }, error: null }
    }
    const approvalSvc = ctx.get('approval')
    const agent = exec && exec.agent
    if (approvalSvc === undefined || agent === undefined) {
      return { policy: undefined, error: '沙箱升级到 danger-full-access 需要审批服务和 Agent 上下文，当前调用不具备' }
    }
    return {
      policy: null,
      error: null,
      pending: async () => {
        let outcome = null
        try {
          outcome = await approvalSvc.request({
            agent,
            toolName: 'scrape_webpage',
            ...exec.callId !== undefined ? { callId: exec.callId } : {},
            reason: 'escalate sandbox to danger-full-access: ' + justification,
            ...signal !== undefined ? { signal } : {}
          })
        } catch (err) {
          throw new Error('审批请求失败：' + String((err && err.message) || err))
        }
        if (outcome === 'allowed-once') return { mode: 'danger-full-access' }
        if (outcome === 'rejected') throw new Error('用户拒绝了以完整权限抓取该网页')
        if (outcome === 'cancelled') throw new Error('审批已取消')
        throw new Error('审批不可用：' + outcome)
      }
    }
  }

  async function scrapePage(input, exec) {
    const url = normalizeUrl(input && input.url)
    const rawMax = Number(input && input.maxChars)
    const maxChars = Math.min(Math.max(Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 30000, 1000), 100000)
    const rawImages = Number(input && input.images)
    const imagesWanted = Math.min(Math.max(Number.isFinite(rawImages) && rawImages > 0 ? Math.floor(rawImages) : 0, 0), 6)
    const signal = exec && exec.signal
    const sessionId = input && input.sessionId
    const basePolicy = resolveSessionPolicy(exec, sessionId)
    const esc = resolveEscalationPolicy(input, exec, basePolicy, signal)
    if (esc.error !== null) return { error: esc.error, url }
    let policy = esc.policy
    if (policy === null) {
      try {
        policy = await esc.pending()
      } catch (err) {
        return { error: String((err && err.message) || err), url }
      }
    }
    let fetched = null
    const web = ctx.get('web')
    if (web !== undefined) {
      try {
        fetched = await web.fetch({ url }, signal)
      } catch (err) {
        // 无可用 provider，落到 shell/curl 路径
      }
    }
    if (fetched === null) {
      const shell = ctx.get('shell')
      if (shell === undefined) {
        return { error: '当前环境既没有可用的 web 抓取 provider，也没有 shell 服务，无法抓取网页', url }
      }
      try {
        fetched = await fetchViaShell(shell, url, policy, signal)
      } catch (err) {
        const msg = String((err && err.message) || err)
        const tlsBlocked = /schannel|SEC_E|credential/i.test(msg)
        const isConfined = policy === undefined || (policy !== null && policy.mode !== 'danger-full-access')
        if (tlsBlocked && isConfined && /^https:/i.test(url)) {
          return {
            error: '沙箱内无法完成 HTTPS 抓取（TLS 凭据受限）。[sandbox: escalation available — retry this exact scrape once with sandbox_permissions="danger-full-access" + justification; the approval prompt asks the user] 详情：' + msg,
            url
          }
        }
        return { error: msg, url }
      }
    }
    const body = fetched.body || {}
    const kind = body.kind === 'html' ? 'html' : 'text'
    const content = typeof body.content === 'string' ? body.content : ''
    const parsed = kind === 'html' ? extractFromHtml(content) : { title: '', description: '', headings: [], links: [], text: content }
    const fullText = parsed.text || ''
    const truncated = Boolean(fetched.truncated) || fullText.length > maxChars
    const text = fullText.slice(0, maxChars)
    const stats = computeStats(text, parsed.headings.length, parsed.links.length)
    let images = []
    let imageNote = ''
    let imageAnalysis = []
    if (imagesWanted > 0) {
      if (kind !== 'html') {
        imageNote = '目标不是 HTML 页面，跳过图片提取'
      } else if (basePolicy === undefined || !basePolicy.workspaceRoot) {
        imageNote = '无法确定会话工作区路径，跳过图片下载'
      } else {
        const urls = extractImages(content, fetched.url || url, imagesWanted)
        if (urls.length === 0) {
          imageNote = '页面中未发现内容图片'
        } else {
          const shell = ctx.get('shell')
          if (shell === undefined) {
            imageNote = '缺少 shell 服务，无法下载图片'
          } else {
            const dir = String(basePolicy.workspaceRoot).replace(/[\\\/]+$/, '') + '\\.scrape-images\\' + String(Date.now())
            const dl = await downloadImages(shell, urls, dir, basePolicy.workspaceRoot, policy, signal)
            images = dl.images
            imageNote = dl.note
            for (const img of images) {
              const r = await analyzerRegistry.analyze({
                url: img.url,
                filePath: img.filePath,
                relPath: img.relPath,
                mime: img.mime,
                size: img.size
              })
              if (r) imageAnalysis.push({ relPath: img.relPath, url: img.url, analyzerId: r.analyzerId, text: r.text })
            }
          }
        }
      }
    }
    return {
      url: fetched.url || url,
      statusCode: fetched.statusCode,
      truncated,
      title: (parsed.title || '').slice(0, 500),
      description: (parsed.description || '').slice(0, 1000),
      headings: parsed.headings.map((h) => 'H' + h.level + ' ' + h.text),
      links: parsed.links,
      text,
      stats,
      keywords: topKeywords(text, 30),
      images,
      imageNote,
      imageAnalysis
    }
  }

  ctx.tools.register({
    name: 'scrape_webpage',
    description: '抓取一个网页 URL 的完整内容并做基础分析：提取标题、页面描述、正文、标题层级与链接，统计字符数/词数/预计阅读时长，并计算高频关键词。可选下载页面中的内容图片（images 参数）到会话工作区，返回本地路径供 read_image 工具视觉分析；若注册了识图分析器（scrape.imageAnalyzer 服务），图片会自动交给分析器并附上识别结果。默认在沙箱内抓取；如果结果报告沙箱 TLS 受限（escalation available 提示），以 sandbox_permissions="danger-full-access" 加一句话 justification 重试同一次抓取，审批弹窗会询问用户。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网页地址（http/https）。' },
        maxChars: { type: 'number', description: '返回正文的最大字符数，默认 30000，范围 1000–100000。' },
        images: { type: 'number', description: '同时下载页面中的内容图片用于视觉分析：0=不下载（默认），>0 表示最多下载的图片数量（上限 6）。图片保存到会话工作区 .scrape-images 目录，返回本地路径，可用 read_image 工具查看。' },
        sandbox_permissions: { type: 'string', enum: ['danger-full-access'], description: '更宽的沙箱模式。仅作为刚被沙箱拒绝的同一次抓取的一次性重试参数；需要用户审批。' },
        justification: { type: 'string', description: '必须与 sandbox_permissions 同时提供：一句话说明为什么这次抓取需要更宽权限。' }
      },
      required: ['url']
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          statusCode: { type: 'number' },
          truncated: { type: 'boolean' },
          title: { type: 'string' },
          description: { type: 'string' },
          headings: { type: 'array', items: { type: 'string' } },
          links: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { href: { type: 'string' }, text: { type: 'string' } }
            }
          },
          text: { type: 'string' },
          stats: {
            type: 'object',
            additionalProperties: false,
            properties: {
              charCount: { type: 'number' },
              wordCount: { type: 'number' },
              cjkCount: { type: 'number' },
              headingCount: { type: 'number' },
              linkCount: { type: 'number' },
              readingTimeMinutes: { type: 'number' },
              language: { type: 'string' }
            }
          },
          keywords: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { word: { type: 'string' }, count: { type: 'number' } }
            }
          },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string' },
                filePath: { type: 'string' },
                relPath: { type: 'string' },
                mime: { type: 'string' },
                size: { type: 'number' }
              }
            }
          },
          imageNote: { type: 'string' },
          imageAnalysis: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                relPath: { type: 'string' },
                url: { type: 'string' },
                analyzerId: { type: 'string' },
                text: { type: 'string' }
              }
            }
          },
          error: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: formatScrapeText(value) }]
    },
    async execute(args, exec) {
      try {
        return await scrapePage(args || {}, exec)
      } catch (err) {
        return { error: String((err && err.message) || err), url: String((args && args.url) || '') }
      }
    }
  })

  ctx.systemPrompt.section({
    name: 'tool:scrape_webpage',
    order: 120,
    text: 'When the user asks to read, scrape, or analyze a specific web page, call the scrape_webpage tool with that URL. It returns the page title, description, main text, heading outline, links, reading stats, and top keywords; summarize and analyze the content in the conversation afterwards. Set images to a positive number to also download content images for visual analysis with the read_image tool on the returned local paths. If the result reports a sandbox TLS restriction with an escalation-available hint, retry the same scrape once with sandbox_permissions="danger-full-access" and a one-sentence justification; the approval prompt asks the user.'
  })
}
