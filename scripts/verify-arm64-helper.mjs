import { accessSync, constants, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appEntitlements = join(projectRoot, 'build', 'entitlements.mac.plist')
const inheritEntitlements = join(projectRoot, 'build', 'entitlements.mac.inherit.plist')
const helperEntitlements = join(projectRoot, 'build', 'entitlements.audio-helper.plist')
const HELPER_IDENTIFIER = 'com.qaing.desktop.audio-helper'
const MINIMUM_MACOS_VERSION = '14.0'
const MINIMUM_MACOS_NUMBER = 14
const require = createRequire(import.meta.url)
const { signAsync } = require('@electron/osx-sign')
const { extractFile, listPackage, statFile } = require('@electron/asar')

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return `${result.stdout}${result.stderr}`.trim()
}

async function signAdHocInsideOut(appPath, helperPath) {
  // Developer builds commonly have no Developer ID identity. Give both the
  // nested helper and the outer app internally consistent Hardened Runtime
  // signatures so local /Applications smoke tests are meaningful. When a
  // Developer ID is configured, electron-builder signs these same items again
  // with the distribution identity after this hook.
  await signAsync({
    app: appPath,
    platform: 'darwin',
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    binaries: [helperPath],
    optionsForFile: (filePath) => ({
      // The top-level process owns the TCC preflight. Keep audio-input off
      // Electron's renderer/GPU/plugin helpers, while the native capture
      // helper receives its dedicated least-privilege entitlement file.
      entitlements: filePath === helperPath
        ? helperEntitlements
        : filePath === appPath
          ? appEntitlements
          : inheritEntitlements,
      hardenedRuntime: true,
      timestamp: 'none',
    }),
  })
}

function assertPlistValue(path, key, expected) {
  const actual = output('plutil', ['-extract', key, 'raw', path])
  if (actual !== expected) throw new Error(`${key} must be ${expected}, received: ${actual}`)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function regularFiles(root) {
  const files = []
  const visit = (path) => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry))
      return
    }
    if (stat.isFile()) files.push(path)
  }
  visit(root)
  return files
}

function machOMinimumVersion(path) {
  const probe = spawnSync('file', ['-b', path], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0 || !/Mach-O/u.test(probe.stdout)) return null
  const build = output('xcrun', ['vtool', '-show-build', path])
  const minimum = parseMacOsMinimumVersion(build)
  if (minimum === null) throw new Error(`Packaged Mach-O has no valid minimum macOS version: ${path}`)
  return minimum
}

export function parseMacOsMinimumVersion(buildOutput) {
  const match = /^\s+(?:minos|version) (\d+(?:\.\d+){0,2})$/mu.exec(buildOutput)
  if (!match) return null
  const minimum = Number.parseFloat(match[1] ?? '')
  return Number.isFinite(minimum) ? minimum : null
}

function assertPackagedMachOsCompatibility(appPath) {
  const binaries = []
  for (const path of regularFiles(appPath)) {
    const minimum = machOMinimumVersion(path)
    if (minimum === null) continue
    const architectures = output('lipo', ['-archs', path])
    if (architectures !== 'arm64') {
      throw new Error(`Packaged Mach-O must contain only arm64, received ${architectures}: ${path}`)
    }
    binaries.push({ path, minimum, architectures })
    if (minimum > MINIMUM_MACOS_NUMBER) {
      throw new Error(`Packaged native binary requires macOS ${minimum}, above declared ${MINIMUM_MACOS_VERSION}: ${path}`)
    }
  }
  if (binaries.length === 0) throw new Error('Packaged app contains no verifiable Mach-O binaries')
}

function assertSameFile(source, packaged, label) {
  accessSync(source, constants.R_OK)
  accessSync(packaged, constants.R_OK)
  if (sha256(source) !== sha256(packaged)) throw new Error(`Packaged legal material differs from source: ${label}`)
}

