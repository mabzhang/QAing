import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialVault, type SecretCipher } from './credential-vault'

class FakeCipher implements SecretCipher {
  constructor(private readonly available = true) {}
  isEncryptionAvailable(): boolean { return this.available }
  encryptString(value: string): Buffer { return Buffer.from([...value].reverse().join(''), 'utf8') }
  decryptString(value: Buffer): string { return [...value.toString('utf8')].reverse().join('') }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })))
})

async function createVault(cipher: SecretCipher = new FakeCipher()): Promise<{ vault: CredentialVault; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'qaing-vault-test-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'credentials.json')
  return { vault: new CredentialVault(path, cipher), path }
}

describe('CredentialVault', () => {
  it('persists ciphertext and never writes plaintext', async () => {
    const { vault, path } = await createVault()
    const secret = 'example-secret-value-1234'
    const status = await vault.set('deepseek', secret)
    expect(status.maskedKey).toBe('exa••••1234')
    expect(await vault.get('deepseek')).toBe(secret)
    expect(await readFile(path, 'utf8')).not.toContain(secret)
  })

  it('serializes concurrent mutations without losing providers', async () => {
    const { vault } = await createVault()
    await Promise.all([
      vault.set('deepseek', 'deepseek-secret-value'),
      vault.set('doubao_asr', 'doubao-secret-value'),
    ])
    expect((await vault.statuses()).filter((status) => status.configured)).toHaveLength(2)
  })

  it('refuses plaintext fallback when OS encryption is unavailable', async () => {
    const { vault } = await createVault(new FakeCipher(false))
    await expect(vault.set('deepseek', 'a-valid-secret')).rejects.toThrow('系统安全存储不可用')
  })

  it('clears one provider without affecting the others', async () => {
    const { vault } = await createVault()
    await vault.set('deepseek', 'deepseek-secret-value')
    await vault.set('doubao_asr', 'doubao-secret-value')
    await vault.clear('deepseek')
    expect(await vault.get('deepseek')).toBeNull()
    expect(await vault.get('doubao_asr')).toBe('doubao-secret-value')
  })
})
