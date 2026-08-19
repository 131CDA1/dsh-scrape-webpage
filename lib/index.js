/**
 * dsh-scrape-webpage —— 网页抓取与分析插件（宿主组合行，Host-only，零依赖）。
 *
 * 模块结构（低耦合：纯函数层 ← 服务层 ← 组合层）：
 *  - html.js     HTML/文本解析（纯函数）
 *  - analyze.js  统计与关键词分析（纯函数）
 *  - curl.js     curl 命令构建与结果解析（纯函数）
 *  - fetch.js    抓取执行层（会话沙箱策略、shell/curl 执行、审批升级）
 *  - index.js    插件主体（工具注册、编排、识图分析器服务）
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

import { normalizeUrl, extractImages, extractFromHtml } from './html.js'
import { computeStats, topKeywords, formatScrapeText } from './analyze.js'
import { createFetchLayer } from './fetch.js'

export const name = 'dsh-scrape-webpage'
export const inject = ['timer', 'tools', 'systemPrompt']

export function apply(ctx) {
  const { resolveSessionPolicy, fetchViaShell, downloadImages, resolveEscalationPolicy } = createFetchLayer(ctx)

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