function assertPackagedLegalMaterials(appPath) {
  const licenses = join(appPath, 'Contents', 'Resources', 'licenses')
  for (const [source, packaged] of [
    [join(projectRoot, 'LICENSE'), join(licenses, 'QAing-LICENSE.txt')],
    [join(projectRoot, 'NOTICE'), join(licenses, 'QAing-NOTICE.txt')],
    [join(projectRoot, 'TRADEMARKS.md'), join(licenses, 'QAing-TRADEMARKS.md')],
    [join(projectRoot, 'THIRD_PARTY_NOTICES.md'), join(licenses, 'QAing-THIRD_PARTY_NOTICES.md')],
    [join(projectRoot, 'node_modules', 'electron', 'dist', 'LICENSE'), join(licenses, 'Electron-LICENSE.txt')],
    [join(projectRoot, 'node_modules', 'electron', 'dist', 'LICENSES.chromium.html'), join(licenses, 'Electron-LICENSES.chromium.html')],
  ]) {
    assertSameFile(source, packaged, packaged.slice(licenses.length + 1))
  }
  const legalSource = join(projectRoot, 'build', 'legal')
  const legalTarget = join(licenses, 'public-binary')
  for (const source of regularFiles(legalSource)) {
    const relative = source.slice(legalSource.length + 1)
    assertSameFile(source, join(legalTarget, relative), relative)
  }
  for (const required of [
    'generated/onnxruntime-LICENSE.txt',
    'generated/onnxruntime-ThirdPartyNotices.txt',
    'generated/onnxruntime-Privacy.md',
    'generated/npm-production-dependency-licenses.json',
    'API-CREDENTIALS.md',
    'MODEL-PROVENANCE.md',
    'PUBLIC-BINARY-NOTICE.md',
  ]) {
    accessSync(join(legalTarget, required), constants.R_OK)
  }
}

const FORBIDDEN_ASAR_PATHS = [
  /(?:^|\/)node_modules\/@img(?:\/|$)/u,
  /(?:^|\/)node_modules\/@huggingface\/transformers\/node_modules\/(?:@img|sharp)(?:\/|$)/u,
  /(?:^|\/)node_modules\/(?:onnxruntime-web|guid-typescript)(?:\/|$)/u,
  /(?:^|\/)node_modules\/zod\/src(?:\/|$)/u,
  /(?:^|\/)node_modules\/better-sqlite3\/lib\/(?:darwin-x64|linux-[^/]+|linuxmusl-[^/]+|win32-[^/]+)\.js$/u,
  /(?:^|\/)(?:\.env(?:\..*)?|credentials\.json|qaing\.sqlite3|window-preferences\.json)$/iu,
  /(?:^|\/)(?:\u9700\u6c42|audit|logo)(?:\/|$)/u,
]

const HIGH_CONFIDENCE_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/u,
  /(?:api|access|secret)[_-]?key\s*[:=]\s*["'][A-Za-z0-9/+_-]{16,}["']/iu,
]

function assertPublicAsar(appPath) {
  const appAsar = join(appPath, 'Contents', 'Resources', 'app.asar')
  accessSync(appAsar, constants.R_OK)
  const entries = listPackage(appAsar)
  for (const listedPath of entries) {
    const path = listedPath.replace(/^\/+/, '')
    if (FORBIDDEN_ASAR_PATHS.some((pattern) => pattern.test(path))) {
      throw new Error(`Public package contains a forbidden path: ${path}`)
    }
    let stat
    try {
      stat = statFile(appAsar, path)
    } catch {
      continue
    }
    if ('files' in stat || stat.size > 20 * 1024 * 1024) continue
    if (!/\.(?:c?js|mjs|json|md|txt|html|map|yml|yaml)$/iu.test(path)) continue
    const buffer = extractFile(appAsar, path)
    if (buffer.includes(0)) continue
    const text = buffer.toString('utf8')
    if (HIGH_CONFIDENCE_SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new Error(`Public package contains a credential-like value: ${path}`)
    }
  }
  const packagedManifest = JSON.parse(extractFile(appAsar, 'package.json').toString('utf8'))
  if (packagedManifest.version !== '0.1.8-preview.1') {
    throw new Error(`Packaged application version must be 0.1.8-preview.1, received: ${packagedManifest.version}`)
  }
}

