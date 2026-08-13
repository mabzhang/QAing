[简体中文](README.md) | [English](README.en.md)

<p align="center">
  <img src="build/brand/ZenX-wordmark-transparent.png" alt="ZenX" width="420">
</p>

# QAing

> **当前状态：0.1.7 开源预览版。** 源代码按 Apache License 2.0 开放。当前没有完成 Developer ID 签名与 Apple 公证的公开安装包；请从源码运行，或自行构建仅供测试的 ad-hoc 包。

QAing 是面向演讲、路演、会议和现场问答的 macOS 项目型实时语音知识助手。它从麦克风或系统音频识别问题，优先使用当前项目中已审核的预设 QA；没有可靠命中时，再从项目资料中检索证据并生成候选答案。

## 核心能力

- **QA 模式**：监听一个音源，增量识别完整问题，检索当前项目资料并生成带来源的候选答案。
- **前置模式**：持续转写演讲或会议，先保存原始文本，再生成 Markdown 结构稿并进入当前项目资料库。
- **会话工作台**：按项目保存问答历史；切换项目时同步切换记录，切回后恢复原项目历史。
- **项目资料库**：只读取当前项目的 `转换资料库`，支持增量检查、确定性转换、关键词检索和本地语义检索。
- **模拟问答助手**：根据当前项目证据生成可审阅的模拟问答草稿，人工批准后才可进入预设 QA 快速直答路径。

## 系统与网络要求

- macOS 14 或更高版本
- Apple Silicon（M 系列，arm64）
- 麦克风或“屏幕与系统音频录制”权限；一个会话只能使用一个音源
- DeepSeek API：文档约束回答与模拟问答生成
- 豆包 SeedASR：云端语音识别
- 首次启动且本地没有缓存时，可能需要下载较大的固定版本 BGE 语义模型

QAing 不是完全离线产品，也不支持 Windows、Intel Mac 或 macOS 13 及以下版本。

## 安装与公开二进制状态

当前暂不提供公开 DMG/ZIP。仓库中的历史 0.1.7 安装包继续保留为不可见的 Draft Release，尚未作为开源二进制发行。原因是它采用 ad-hoc 签名、未完成 Apple 公证，而且随包第三方组件的许可证、可替换/重链接和对应源码说明仍需补齐。

请按“从源码运行”章节启动项目，或使用 `npm run package:dir` / `npm run package:internal` 自行构建测试包。ad-hoc 包首次打开可使用“Control/右键 → 打开”，或在“系统设置 → 隐私与安全性”中使用 macOS 提供的“仍要打开”；不要关闭 Gatekeeper。此类构建升级后可能被 macOS 视为新的代码身份，并再次要求授权。

## 五分钟上手

1. 在“设置”中配置 DeepSeek 与豆包 SeedASR 凭据。
2. 选择一个项目文件夹，并让 QAing 创建固定目录。
3. 把普通资料放进 `原始资料/`，把已审核问答放进 `预设QA/`。
4. 在“项目同步中心”选择同步方式并检查更新。
5. 选择“系统音频”或“麦克风”，开始 QA 或前置会话。

## 项目目录

```text
项目文件夹/
├── 原始资料/          # 普通资料输入，可继续按品牌、产品等方式嵌套
├── 预设QA/            # 已审核、允许快速直答的高信任问答输入
├── 转换资料库/
│   ├── 资料/          # QAing 生成或人工放入并通过校验的 Markdown
│   └── 预设QA/        # 通过严格 QA 格式校验的 Markdown
└── .qaing/
    └── project.json   # 项目标识，不包含资料正文或密钥
```

`转换资料库/` 永远不会被当作原始输入再次转换，避免递归摄入。应用检索只使用当前项目中已验证、已提交的转换资料。

## 支持的文件类型

| 资料类型 | 0.1.7 行为 |
| --- | --- |
| TXT、Markdown、JSON、CSV、TSV | 可在应用内做本地确定性转换；预设 QA 不接受 TXT |
| `转换资料库/` 中的手动 Markdown | 通过安全与格式校验后可使用；预设 QA 仍须符合严格问答格式 |
| PDF、DOCX、PPTX、XLSX、RTF、HTML | 可以识别，但当前需要在外部转换为 Markdown 后再导入 |
| 图片、扫描 PDF、音视频 | 当前不提供 OCR、视觉理解或资料型 ASR 转换 |
| 压缩包、数据库、可执行文件、符号链接与特殊文件 | 阻断，不读取或索引 |

“识别到文件”不等于“能够理解任意文件”。项目同步中心会明确显示等待外部转换、格式不支持、冲突或失败状态，不会静默忽略。

## 回答流程

