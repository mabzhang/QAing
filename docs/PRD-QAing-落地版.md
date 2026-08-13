# QAing 需求文档（落地版）

> 版本：v0.1 ｜ 日期：2026-08-12 ｜ 状态：工程范围已冻结

> D12“按项目同步与转换资料库”增量需求已单独冻结于 `docs/PRD-QAing-项目资料库-落地版.md`；本文件继续描述实时问答、音频与检索主链。

> D16 增量：项目同步中心采用“状态优先 + 渐进展开”；新增证据驱动、人工审批后才可发布的模拟问答助手。默认目标 30 条，50 条不是上限；超过 40 条必须确认耗时和资料稀释风险，证据不足时输出资料缺口而非凑数。

## 一、产品与范围

QAing 是面向演讲、路演和问答现场的双模式桌面助手。它直接采集麦克风或系统音频，经云端流式 ASR 转写，并用本地双层资料库检索结果约束 DeepSeek V4 Flash 生成答案。

本期 P0：

1. macOS 14+、Apple Silicon（arm64）内建麦克风和系统音频捕获，不依赖虚拟声卡；每会话单活动音源。
2. 前置模式：明确开始/结束边界，原始转写先持久化，结构化 Markdown 后幂等入库。
3. QA 模式：语义完整后尽快产生候选、同轮多完整版本留存、提问结束锁题、回答结束提交、最近五轮上下文。
4. 预设 QA 优先瀑布检索：可靠命中直接采用已审核答案；否则再检索原始资料生成。无可靠证据时拒绝编造并展示来源。
5. 可取消、latest-wins 的流式调用；网络、权限、设备与供应商异常可见且可恢复。

本期明确不做：Windows、Intel Mac、账号/团队协作、原始音频长期保存、双音源同时转写、屏幕共享隐身保证、远程 Qdrant、多设备同步、自动回答播报。

## 二、状态机与交互

QA 状态：`idle → listening → finalizing → answer_locked → committing → listening`。`finalizing` 起暂停接收题目文本；所有异步结果携带 `sessionId/revision/generationId`，旧结果不得写入新状态。候选与最终答案都先在 Controller 私有缓冲区完整生成，再一次性发布；新候选生成时保留上一份稳定候选，禁止逐 token 改写可见答案。

锁题边界在音频停止且 ASR 最终包接收完成后建立，并冻结规范化问题文本与 revision。最终答案失败时，只允许完全匹配冻结 revision 和规范化问题的完整候选作为“候选降级答案”；旧 revision 候选不得写入答案或历史。没有精确候选时保留锁定问题，操作名称为“重新生成确定答案”或“跳过本问”，禁止笼统的“重试本轮”。

上一轮只有在用户点击“回答结束”且保存成功后才进入最近五轮；锁题、生成或失败不会清除已提交历史。“最近上下文”必须可打开查看完整问题/答案/来源数并复制。答案与多轮历史统一放在右侧会话工作台，宽屏支持有边界的水平拖拽和键盘调整，窄屏自动转为抽屉。

前置状态：`idle → recording → structuring → indexing → complete`。结构化或索引失败必须保留原始转写并允许重试；内容哈希保证不重复入库。

核心控件：模式开关、音源选择、开始监听、结束记录并入库、提问结束、回答结束。活跃会话中禁止静默切模式或切音源。

### QA 语义检查点与会话工作台

- 不采用固定 15/30 秒里程碑。每次 ASR revision 先做本地完整性判断；final 可立即评估，普通 partial 连续约 450ms 未变化后评估。短问题槽可快速触发，明显悬置连接词、自我修正尾巴和填充内容不得提前回答。
- 每轮只有一个生成任务运行，期间只保留最新待评估 revision；启动间隔至少 2 秒。完整旧版本允许结束并保存到所属轮次，但只有仍与 live revision/identity 一致的结果才能更新当前候选。
- 关键年份、数字、否定、指标、主体或问槽变化属于实质变化；只增加礼貌词、语气词、标点或等义重复不发起新答案。
- 检索严格按瀑布执行：规范化 exact 预设 QA → 高门槛且关键项兼容的 strict-near 预设 QA → 原始资料 FTS+dense/RRF → DeepSeek 引用核验。QA direct 路径不得获取 DeepSeek Key、检索文档或发云生成请求；未过可靠门的 QA 不得混入文档 prompt。
- 仅完整且校验通过的答案写入 `qa_answer_versions`；partial token、取消、超时、拒答和失败均不写答案版本。提问结束后 final 只可复用同 round、同 revision、同规范化问题的完整候选。
- 右侧工作台独立分页读取，不进入高频 `PublicSnapshot`。默认宽 420px、范围 360–620px，主区至少保留 400px；窄于 1120px 时使用抽屉。轮次内按版本展示问题快照、完整答案、路径、来源和相对生成时刻；历史版本永不写入最近上下文。

