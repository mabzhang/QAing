# Third-party notices

QAing depends on third-party open-source packages. Their copyrights and
licenses remain with their respective authors.

- The exact JavaScript dependency graph is pinned in `package-lock.json`.
- Direct runtime dependencies and their declared licenses include:
  `@huggingface/transformers` (Apache-2.0), `better-sqlite3` (MIT),
  `lucide-react` (ISC), `react` / `react-dom` (MIT), `ws` (MIT), and `zod`
  (MIT).
- QAing's public macOS preview uses a local text-only `sharp` compatibility
  package. Real `sharp`/libvips packages may be present in the development
  dependency tree for brand-asset generation and optional Transformer image
  features, but they are explicitly excluded from the public application
  bundle. Image understanding is not a supported application feature.
- The local semantic runtime bundles ONNX Runtime. Public preview packages
  include its license, third-party notices, privacy statement, and a generated
  production dependency inventory under `Contents/Resources/licenses/`.
- Electron 43.4.0 includes FFmpeg under LGPL-2.1-or-later as the dynamically
  linked library at `Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib`.
  The complete FFmpeg notice and LGPL text are in
  `Electron-LICENSES.chromium.html`. A compatible replacement can be installed
  in a modified source build and the application re-signed for macOS. Electron's
  corresponding Chromium FFmpeg source is identified by commit
  `ad41607c61898cf7150e0fb20fe4bbabd44922a3`:
  https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/ad41607c61898cf7150e0fb20fe4bbabd44922a3

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

The historical 0.1.7 internal binary remains an unpublished Draft Release.
Beginning with 0.1.8 preview packages, the applicable project, Electron,
Chromium, ONNX Runtime, and direct runtime dependency materials are shipped in
the application bundle. The preview package is ad-hoc signed and not notarized;
that distribution status is independent of its open-source license.

Relevant upstream sources include:

- https://github.com/huggingface/transformers.js
- https://github.com/microsoft/onnxruntime

This file is an attribution aid and does not replace the license terms shipped
by each dependency.
