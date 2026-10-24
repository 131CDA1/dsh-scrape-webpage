/**
 * 图片下载自测（不依赖宿主服务，直接调 fetch.js 的 downloadImages）。
 *
 * 校验点：
 *  1. shell 服务缺失（本机宿主真实情况）时仍能下载成功；
 *  2. 按 content-type 落成正确扩展名；
 *  3. 非图片响应判失败而不是写成坏文件。
 *
 * 用法：node test/download-images.selftest.mjs [输出目录]
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFetchLayer } from '../lib/fetch.js'

const PNG = 'https://www.python.org/static/img/python-logo.png'
const ICO = 'https://www.deepseek.com/favicon.ico'
const NOT_IMAGE = 'https://www.python.org/'

const MAGIC = new Set(['89504e47', '00000100', 'ffd8ffe0', '52494646'])

function magicOf(buf) {
  return buf.subarray(0, 4).toString('hex')
}

const root = process.argv[2] || await mkdtemp(join(tmpdir(), 'scrape-img-'))
const dir = join(root, '.scrape-images', 'selftest-' + Date.now())
const layer = createFetchLayer({ get: () => undefined })

let failed = 0
function check(label, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' — ' + detail : ''))
  if (!ok) failed++
}

// 1 + 2：正常图片，shell 传 undefined
const got = await layer.downloadImages(undefined, [PNG, ICO], dir, root, undefined, undefined)
check('下载数量 = 2', got.images.length === 2, '实际 ' + got.images.length + '，note=' + (got.note || '(none)'))
for (const img of got.images) {
  const buf = await readFile(img.filePath)
  const ext = img.filePath.split('.').pop()
  check('扩展名与 content-type 一致 ' + ext, img.filePath.endsWith('.' + { 'image/png': 'png', 'image/vnd.microsoft.icon': 'ico' }[img.mime] || 'x'), img.mime)
  check('文件非空且魔数可识别', MAGIC.has(magicOf(buf)), magicOf(buf) + ' ' + buf.length + 'B')
  check('size 字段与实际一致', img.size === (await stat(img.filePath)).size, img.size + ' vs ' + (await stat(img.filePath)).size)
}

// 3：非图片响应
const bad = await layer.downloadImages(undefined, [NOT_IMAGE], join(dir, 'bad'), root, undefined, undefined)
check('非图片响应被判失败', bad.images.length === 0 && /下载失败|不是图片/.test(bad.note), bad.note)

await rm(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
