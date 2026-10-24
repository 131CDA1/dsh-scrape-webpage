/**
 * dsh-scrape-webpage —— 抓取执行层（依赖宿主服务，经 ctx 注入）。
 *
 * 负责：会话沙箱策略解析、页面/图片的 shell/curl 执行、
 * HTTPS TLS 受限时的沙箱审批升级（与 pwsh 工具契约一致）。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { buildCurlCommand, parseFetchOutput, buildImageCommand, parseImageOutput } from './curl.js'

export function createFetchLayer(ctx) {
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
    const parsed = parseFetchOutput(out, url)
    if (!parsed.ok) {
      const errText = String((result && result.stderr && result.stderr.text) || '').trim()
      if (parsed.reason === 'no-marker') {
        const code = result && result.exitCode
        const parts = []
        if (result && result.timedOut) parts.push('抓取超时')
        if (result && result.aborted) parts.push('抓取被中断')
        if (code !== 0 && code !== undefined && code !== null) parts.push('curl 退出码 ' + code)
        if (errText) parts.push(errText.slice(0, 400))
        throw new Error(parts.join('；') || '无法解析抓取结果')
      }
      throw new Error('抓取失败' + (errText ? '：' + errText.slice(0, 400) : ''))
    }
    const truncated = Boolean(result && result.stdout && result.stdout.truncated) || parsed.content.length > 1500000
    return {
      url: parsed.finalUrl || url,
      statusCode: parsed.statusCode,
      truncated,
      body: { kind: String(parsed.contentType || '').includes('html') ? 'html' : 'text', content: parsed.content.slice(0, 1500000) }
    }
  }

  // ===== 图片下载：Node 直连为主，shell/curl 仅在真的可用时兜底 =====
  // 旧实现第一步就调 shell.run 建目录，而本机宿主 shell 服务没有 run 方法，
  // 于是恒抛 "shell.run is not a function"，图片永远下不下来。改为 Node fetch 直连。

  const IMAGE_EXT_BY_MIME = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico'
  }
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024

  function pickImageExt(contentType, url) {
    const ct = String(contentType || '').split(';')[0].trim().toLowerCase()
    if (IMAGE_EXT_BY_MIME[ct] !== undefined) return IMAGE_EXT_BY_MIME[ct]
    const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(String(url || ''))
    if (m !== null) {
      const ext = m[1].toLowerCase()
      if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg', 'ico'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext
    }
    return 'bin'
  }

  async function downloadImageViaNode(url, binPath, signal) {
    let reqSignal = signal
    if (reqSignal === undefined && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      reqSignal = AbortSignal.timeout(15000)
    }
    const res = await fetch(url, {
      redirect: 'follow',
      ...(reqSignal !== undefined ? { signal: reqSignal } : {}),
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    })
    const type = String(res.headers.get('content-type') || '')
    if (!res.ok) return { statusCode: res.status, contentType: type, size: -1, filePath: binPath }
    if (!type.toLowerCase().startsWith('image/')) return { statusCode: res.status, contentType: type, size: -1, filePath: binPath, notImage: true }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return { statusCode: res.status, contentType: type, size: -1, filePath: binPath }
    if (buf.length > MAX_IMAGE_BYTES) return { statusCode: res.status, contentType: type, size: buf.length, filePath: binPath, tooLarge: true }
    const finalPath = binPath.replace(/\.bin$/, '.' + pickImageExt(type, url))
    await writeFile(finalPath, buf)
    return { statusCode: res.status, contentType: type, size: buf.length, filePath: finalPath }
  }

  async function downloadImages(shell, urls, dir, workspaceRoot, policy, signal) {
    const notes = []
    const images = []
    if (!urls || urls.length === 0) return { images, note: '' }
    try {
      await mkdir(dir, { recursive: true })
    } catch (err) {
      return { images, note: '创建图片目录失败：' + String((err && err.message) || err) }
    }
    const rootLen = String(workspaceRoot).replace(/[\\\/]+$/, '').length + 1
    const shellUsable = shell !== undefined && shell !== null && typeof shell.run === 'function'
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      const binPath = dir + '\\img-' + String(i + 1).padStart(3, '0') + '.bin'
      let parsed = null
      let failure = ''
      // 1) Node 直连（主路径）
      try {
        const r = await downloadImageViaNode(url, binPath, signal)
        if (r.statusCode === 200 && r.size > 0 && r.filePath !== binPath) parsed = r
        else if (r.tooLarge === true) failure = '文件过大（' + r.size + ' 字节）'
        else if (r.notImage === true) failure = '响应不是图片（' + (r.contentType || '未知类型') + '）'
        else failure = 'HTTP ' + r.statusCode
      } catch (err) {
        failure = 'Node 下载失败：' + String((err && err.message) || err)
      }
      // 1b) 4xx 且带查询串时，去掉 query 再试一次：不少图床/对象存储对残缺或未签名的
      //     缩略图参数直接回 400，而原图 URL 是通的。
      if (parsed === null && /^HTTP 4\d\d/.test(failure) && url.includes('?')) {
        try {
          const stripped = url.slice(0, url.indexOf('?'))
          const r2 = await downloadImageViaNode(stripped, binPath, signal)
          if (r2.statusCode === 200 && r2.size > 0 && r2.filePath !== binPath) {
            parsed = r2
            failure = ''
          }
        } catch (err) {
          // 保留第一次的失败原因
        }
      }
      // 2) shell/curl 兜底（仅当 shell 真提供 run 时）
      if (parsed === null && shellUsable) {
        try {
          const result = await shell.run(shell.resolve({
            command: buildImageCommand(url, binPath),
            timeoutMs: 20000,
            stdoutMaxBytes: 20000,
            ...policy !== undefined ? { sandboxPolicy: policy } : {},
            ...signal !== undefined ? { signal } : {}
          }))
          const out = String((result && result.stdout && result.stdout.text) || '')
          const fallback = parseImageOutput(out, binPath)
          if (fallback.statusCode === 200 && fallback.size > 0) parsed = fallback
          else {
            const errText = String((result && result.stderr && result.stderr.text) || '').trim()
            failure = 'HTTP ' + fallback.statusCode + (errText ? '：' + errText.slice(0, 120) : '')
          }
        } catch (err) {
          failure = String((err && err.message) || err)
        }
      }
      if (parsed !== null) {
        const relPath = parsed.filePath.slice(rootLen)
        images.push({ url, filePath: parsed.filePath, relPath, mime: parsed.contentType || '', size: parsed.size })
      } else {
        notes.push('第 ' + (i + 1) + ' 张下载失败（' + (failure || '未知原因') + '）→ ' + url)
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

  /**
   * 用 Node 内置 fetch 直接抓取，自动跟随重定向（含跨域）。
   *
   * 为什么需要：宿主 web 抓取器出于安全考虑拒绝跨域跳转，
   * 例如 https://ncbi.nlm.nih.gov/pmc/... → https://pmc.ncbi.nlm.nih.gov/...；
   * 而本机宿主的 shell 服务没有 `run` 方法，原有 shell/curl 兜底必然抛
   * "shell.run is not a function"。补一条纯 Node 通道作为中间层。
   */
  async function fetchViaNode(url, signal) {
    const res = await fetch(url, {
      redirect: 'follow',
      ...(signal !== undefined ? { signal } : {}),
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    })
    const content = await res.text()
    const type = String(res.headers.get('content-type') || '')
    return {
      url: res.url || url,
      statusCode: res.status,
      truncated: false,
      body: { kind: type.includes('html') ? 'html' : 'text', content }
    }
  }

  return { resolveSessionPolicy, fetchViaShell, fetchViaNode, downloadImages, resolveEscalationPolicy }
}
