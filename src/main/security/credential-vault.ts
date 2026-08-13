import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProviderName, ProviderStatus } from '../../core/contracts'

export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface VaultFile {
  readonly version: 1
  readonly secrets: Partial<Record<ProviderName, string>>
}

const PROVIDERS: readonly ProviderName[] = ['deepseek', 'doubao_asr']

function isProviderName(value: string): value is ProviderName {
  return PROVIDERS.includes(value as ProviderName)
}

function maskSecret(secret: string): string {
  if (secret.length < 8) return '••••••••'
  return `${secret.slice(0, 3)}••••${secret.slice(-4)}`
}

function validateSecret(secret: string): string {
  const trimmed = secret.trim()
  if (trimmed.length < 8 || trimmed.length > 4096 || /[\r\n\0]/u.test(trimmed)) {
    throw new Error('凭据格式无效')
  }
  return trimmed
}

/** Stores only OS-encrypted ciphertext in a mode-0600 atomic JSON file. */
export class CredentialVault {
  readonly #filePath: string
  readonly #cipher: SecretCipher
  #mutation: Promise<void> = Promise.resolve()

  constructor(filePath: string, cipher: SecretCipher) {
    this.#filePath = filePath
    this.#cipher = cipher
  }

  async get(provider: ProviderName): Promise<string | null> {
    this.#assertEncryption()
    const file = await this.#readFile()
    const encoded = file.secrets[provider]
    if (!encoded) return null
    try {
      return this.#cipher.decryptString(Buffer.from(encoded, 'base64'))
    } catch {
      throw new Error(`无法解密 ${provider} 凭据，请重新配置`)
    }
  }

  async set(provider: ProviderName, secret: string): Promise<ProviderStatus> {
    this.#assertEncryption()
    const validated = validateSecret(secret)
    await this.#mutate(async (file) => ({
      ...file,
      secrets: {
        ...file.secrets,
        [provider]: this.#cipher.encryptString(validated).toString('base64'),
      },
    }))
    return { provider, configured: true, maskedKey: maskSecret(validated) }
  }

  async clear(provider: ProviderName): Promise<ProviderStatus> {
    this.#assertEncryption()
    await this.#mutate(async (file) => {
      const secrets = { ...file.secrets }
      delete secrets[provider]
      return { ...file, secrets }
    })
    return { provider, configured: false, maskedKey: null }
  }

  async statuses(): Promise<readonly ProviderStatus[]> {
    this.#assertEncryption()
    const file = await this.#readFile()
    return Promise.all(PROVIDERS.map(async (provider): Promise<ProviderStatus> => {
      const encoded = file.secrets[provider]
      if (!encoded) return { provider, configured: false, maskedKey: null }
      try {
        const secret = this.#cipher.decryptString(Buffer.from(encoded, 'base64'))
        return { provider, configured: true, maskedKey: maskSecret(secret) }
      } catch {
        return { provider, configured: false, maskedKey: null }
      }
    }))
  }

  #assertEncryption(): void {
    if (!this.#cipher.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，已拒绝保存或读取凭据')
    }
  }

  async #mutate(operation: (file: VaultFile) => Promise<VaultFile>): Promise<void> {
    const next = this.#mutation.then(async () => {
      const file = await this.#readFile()
      await this.#writeFile(await operation(file))
    })
    this.#mutation = next.catch(() => undefined)
    return next
  }

  async #readFile(): Promise<VaultFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#filePath, 'utf8'))
      if (!parsed || typeof parsed !== 'object') throw new Error('invalid vault')
      const candidate = parsed as { version?: unknown; secrets?: unknown }
      if (candidate.version !== 1 || !candidate.secrets || typeof candidate.secrets !== 'object') throw new Error('invalid vault')
      const secrets: Partial<Record<ProviderName, string>> = {}
      for (const [key, value] of Object.entries(candidate.secrets)) {
        if (isProviderName(key) && typeof value === 'string') secrets[key] = value
      }
      return { version: 1, secrets }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, secrets: {} }
      throw new Error('凭据存储损坏或不可读取')
    }
  }

  async #writeFile(file: VaultFile): Promise<void> {
    const directory = dirname(this.#filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(file), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporaryPath, this.#filePath)
    await chmod(this.#filePath, 0o600)
  }
}
