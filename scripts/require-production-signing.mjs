import { execFileSync } from 'node:child_process'

function fail(message) {
  process.stderr.write(`Production packaging blocked: ${message}\n`)
  process.exit(1)
}

let identities = ''
try {
  identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch {
  fail('unable to inspect the macOS code-signing keychain')
}

if (!/Developer ID Application:/u.test(identities)) {
  fail('a valid Developer ID Application identity is required')
}

const hasApiCredentials = Boolean(
  process.env.APPLE_API_KEY
  && process.env.APPLE_API_KEY_ID
  && process.env.APPLE_API_ISSUER,
)
const hasAppleIdCredentials = Boolean(
  process.env.APPLE_ID
  && process.env.APPLE_APP_SPECIFIC_PASSWORD
  && process.env.APPLE_TEAM_ID,
)
const hasKeychainProfile = Boolean(
  process.env.APPLE_KEYCHAIN
  && process.env.APPLE_KEYCHAIN_PROFILE,
)

if (!hasApiCredentials && !hasAppleIdCredentials && !hasKeychainProfile) {
  fail('notarization credentials are required; use an App Store Connect API key, Apple ID trio, or keychain profile')
}

process.stdout.write('Production signing and notarization prerequisites are present.\n')
