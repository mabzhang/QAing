import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { signAsync } = require('@electron/osx-sign')
const HELPER_IDENTIFIER = 'com.qaing.desktop.audio-helper'
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helperEntitlements = join(projectRoot, 'build', 'entitlements.audio-helper.plist')

/**
 * Electron-builder custom Developer ID signer. Its generated per-file options
 * already contain the selected identity, timestamp, Hardened Runtime and the
 * app/inherit entitlements. Override only the native audio helper so its TCC
 * identity and audio-input entitlement remain stable in the distribution build.
 */
export async function sign(configuration) {
  const helperPath = join(
    configuration.app,
    'Contents',
    'Resources',
    'bin',
    'qaing-audio-helper',
  )
  const inheritedOptionsForFile = configuration.optionsForFile
  await signAsync({
    ...configuration,
    binaries: [...(configuration.binaries ?? []), helperPath],
    optionsForFile: (filePath) => {
      const inherited = inheritedOptionsForFile?.(filePath) ?? {}
      if (filePath !== helperPath) return inherited
      return {
        ...inherited,
        entitlements: helperEntitlements,
        additionalArguments: [
          ...(inherited.additionalArguments ?? []),
          '--identifier',
          HELPER_IDENTIFIER,
        ],
      }
    },
  })
}
