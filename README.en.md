[简体中文](README.md) | [English](README.en.md)

<p align="center">
  <img src="build/brand/ZenX-wordmark-transparent.png" alt="ZenX" width="420">
</p>

# QAing

> **Status: 0.1.7 internal preview.** This repository is private. The current binary is ad-hoc signed and has not been notarized by Apple. It is not a public distribution build.

QAing is a project-scoped real-time voice knowledge assistant for presentations, pitches, meetings, and live Q&A on macOS. It transcribes microphone or system audio, checks reviewed preset Q&A in the active project first, and otherwise retrieves project evidence before generating a candidate answer.

## Key features

- **QA Mode**: listens to one audio source, detects complete questions incrementally, retrieves active-project evidence, and produces sourced candidate answers.
- **Preparation Mode**: continuously transcribes a presentation or meeting, stores the raw transcript first, then creates a structured Markdown document for the active project.
- **Conversation Workbench**: persists Q&A history per project and restores the corresponding records when you switch back.
- **Project Library**: reads only the active project's `转换资料库`, with incremental checks, deterministic conversion, keyword retrieval, and local semantic retrieval.
- **Simulated Q&A Assistant**: creates evidence-bound draft Q&A for review. A draft can enter the preset-QA direct-answer path only after explicit human approval.

## System and network requirements

- macOS 14 or later
- Apple Silicon (M-series, arm64)
- Microphone or Screen & System Audio Recording permission; one active source per session
- DeepSeek API for evidence-grounded answers and simulated Q&A generation
- Doubao SeedASR for cloud speech recognition
- A large, pinned BGE semantic model may be downloaded on first launch when no local cache exists

QAing is not fully offline. Windows, Intel Macs, and macOS 13 or earlier are not supported.

## Installing v0.1.7

