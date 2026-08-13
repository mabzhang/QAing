# Runtime model provenance

QAing does not bundle the semantic model in the application or installer.
When semantic retrieval is enabled and the cache is empty, the application
downloads this pinned artifact at runtime:

- model repository: `Xenova/bge-large-zh-v1.5`
- revision: `a48549b3259a6165364f226599cd91f39923d5d5`
- q4 ONNX SHA-256: `470b1a4f914b2f40c72b7a495240a75fc8858f52f7b6ed8fb13185e571f98f71`
- base model identified by the conversion: `BAAI/bge-large-zh-v1.5`

The base model card declares MIT. The pinned converted repository currently
does not publish an independent LICENSE file or license metadata, so QAing
records that as a provenance gap rather than asserting a separate license for
the converted artifact. Users should review the upstream model terms before
allowing the runtime download.
