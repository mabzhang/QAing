# Third-party notices

QAing depends on third-party open-source packages. Their copyrights and
licenses remain with their respective authors.

- The exact JavaScript dependency graph is pinned in `package-lock.json`.
- Direct runtime dependencies and their declared licenses include:
  `@huggingface/transformers` (Apache-2.0), `better-sqlite3` (MIT),
  `lucide-react` (ISC), `react` / `react-dom` (MIT), `ws` (MIT), and `zod`
  (MIT).
- The local semantic runtime pulls platform-specific optional packages. Binary
  distributions may contain dynamically linked libvips components distributed
  under LGPL-3.0-or-later, plus libraries under other compatible licenses.

The source repository does not vendor `node_modules`. Run `npm ci` to resolve
the pinned dependency graph and inspect each installed package's license files.

## Runtime-downloaded model

QAing downloads a checksum-pinned conversion of
`Xenova/bge-large-zh-v1.5` at runtime; the model is not committed to this
repository or bundled in the Draft Release. The conversion identifies
`BAAI/bge-large-zh-v1.5` as its base model, whose model card declares the MIT
license. The pinned conversion revision does not currently publish a separate
license file or license metadata, so this is recorded as a provenance gap that
must be resolved before a production binary distribution.

## Binary distribution status

The historical 0.1.7 internal binary is intentionally kept as an unpublished
Draft Release. It is not a public download because its bundled third-party
license materials and relinking/source instructions have not yet been completed.
Future public binaries must ship the applicable license texts, notices, and
corresponding-source or relinking information required by their bundled
components.

Relevant upstream sources include:

- https://github.com/huggingface/transformers.js
- https://github.com/lovell/sharp
- https://github.com/lovell/sharp-libvips/tree/v1.3.2
- https://github.com/libvips/libvips
- https://github.com/microsoft/onnxruntime

This file is an attribution aid and does not replace the license terms shipped
by each dependency.