## 三、异常与文案

| 异常 | 产品行为 |
|---|---|
| 麦克风/系统音频权限拒绝 | 指明缺失权限及系统设置入口，不启动空会话 |
| 权限状态未知或修改后待重启 | 不启动 ASR/helper，明确提示完全退出并重新打开后重检 |
| 音轨存在但持续无能量 | 10 秒内提示“未检测到声音”，允许重选音源 |
| ASR 断开 | 有界重连，保留已确认转写；失败后显示“转写已暂停” |
| LLM 超时/限流 | 候选可丢弃；最终回答保留问题和证据并允许手动重试 |
| 无资料命中 | “资料库暂无可靠答案”，禁止自由生成事实 |
| Embedding 不可用 | 明示“关键词检索降级”，不得显示语义检索 |
| 结构化/索引失败 | 原始转写保持可恢复，任务进入 failed/pending 重试队列 |

## 四、架构与数据

- Electron + React + TypeScript；renderer sandbox、context isolation、严格白名单 IPC。
- 独立 arm64 Swift helper 使用 ScreenCaptureKit 捕获系统音频、AVAudioEngine/CoreAudio 捕获麦克风；统一输出 16kHz 单声道 PCM16、200ms 二进制包。主进程负责进程监督、心跳、权限/静音诊断和崩溃恢复。
- 豆包 SeedASR `bigmodel_async`；DeepSeek 模型固定 `deepseek-v4-flash`、`thinking.disabled`、SSE streaming。
- SQLite 单文件作为事实源、事务和 FTS5；`EmbeddingProvider` 与 `VectorIndex` 可替换。生产语义链固定真实 `bge-large-zh-v1.5`（1024 维、最多 512 tokens）并在 ≤20,000 chunks 时做内存精确 cosine；精确 QA、FTS5 与向量召回用排名融合而非直接混合原始分数。无真实模型时只允许明示关键词降级。
- 默认不保存原始音频；日志不保存文本正文和凭据。
- 权限申请只能由用户在向导中逐项触发；捕获启动只做无副作用的权限状态门禁，未确认 `granted` 时云 ASR 与原生 helper 调用均为零。正式跨版本分发必须使用稳定 Developer ID Application 身份并完成 Apple 公证；ad-hoc 包不承诺复用旧 TCC 授权。

核心实体：`documents`、`chunks`、`preset_qa`、`sessions`、`qa_rounds`、`qa_answer_versions`、`turns`、`index_jobs`、`settings`。文档/QA 使用内容哈希幂等；删除文档级联删除派生块和向量。`qa_rounds + qa_answer_versions` 是多轮、多完整版本的本地事实源；最终选中版本与 `turn` 在同一 SQLite immediate transaction 中提交。升级前 turn 明确标为 `legacy_committed/legacy_unknown`，不得伪装成新版已核验 final。

## 五、性能与验收契约

- ASR partial 到 UI：参考网络 warmed p95 ≤ 800ms。
- 稳定问题文本到候选首 token：warmed p95 ≤ 1.5s。
- 点击“提问结束”到最终答案首 token：warmed p95 ≤ 1.0s；250 字以内完整答案 p95 ≤ 5s。
- UI 输入响应 p95 ≤ 100ms；30 分钟连续监听零崩溃、零错轮、零旧答案覆盖。
- 任何云服务 SLA 均按分段指标记录，不把完整 200–500 token 生成虚称为 1 秒。

交付禁止：不得用 mock/hardcode 冒充真实链路；不得用测试向量冒充生产语义检索；不得删除或弱化测试；不得把明文凭据打包；不得以 UI 骨架宣称完成。

交付前必须完成两轮独立代码级审查与两轮不同层级测试。macOS Apple Silicon 音频必须以打包产物真机验收；未完成签名或公证时必须明确标注，不能宣称生产发布就绪。
