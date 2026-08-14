# dsh-scrape-webpage

网页抓取与分析插件 —— DeepSeek Harness 组合插件(Host-only,零依赖)。

用爬虫读取网站内容并做分析:注册模型工具 `scrape_webpage`,抓取网页正文,提取标题、页面描述、H1–H6 标题结构、链接列表,统计字符数/词数/预计阅读时长与语言倾向,计算高频关键词(中文二元组 + 英文单词,含停用词过滤);可选下载页面内容图片供视觉分析,并提供 `scrape.imageAnalyzer` 扩展服务供识图插件接入。

## ✨ 功能特性

- **网页抓取**:http/https,自动重定向,非 2xx 状态码优雅返回
- **内容提取**:标题、页面描述、正文(截断可调)、H1–H6 标题结构、链接列表(上限 100)
- **自动分析**:字符数、词/字数、标题数、链接数、预计阅读时长、语言倾向(中/英/混合)、高频关键词 Top30
- **图片下载**:提取 `<img src/data-src/srcset>`(相对路径自动归一化,过滤图标/logo 等噪音),下载到会话工作区 `.scrape-images\`,返回本地路径供视觉模型 `read_image` 分析
- **识图插件接口**:发布 `scrape.imageAnalyzer` 服务,识图插件注册分析器后,图片自动交给分析器并把结果附在工具输出中
- **安全模型**:默认沙箱内抓取;HTTPS 沙箱 TLS 受限时按 pwsh 工具的升级契约,显式 `sandbox_permissions` + 审批一次性授权

## 📦 安装

### 安装到本地 profile

1. 把本仓库复制到目标 profile 的 `node_modules` 下:

   ```powershell
   Copy-Item -Recurse <本仓库> "$env:DSH_HOME\profiles\web\node_modules\dsh-scrape-webpage"
   ```

2. 把 `cordis.patch.yml` 中的 insert 行合并进该 profile 的 `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: scrape-webpage
         name: dsh-scrape-webpage
   ```

3. 重启 DSH(Web/TUI),插件随宿主组合加载。


## 🚀 使用

对话中直接说:"帮我抓取 https://example.com 并分析"。工具参数:

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string(必填) | 要抓取的网页地址(http/https) |
| `maxChars` | number | 返回正文最大字符数,默认 30000,范围 1000–100000 |
| `images` | number | 同时下载内容图片数(上限 6,默认 0),图片保存到 `.scrape-images\<时间戳>\`,返回本地路径供 `read_image` 查看 |
| `sandbox_permissions` | string | 仅 `danger-full-access`。HTTPS 沙箱受限报错提示 `escalation available` 后,重试同一次抓取时携带;审批弹窗由用户决定 |
| `justification` | string | 与 `sandbox_permissions` 配套:一句话说明为何需要更宽权限 |

输出:成功 `{ url, statusCode, truncated, title, description, headings, links, text, stats, keywords, images, imageNote, imageAnalysis }`,失败 `{ error, url }`。

## 🖼 图片下载与识图

**方式一:视觉模型直接看图。** 带 `images: N` 抓取后,对返回的 `relPath` 调用 `read_image` 即可。

**方式二:识图插件接入。** 插件发布服务 `scrape.imageAnalyzer`(宿主 realm),识图插件注册分析器:

```js
const registry = ctx.get('scrape.imageAnalyzer')   // 可选服务,注意 undefined 检查
if (registry !== undefined) {
  ctx.effect(() => registry.register({
    id: 'my-vision',
    async analyze(image) {
      // image = { url, filePath, relPath, mime, size }（JSON 安全）
      const text = await yourVisionBackend(image.filePath)
      return { text }            // 返回 null 表示不处理
    },
  }))
}
```

注册后,每次带 `images > 0` 的抓取都会把图片自动交给分析器,结果以
`imageAnalysis: [{ analyzerId, relPath, text }]` 附在工具输出中。

## 🔒 安全模型

- 默认在**沙箱内**(会话策略)执行:http 页面直接可用;https 页面因沙箱 TLS 凭据受限而失败时,结果携带 `escalation available` 提示。
- 模型显式携带 `sandbox_permissions="danger-full-access"` + `justification` 重试时,插件经审批服务询问用户,`allowed-once` 只授权当次调用。
- 仅 http/https 协议;正文/图片下载均有截断上限;超时受控(工具 180s、页面 30s、单图 20s)。

## 🖥 平台要求

- 有 `web` fetch provider 的部署:直接走该 provider。
- 无 fetch provider 的部署(内置回退):经 `shell` 服务调用 `curl.exe`(Windows 10 1803+ 自带;其他平台请确保 PATH 有 curl)。
- 依赖宿主服务:`tools`、`systemPrompt`、`timer`(硬依赖);`web`、`shell`、`sandboxPolicy`、`approval`、`sessions`(可选,缺失时优雅报错)。



## 📄 License

[MIT](LICENSE)
