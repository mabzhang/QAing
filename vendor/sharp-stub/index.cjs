'use strict'

/** QAing intentionally does not provide image-processing support. */
module.exports = function sharpUnavailable() {
  throw new Error('QAING_IMAGE_PROCESSING_UNAVAILABLE')
}