export default async function verifyArm64Helper(context) {
  if (context.electronPlatformName !== 'darwin') {
    throw new Error('QAing packaging is restricted to macOS')
  }
  if (context.arch !== 3) {
    throw new Error(`QAing packaging is restricted to arm64 (electron-builder arch=${context.arch})`)
  }

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = join(context.appOutDir, appName)
  const appInfoPlist = join(appPath, 'Contents', 'Info.plist')
  const helperPath = join(appPath, 'Contents', 'Resources', 'bin', 'qaing-audio-helper')
  accessSync(helperPath, constants.R_OK | constants.X_OK)
  if (!statSync(helperPath).isFile()) throw new Error('Packaged audio helper is not a regular file')

  const architectures = output('lipo', ['-archs', helperPath])
  if (architectures !== 'arm64') {
    throw new Error(`Packaged audio helper must contain only arm64, received: ${architectures}`)
  }
  if (readFileSync(helperPath).includes(Buffer.from('/Users/'))) {
    throw new Error('Packaged audio helper contains a local macOS home-directory build path')
  }

  const loadCommands = output('otool', ['-l', helperPath])
  if (!/\bminos 14\.0\b/u.test(loadCommands)) throw new Error('Packaged audio helper must target macOS 14.0')
  const embeddedInfo = output('otool', ['-s', '__TEXT', '__info_plist', helperPath])
  if (!embeddedInfo.includes('Contents of (__TEXT,__info_plist) section')) {
    throw new Error('Packaged audio helper must contain an embedded Info.plist')
  }

  assertPlistValue(appInfoPlist, 'CFBundleIdentifier', 'com.qaing.desktop')
  assertPlistValue(appInfoPlist, 'CFBundleShortVersionString', '0.1.8')
  assertPlistValue(appInfoPlist, 'CFBundleVersion', '1081')
  assertPlistValue(appInfoPlist, 'LSMinimumSystemVersion', MINIMUM_MACOS_VERSION)
  assertPackagedMachOsCompatibility(appPath)
  assertPackagedLegalMaterials(appPath)
  assertPublicAsar(appPath)
  // electron-builder normalizes a custom source icon to `icon.icns` inside
  // the bundle. Verify the actual payload rather than relying on its source
  // filename so an Electron fallback icon cannot pass this gate.
  assertPlistValue(appInfoPlist, 'CFBundleIconFile', 'icon.icns')
  const packagedIcon = join(appPath, 'Contents', 'Resources', 'icon.icns')
  const sourceIcon = join(projectRoot, 'build', 'icons', 'QAing.icns')
  accessSync(packagedIcon, constants.R_OK)
  if (sha256(packagedIcon) !== sha256(sourceIcon)) {
    throw new Error('Packaged icon does not match the approved QAing brand icon')
  }
  for (const fileName of ['ZenXMenuBarTemplate.png', 'ZenXMenuBarTemplate@2x.png']) {
    const sourceMenuIcon = join(projectRoot, 'build', 'icons', fileName)
    const packagedMenuIcon = join(appPath, 'Contents', 'Resources', 'icons', fileName)
    accessSync(packagedMenuIcon, constants.R_OK)
    if (sha256(packagedMenuIcon) !== sha256(sourceMenuIcon)) {
      throw new Error(`Packaged menu-bar icon does not match the approved transparent ZenX asset: ${fileName}`)
    }
  }
  const approvedDmgBackground = join(projectRoot, 'build', 'dmg', 'ZenX-dmg-background.png')
  accessSync(approvedDmgBackground, constants.R_OK)
  if (sha256(approvedDmgBackground) !== '60c75ac5a7af36dd4a0456219e0e8b3fd7d709bbea6ccfa5ac902d2cd4794759') {
    throw new Error('DMG background does not match the approved ZenX audio-wave artwork')
  }
  assertPlistValue(appInfoPlist, 'NSMicrophoneUsageDescription', 'QAing 需要麦克风权限以实时转写现场提问。')
  assertPlistValue(appInfoPlist, 'NSAudioCaptureUsageDescription', 'QAing 需要系统音频权限以实时转写会议声音。')
  assertPlistValue(appInfoPlist, 'NSScreenCaptureUsageDescription', 'QAing 需要屏幕与系统音频录制权限以实时转写会议声音。')

  await signAdHocInsideOut(appPath, helperPath)
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const appSignedEntitlements = output('codesign', ['-d', '--entitlements', ':-', appPath])
  if (!appSignedEntitlements.includes('com.apple.security.device.audio-input')) {
    throw new Error('Packaged app is missing the audio-input entitlement required by its TCC preflight')
  }
  const helperSignature = output('codesign', ['-dv', '--verbose=4', helperPath])
  if (!helperSignature.includes(`Identifier=${HELPER_IDENTIFIER}`)) {
    throw new Error('Packaged audio helper does not have its stable signing identifier')
  }
  const helperSignedEntitlements = output('codesign', ['-d', '--entitlements', ':-', helperPath])
  if (!helperSignedEntitlements.includes('com.apple.security.device.audio-input')) {
    throw new Error('Packaged audio helper is missing the audio-input entitlement')
  }
  for (const forbidden of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
  ]) {
    if (helperSignedEntitlements.includes(forbidden)) {
      throw new Error(`Packaged audio helper has an unnecessary entitlement: ${forbidden}`)
    }
  }

  for (const suffix of ['', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
    const electronHelper = join(appPath, 'Contents', 'Frameworks', `${context.packager.appInfo.productFilename} Helper${suffix}.app`)
    const entitlements = output('codesign', ['-d', '--entitlements', ':-', electronHelper])
    if (entitlements.includes('com.apple.security.device.audio-input')) {
      throw new Error(`Electron child helper must not inherit audio-input: ${electronHelper}`)
    }
  }
}
