/**
 * QAing uses Transformers.js only for text embeddings. Image processing is
 * intentionally unsupported, so no libvips binary is distributed.
 */
export default function sharpUnavailable() {
  throw new Error('QAING_IMAGE_PROCESSING_UNAVAILABLE')
}