1. Download the DMG from the private [v0.1.7 Release](https://github.com/mabzhang/QAing/releases/tag/v0.1.7). The ZIP is a fallback package.
2. Open the DMG and drag `QAing` to `Applications`.
3. Launch QAing from the Applications folder.
4. This internal build is not notarized. On first launch, use Control/right-click → Open, or use the macOS-provided Open Anyway action under System Settings → Privacy & Security. Do not disable Gatekeeper.
5. Request microphone and system-audio permissions separately in QAing. A full app restart may be required after changing permissions.

Because the build is ad-hoc signed, an upgrade may appear to macOS as a new code identity and request permissions again. Stable Developer ID Application signing and Apple notarization are still required before public distribution.

## Quick start

1. Add DeepSeek and Doubao SeedASR credentials in Settings.
2. Select a project folder and let QAing create its fixed directory layout.
3. Put ordinary source material in `原始资料/`, and reviewed direct-answer Q&A in `预设QA/`.
4. Choose a synchronization policy and check for updates in Project Sync Center.
5. Select System Audio or Microphone, then start a QA or Preparation session.

## Project directory layout

```text
Project folder/
├── 原始资料/          # Ordinary source material; may contain nested brand/product folders
├── 预设QA/            # Reviewed, high-trust direct-answer Q&A input
├── 转换资料库/
│   ├── 资料/          # Generated or manually supplied Markdown that passed validation
│   └── 预设QA/        # Markdown that passed the strict Q&A schema
└── .qaing/
    └── project.json   # Project identity only; no document body or credentials
```

`转换资料库/` is never scanned as raw input, preventing recursive ingestion. Retrieval uses only validated and committed converted content from the active project.

## Supported file types

| Input | Behavior in 0.1.7 |
| --- | --- |
| TXT, Markdown, JSON, CSV, TSV | Deterministic local conversion; TXT is not accepted as preset Q&A |
| Manual Markdown in `转换资料库/` | Usable after security and schema validation; preset Q&A still requires the strict Q&A format |
| PDF, DOCX, PPTX, XLSX, RTF, HTML | Detected, but currently requires external conversion to Markdown |
| Images, scanned PDFs, audio, video | No built-in OCR, visual understanding, or library-oriented ASR conversion |
| Archives, databases, executables, symlinks, special files | Blocked and never read or indexed |

“Detected” does not mean that QAing can understand every file. Project Sync Center reports external-conversion requirements, unsupported formats, conflicts, and failures rather than silently ignoring them.

## Answer retrieval flow

1. Processing begins when a question has complete meaning and becomes stable; QAing does not wait for fixed 15- or 30-second checkpoints.
2. Reviewed preset Q&A in the active project is checked first. A reliable exact or strict near match returns the reviewed answer without calling DeepSeek.
3. Otherwise, QAing retrieves active-project documents. If the semantic model is unavailable, the app explicitly falls back to keyword retrieval.
4. DeepSeek receives only the question and the necessary retrieved evidence snippets to produce a candidate answer.
5. The final answer is locked only when the user ends the current question.

## Conversation Workbench

- Sessions and rounds are persisted and isolated by project.
- Switching projects immediately changes the workbench; switching back restores that project's previous records.
- You can delete one round, clear the active project's history, or export that project to Markdown.
- A materially changed question with a new complete answer creates another version. Politeness, punctuation, and equivalent wording do not create duplicates.
- Old candidates never enter later conversation context and cannot overwrite the current answer.

## Simulated Q&A Assistant

- The intake asks for the interviewee, audience, focus topics, scenario, answer style, and excluded topics.
- The default target is **30 items**; 50 is not a maximum. Requests above 40 require explicit acknowledgement of longer production time and evidence dilution risk.
- A target is not a delivery guarantee. When evidence is insufficient, QAing returns the reliable items it can support and records the remainder as evidence gaps instead of fabricating answers.
- Every reliable draft must cite active-project evidence. Invalid citations, excluded content, duplicates, or insufficient support become gaps.
- Drafts never participate in live retrieval. Only items individually approved by a human and passed through conflict validation are written to `转换资料库/预设QA`.
- QAing does not execute arbitrary local Skills, scripts, MCP tools, browser actions, or a Codex login session.

## Data, privacy, and cloud processing

| Data | Destination | Purpose |
| --- | --- | --- |
| PCM audio | Doubao SeedASR | Cloud speech recognition; raw audio is not stored long-term by QAing |
| Question and retrieved evidence snippets | DeepSeek | Evidence-grounded candidate answer generation |
| Simulation brief and evidence snippets | DeepSeek | Reviewable simulated Q&A drafts |
| Project files, converted Markdown, SQLite, indexes | Local device | Project library, sessions, and recovery |
| API credentials | Locally encrypted data protected by macOS secure storage | Runtime access to the configured providers |
| BGE model | Local cache | Local semantic retrieval |

- Logs do not contain transcript bodies, document bodies, answer bodies, or credentials by default.
- The Renderer runs with sandboxing and context isolation and can access only allowlisted IPC methods.
- Never commit real API keys. Rotate a credential immediately if exposure is suspected.

## Known limitations

- QAing does not promise invisibility during screen sharing. It provides always-on-top, compact-window, and quick-hide controls only.
- Microphone and system audio cannot be captured simultaneously in one session.
- There is no automatic update, account login, team collaboration, cloud sync, or multi-device sync.
- Built-in automatic conversion for PDF/Office/OCR/images and library-oriented media is not available yet.
- v0.1.7 is an ad-hoc internal build and has not completed Developer ID signing or Apple notarization.

## Development setup

Node.js 24+, Swift 6, and Apple Command Line Tools are required:

```bash
npm ci
npm run dev
```

DeepSeek and Doubao SeedASR credentials must be entered in the app. QAing does not read real secrets from `.env`.

## Testing and packaging

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run package:dir
npm run smoke:package
```

The real local-model test is opt-in and requires a prepared, pinned model cache:

```bash
QAING_BGE_CACHE_DIR="$HOME/Library/Application Support/qaing/models" npm run test:model:real
```

- `npm run package:dir` builds a local development `.app`.
- `npm run package:internal` builds ad-hoc internal DMG/ZIP packages.
- `npm run package` is the production release gate and fails when Developer ID or notarization configuration is missing.

## Documentation

- [QAing Implementation PRD (Chinese)](docs/PRD-QAing-落地版.md)
- [Project Library Concept PRD (Chinese)](docs/PRD-QAing-项目资料库-概念版.md)
- [Project Library Implementation PRD (Chinese)](docs/PRD-QAing-项目资料库-落地版.md)

## License status

This is currently a private internal repository with no open-source license grant. Repository access does not grant redistribution, brand, or trademark rights. Before any future public release, the code license, third-party licenses, and ZenX/QAing brand-asset boundaries must be reviewed explicitly.
