# QAing 开发约定

## 产品边界

- 桌面端采用 Electron + React + TypeScript，音频使用独立 Swift 原生 helper。
- 仅支持 macOS 14+、Apple Silicon（arm64）；不开发或宣称支持 Windows/Intel Mac。
- 应用内建麦克风和系统音频两种捕获能力，但一个会话只允许一个活动音源。
- MVP 不承诺屏幕共享隐身；仅提供置顶、紧凑窗口和快捷隐藏。
- 生产环境没有真实 EmbeddingProvider 时必须标为“关键词检索降级”，禁止用伪向量冒充语义检索。

## 安全硬约束

- 不得从 `需求/` 复制、读取或使用任何明文凭据。
- API Key 不得出现在源码、测试、快照、日志、Git 或安装包内。
- Renderer 禁止 Node 集成，只能通过 preload 暴露的白名单 IPC。
- 日志不得记录转写正文、资料正文、答案正文或密钥。

## 并行开发边界

- `src/core/**`、根配置、公共类型和最终整合由主 Agent 维护。
- 音频/ASR Agent 仅修改 `native/audio-helper/**`、`src/main/audio/**`、`src/main/asr/**`、`src/renderer/audio/**` 及对应测试。
- 数据/RAG Agent 仅修改 `src/main/data/**`、`src/main/rag/**` 及对应测试。
- UI Agent 仅修改 `src/renderer/ui/**`、`src/renderer/App.*` 及 UI 测试。
- 未经主 Agent 协调，不要修改其他 Agent 的文件。

## 质量门禁

- 所有网络操作必须支持取消、超时、有界重试或明确不可重试分类。
- 所有异步 UI 更新必须带 session/revision/generation 标识并拒绝旧结果。
- 测试不允许访问真实云服务或使用用户凭据。
- 不删除、跳过或弱化测试来获得通过结果。