1. 识别到具有完整含义且稳定的问题后开始处理，不依赖固定的 15 秒或 30 秒节点。
2. 优先检查当前项目的已审核预设 QA；可靠精确或严格近义命中时直接返回，不调用 DeepSeek。
3. 未命中时检索当前项目资料；语义模型不可用时明确降级为关键词检索。
4. DeepSeek 只接收问题与命中的必要证据片段，用于生成候选答案。
5. 用户结束当前问题后，才锁定最终答案。

## 会话工作台

- 会话与轮次按项目隔离并持久化。
- 切换项目时工作台内容随之变化；切回项目会加载它之前的问答记录。
- 支持删除单轮、清空当前项目，以及导出当前项目的 Markdown。
- 同一问题发生实质变化并得到新的完整答案时保留新版本；礼貌词、标点等同义变化不会重复生成。
- 旧候选答案不会进入后续上下文，也不会覆盖当前答案。

## 模拟问答助手

- 开始前收集被提问对象、提问者身份、关注主题、沟通场景、回答风格与禁答主题。
- 默认目标为 **30 条**；50 条不是上限。超过 40 条时，必须确认制作耗时和资料稀释两项风险。
- 目标数量不是交付保证。证据不足时，输出可证实的问答，并把剩余部分列为“资料缺口”，不会为了凑数编造答案。
- 每条可靠草稿至少绑定一份当前项目证据；无效引用、禁答内容、重复问题或证据不足会转为缺口。
- 草稿不参与实时检索。只有人工逐条批准并通过冲突检查后，才写入 `转换资料库/预设QA`。
- 应用不会执行本机任意 Skill、脚本、MCP、浏览器操作，也不会读取 Codex 登录态。

## 数据、隐私与云端边界

| 数据 | 去向 | 用途 |
| --- | --- | --- |
| PCM 音频 | 豆包 SeedASR | 云端语音识别；QAing 不将原始音频长期落盘 |
| 问题与命中的资料片段 | DeepSeek | 生成资料约束的候选答案 |
| 前置模式完整转写正文 | DeepSeek | 生成结构化 Markdown；使用前应取得录音与转写授权 |
| 模拟问答 Brief 与证据片段 | DeepSeek | 生成可审阅问答草稿 |
| 项目文件、转换 Markdown、SQLite 与索引 | 本机 | 项目资料库、会话与恢复 |
| API 凭据 | macOS 安全存储保护的本地密文 | 运行时调用对应供应商 API |
| BGE 模型 | 本地缓存 | 本地语义检索 |

- 日志默认不记录转写正文、资料正文、答案正文或凭据。
- Renderer 启用 sandbox 与 context isolation，只能调用白名单 IPC。
- 不要向仓库提交真实 API Key；若怀疑凭据泄露，应立即在供应商平台轮换。
- 使用者应自行确认已取得录音、转写和云端处理授权，并核对 DeepSeek 与豆包的最新数据留存政策。

## 已知限制

- 当前不承诺在屏幕共享中隐藏窗口，只提供置顶、紧凑窗口和快捷隐藏。
- 麦克风和系统音频不能在同一会话中同时捕获。
- 当前没有自动更新、账号登录、团队协作、云同步或多设备同步。
- PDF/Office/OCR/图片与资料型音视频的自动转换尚未内置。
- 当前没有完成 Developer ID 签名和 Apple 公证的公开安装包。

## 从源码运行

需要 Node.js 24+、Swift 6 与 Apple Command Line Tools：

```bash
npm ci
npm run dev
```

DeepSeek 与豆包 SeedASR 凭据只能在应用设置中填写；应用不会从 `.env` 读取真实密钥。

## 测试与打包

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run package:dir
npm run smoke:package
```

真实本地模型测试需要显式启用，并使用已准备好的固定模型缓存：

```bash
QAING_BGE_CACHE_DIR="$HOME/Library/Application Support/qaing/models" npm run test:model:real
```

- `npm run package:dir`：生成本机开发用 `.app`。
- `npm run package:internal`：生成 ad-hoc 内部 DMG/ZIP。
- `npm run package`：正式发布门禁；缺少 Developer ID 或公证配置时会失败。

## 文档

- [QAing 落地版 PRD](docs/PRD-QAing-落地版.md)
- [项目资料库概念版 PRD](docs/PRD-QAing-项目资料库-概念版.md)
- [项目资料库落地版 PRD](docs/PRD-QAing-项目资料库-落地版.md)

## 定制需求

有定制需求请联系我。请使用微信扫描下方二维码添加好友。

<p align="center">
  <img src="docs/assets/contact-wechat-mab.png" alt="Mab 的微信联系二维码；有定制需求请联系我" width="360">
</p>

## 开源许可

源代码与文档采用 [Apache License 2.0](LICENSE)。QAing/ZenX 名称、Logo、应用图标、安装视觉和联系二维码不包含在品牌使用授权中，详见 [TRADEMARKS.md](TRADEMARKS.md)。第三方组件继续遵循各自许可证，参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。参与开发请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
