/**
 * dsh-scrape-webpage —— 抓取执行层（依赖宿主服务，经 ctx 注入）。
 *
 * 负责：会话沙箱策略解析、页面/图片的 shell/curl 执行、
 * HTTPS TLS 受限时的沙箱审批升级（与 pwsh 工具契约一致）。
 */

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
        const parsed = parseImageOutput(out, binPath)
        if (parsed.statusCode === 200 && parsed.size > 0) {
          const relPath = parsed.filePath.slice(rootLen)
          images.push({ url, filePath: parsed.filePath, relPath, mime: parsed.contentType || '', size: parsed.size })
        } else {
          const errText = String((result && result.stderr && result.stderr.text) || '').trim()
          notes.push('第 ' + (i + 1) + ' 张下载失败（HTTP ' + parsed.statusCode + '）' + (errText ? '：' + errText.slice(0, 120) : '') + ' → ' + url)
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

  return { resolveSessionPolicy, fetchViaShell, downloadImages, resolveEscalationPolicy }
}
