const { app, utilityProcess } = require('electron')
const { access } = require('node:fs/promises')
const { resolve } = require('node:path')

const PROTOCOL = 'qaing-local-bge-v1'
const REVISION = 'a48549b3259a6165364f226599cd91f39923d5d5'
const DIMENSION = 1_024
const appPath = resolve(process.argv[2] ?? 'dist/mac-arm64/QAing.app')
const workerPath = resolve(appPath, 'Contents', 'Resources', 'app.asar', 'out', 'main', 'bge-worker.js')
const cacheDir = process.env['QAING_BGE_CACHE_DIR']?.trim()

if (!cacheDir) throw new Error('QAING_BGE_CACHE_DIR is required for the packaged BGE smoke test')

async function main() {
  await access(workerPath)
  await app.whenReady()
  process.stdout.write('Packaged BGE smoke: Electron ready\n')

  const worker = utilityProcess.fork(workerPath, [], {
    serviceName: 'QAing Packaged BGE Smoke',
    stdio: ['ignore', 'ignore', 'pipe'],
    allowLoadingUnsignedLibraries: false,
  })
  process.stdout.write('Packaged BGE smoke: utility process started\n')
  let complete = false
  let settled = false
  let stderr = ''
  worker.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })

  function finish(error) {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    worker.kill()
    if (error) {
      process.stderr.write(`${error.message}\n`)
      if (stderr.trim()) process.stderr.write(`${stderr.slice(0, 2_000)}\n`)
      app.exit(1)
      return
    }
    app.exit(0)
  }

  const timeout = setTimeout(() => finish(new Error('Packaged BGE smoke timed out')), 120_000)
  worker.on('error', () => finish(new Error('Packaged BGE utility process failed')))
  worker.on('exit', (code) => {
    if (!complete) finish(new Error(`Packaged BGE utility process exited early (${String(code)})`))
  })
  worker.on('message', (message) => {
    if (!message || message.protocol !== PROTOCOL || message.kind === 'progress') return
    if (message.ok !== true) {
      finish(new Error(`Packaged BGE worker rejected the request (${String(message.code ?? 'UNKNOWN')})`))
      return
    }
    if (message.id === 'prepare' && message.kind === 'prepared') {
      worker.postMessage({
        protocol: PROTOCOL,
        id: 'embed',
        kind: 'embed',
        texts: ['QAing 公开安装包语义检索验收'],
      })
      return
    }
    if (message.id !== 'embed' || message.kind !== 'embedded') return
    const vector = message.vectors?.[0]
    if (!(vector instanceof Float32Array) || vector.length !== DIMENSION) {
      finish(new Error('Packaged BGE returned an invalid vector shape'))
      return
    }
    let normSquared = 0
    for (const value of vector) {
      if (!Number.isFinite(value)) {
        finish(new Error('Packaged BGE returned a non-finite value'))
        return
      }
      normSquared += value * value
    }
    const norm = Math.sqrt(normSquared)
    if (Math.abs(norm - 1) > 0.001) {
      finish(new Error(`Packaged BGE returned a non-normalized vector (${String(norm)})`))
      return
    }
    complete = true
    process.stdout.write(`Packaged BGE smoke passed: 1x${String(DIMENSION)}, finite, norm=${norm.toFixed(6)}\n`)
    finish()
  })

  worker.postMessage({
    protocol: PROTOCOL,
    id: 'prepare',
    kind: 'prepare',
    config: {
      cacheDir,
      revision: REVISION,
      dtype: 'q4',
      maxBatchSize: 16,
    },
  })
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Packaged BGE smoke failed'}\n`)
  app.exit(1)
})
