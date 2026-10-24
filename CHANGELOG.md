# Changelog

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复

- 图片下载在宿主 shell 服务没有 `run` 方法时必然失败(`shell.run is not a function`)。
  `downloadImages()` 改用 `node:fs/promises` 建目录,并新增 Node 直连下载主路径
  (`downloadImageViaNode()`),仅在 `shell.run` 确实存在时才回退 curl;按
  content-type 决定扩展名,限制 12 MB / 15 s,拒绝非 `image/*` 响应
- `extractImages()` 只要 URL 含逗号就按逗号切,会把
  `?x-bce-process=image/format,f_auto` 截成 `...=image/format` 导致图床返回 400。
  改为 `src`/`data-src` 原样保留、仅 `srcset` 按候选拆分,属性名加边界前缀避免
  `src` 误匹配 `data-src`,并对属性值做 HTML 实体解码
- 图片下载遇到 4xx 且 URL 带查询串时,去掉 query 再重试一次(部分对象存储对残缺
  缩略图参数返回 400,原图可访问)
- 三条抓取通道全部失败时不再把底层 `shell.run is not a function` 直接抛给调用方,
  改为说明站点不可达/被拒绝及可用替代工具

## [1.0.0] - 2026-08-14

### 新增

- 模型工具 `scrape_webpage`:网页抓取 + 标题/描述/正文/标题结构/链接提取
- 统计与关键词分析:字符数、词/字数、预计阅读时长、语言倾向、高频关键词(中文二元组 + 英文单词)
- 内容图片下载(images 参数,上限 6 张,过滤图标/logo 等噪音),保存到会话工作区并返回本地路径
- `scrape.imageAnalyzer` 扩展服务:识图插件注册分析器后,图片自动分析并附结果
- 抓取链路:优先 web fetch provider,回退 shell/curl.exe;沙箱内默认执行
- 沙箱审批升级:HTTPS TLS 受限时按 pwsh 工具契约,`sandbox_permissions="danger-full-access"` + justification 一次性授权
- 发行版基础设施:`release/` 预构建附件 + `.github/workflows/release.yml` 打 tag 自动发版
- bundle 打包:package.json 声明 `dsh.bundle.patch`(cordis.patch.yml),支持 `dsh plugin --profile <name> add` 一键安装并自动注册组合层
- 模块化:lib 按职责拆分为 html/analyze/curl/fetch/index(纯函数层 ← 服务层 ← 组合层,低耦合,零依赖不变)
