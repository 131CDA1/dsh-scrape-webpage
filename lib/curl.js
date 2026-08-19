/**
 * dsh-scrape-webpage —— curl 命令构建与结果解析（纯函数，无依赖）。
 *
 * 负责：页面抓取与图片下载的 PowerShell/curl 命令文本构建，
 * 以及 shell 执行结果（stdout 文本）的元数据解析。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

function buildCurlCommand(u) {
  const psUrl = String(u).replace(/'/g, "''")
  return [
    "$ProgressPreference='SilentlyContinue';",
    '& curl.exe -sS -L --max-time 20 --connect-timeout 8',
    "-A '" + UA + "'",
    '-w "`n__DSH_META__:%{http_code}|%{content_type}|%{url_effective}"',
    "'" + psUrl + "'"
  ].join(' ')
}

/**
 * 解析页面抓取的 stdout。返回 { ok: true, url, statusCode, contentType, finalUrl, content }
 * 或 { ok: false, reason: 'no-marker' | 'bad-status' }。
 */
function parseFetchOutput(out, fallbackUrl) {
  const markerIdx = out.lastIndexOf('__DSH_META__:')
  if (markerIdx === -1) return { ok: false, reason: 'no-marker' }
  const metaLine = out.slice(markerIdx + '__DSH_META__:'.length).split('\n')[0]
  const firstBar = metaLine.indexOf('|')
  const codeStr = firstBar >= 0 ? metaLine.slice(0, firstBar) : metaLine
  const rest = firstBar >= 0 ? metaLine.slice(firstBar + 1) : ''
  const secondBar = rest.indexOf('|')
  const contentType = secondBar >= 0 ? rest.slice(0, secondBar) : rest
  const finalUrl = secondBar >= 0 ? rest.slice(secondBar + 1) : ''
  const statusCode = Number(codeStr)
  if (!Number.isFinite(statusCode) || statusCode === 0) return { ok: false, reason: 'bad-status' }
  const content = out.slice(0, markerIdx).replace(/\r?\n$/, '')
  return { ok: true, url: finalUrl || fallbackUrl, statusCode, contentType, finalUrl, content }
}

function buildImageCommand(url, binPath) {
  const psUrl = String(url).replace(/'/g, "''")
  const psPath = String(binPath).replace(/'/g, "''")
  const parts = []
  parts.push("$ProgressPreference='SilentlyContinue';")
  parts.push("$f='" + psPath + "';")
  parts.push('$meta = (& curl.exe -sS -L --max-time 8 --connect-timeout 6')
  parts.push("-A '" + UA + "'")
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

/**
 * 解析单张图片下载的 stdout，返回 { statusCode, contentType, size, filePath }。
 */
function parseImageOutput(out, binPath) {
  const metaM = /META:__DSH_META__:(\d+)\|([^\r\n]*)/.exec(out)
  const sizeM = /SIZE:(-?\d+)/.exec(out)
  const fileM = /FILE:([^\r\n]*)/.exec(out)
  return {
    statusCode: metaM ? Number(metaM[1]) : 0,
    contentType: metaM ? String(metaM[2] || '') : '',
    size: sizeM ? Number(sizeM[1]) : -1,
    filePath: fileM ? String(fileM[1]).trim() : binPath
  }
}

export { buildCurlCommand, parseFetchOutput, buildImageCommand, parseImageOutput }
