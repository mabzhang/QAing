import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = join(projectRoot, 'build', 'legal', 'generated')
const lockPath = join(projectRoot, 'package-lock.json')
const packagePath = join(projectRoot, 'package.json')
const MAX_LEGAL_FILE_BYTES = 2 * 1024 * 1024
const DOWNLOAD_ATTEMPTS = 3

const downloads = [
  {
    name: 'onnxruntime-LICENSE.txt',
    url: 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.24.3/LICENSE',
    sha256: '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c',
  },
  {
    name: 'onnxruntime-ThirdPartyNotices.txt',
    url: 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.24.3/ThirdPartyNotices.txt',
    sha256: '0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2',
  },
  {
    name: 'onnxruntime-Privacy.md',
    url: 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.24.3/docs/Privacy.md',
    sha256: '9a15f9fd9d4c7b6dfc35f237f461863f84f8f73cf6189e330818a674d3828871',
  },
]

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
}

async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 })
  try {
    const existing = await readFile(path)
    if (Buffer.compare(existing, data) === 0) return
  } catch {
    // A missing generated file is expected on a clean checkout.
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, data, { flag: 'wx', mode: 0o644 })
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

async function downloadPinned(entry) {
  let lastError = null
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('legal download timed out')), 20_000)
    try {
      const response = await fetch(entry.url, {
        signal: controller.signal,
        redirect: 'error',
        headers: { 'user-agent': 'QAing-public-build/0.1.8-preview.1' },
      })
      if (!response.ok) throw new Error(`legal download returned HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length < 1 || buffer.length > MAX_LEGAL_FILE_BYTES) {
        throw new Error(`legal download size is outside the allowed range: ${entry.name}`)
      }
      if (sha256(buffer) !== entry.sha256) throw new Error(`legal download hash mismatch: ${entry.name}`)
      await atomicWrite(join(outputRoot, entry.name), buffer)
      return
    } catch (error) {
      lastError = error
      if (attempt < DOWNLOAD_ATTEMPTS) await wait(250 * attempt)
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`legal download failed: ${entry.name}`)
}

function packageNameFromPath(path) {
  const parts = path.split('node_modules/')
  return parts.at(-1) ?? path
}

function excludedFromPublicBundle(path) {
  return path.startsWith('node_modules/@img/')
    || path.startsWith('node_modules/@huggingface/transformers/node_modules/@img/')
    || path.startsWith('node_modules/@huggingface/transformers/node_modules/sharp')
    || path.startsWith('node_modules/sharp-build')
    || path.startsWith('node_modules/onnxruntime-web')
    || path.startsWith('node_modules/guid-typescript')
    || path === 'node_modules/@emnapi/runtime'
    || path === 'node_modules/tslib'
}

async function writeDependencyInventory() {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  const inventory = new Map()
  for (const [path, value] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith('node_modules/') || value.dev === true || excludedFromPublicBundle(path)) continue
    const linked = value.link === true && typeof value.resolved === 'string'
      ? lock.packages?.[value.resolved]
      : null
    const record = linked ?? value
    if (typeof record.version !== 'string' || typeof record.license !== 'string') continue
    const name = packageNameFromPath(path)
    inventory.set(`${name}\0${record.version}`, {
      name,
      version: record.version,
      license: record.license,
      ...(typeof record.resolved === 'string' ? { source: record.resolved } : {}),
    })
  }
  const payload = {
    schema: 'qaing-public-dependency-licenses/v1',
    applicationVersion: packageJson.version,
    generatedFrom: 'package-lock.json',
    note: 'Build-only image packages and files explicitly excluded from the public application bundle are omitted.',
    packages: [...inventory.values()].sort((left, right) => (
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
    )),
  }
  await atomicWrite(
    join(outputRoot, 'npm-production-dependency-licenses.json'),
    Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'),
  )
}

await Promise.all(downloads.map((entry) => downloadPinned(entry)))
await writeDependencyInventory()
process.stdout.write('Prepared pinned public-binary legal materials.\n')
