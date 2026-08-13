# Contributing to QAing

Thank you for helping improve QAing. The project currently targets macOS 14 or later on Apple Silicon only.

## Before opening a change

- Use an issue to describe substantial feature work or behavior changes before implementation.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md); never put credentials, transcripts, document bodies, or private project data in an issue or pull request.
- Keep changes focused and include tests for behavior changes.

## Local checks

Install Node.js 24+, Swift 6, and Apple Command Line Tools, then run:

```bash
npm ci
npm run check
```

Tests must not call real cloud services or use user credentials. Network code must support cancellation, timeout, and bounded retries or explicitly classify an error as non-retryable.

## Pull requests

- Explain what changed, why it changed, and how it was verified.
- Do not weaken or remove tests to make a check pass.
- Preserve Renderer sandboxing, context isolation, allowlisted IPC, and project/session/revision fences.
- Do not commit build outputs, local databases, logs, model caches, API keys, or files from ignored private directories.

By submitting a contribution, you agree that it may be distributed under the repository's [Apache License 2.0](LICENSE).

## Branding

The source license does not grant rights to reuse QAing or ZenX branding as the identity of a redistributed fork. See [TRADEMARKS.md](TRADEMARKS.md).
