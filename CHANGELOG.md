# Changelog

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
