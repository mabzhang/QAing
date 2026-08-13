import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const appPath = resolve(process.argv[2] ?? 'dist/mac-arm64/QAing.app')
const executable = join(appPath, 'Contents', 'MacOS', 'QAing')
const profile = await mkdtemp(join(tmpdir(), 'qaing-package-smoke-'))
const port = 9_200 + Math.floor(Math.random() * 500)
const child = spawn(executable, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

const wait = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

async function endpoint(path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`)
  if (!response.ok) throw new Error(`CDP endpoint ${path} returned ${response.status}`)
  return response.json()
}

try {
  let pages = []
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      pages = await endpoint('/json/list')
      if (pages.some((page) => page.type === 'page')) break
    } catch {
      // Startup is asynchronous; retry within the bounded five-second window.
    }
    await wait(100)
  }
  const page = pages.find((candidate) => candidate.type === 'page')
  if (!page?.webSocketDebuggerUrl) throw new Error('QAing renderer did not expose a CDP page')

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolvePromise, rejectPromise) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', rejectPromise, { once: true })
  })
  const evaluate = (id) => new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error('CDP evaluate timed out')), 3_000)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      socket.removeEventListener('message', onMessage)
      clearTimeout(timeout)
      resolvePromise(message.result?.result?.value)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        awaitPromise: true,
        expression: `(async () => ({
          body: document.body.innerText,
          rootChildren: document.querySelector('#root')?.childElementCount ?? 0,
          bridgeMethods: Object.keys(window.qaing ?? {}).sort(),
          snapshot: await window.qaing?.getSnapshot(),
        }))()`,
      },
    }))
  })
  let result
  for (let attempt = 0; attempt < 30; attempt += 1) {
    result = await evaluate(attempt + 1)
    if (result?.rootChildren > 0 && result?.body?.includes('QAing')) break
    await wait(100)
  }
  socket.close()

  if (result?.rootChildren < 1 || !result?.body?.includes('QAing')) {
    throw new Error('Packaged renderer is blank or incomplete')
  }
  const requiredBridgeMethods = [
    'clearQaWorkspaceProject',
    'deleteQaWorkspaceRound',
    'exportQaWorkspaceProject',
    'getProjectState',
    'getQaWorkspacePage',
    'getSnapshot',
    'onProjectChanged',
    'onQaWorkspaceChanged',
  ]
  if (
    result.bridgeMethods?.length !== 31
    || requiredBridgeMethods.some((method) => !result.bridgeMethods.includes(method))
    || result.snapshot?.runtime?.platform !== 'darwin-arm64'
    || typeof result.snapshot?.runtime?.alwaysOnTop !== 'boolean'
  ) {
    throw new Error('Packaged preload bridge or initial snapshot is incomplete')
  }
  if (/Unable to load preload|SyntaxError|Uncaught/i.test(stderr)) {
    throw new Error(`Packaged app logged a renderer/preload failure: ${stderr}`)
  }
  process.stdout.write('Packaged QAing smoke: renderer, preload bridge, and snapshot passed\n')
} finally {
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    wait(2_000),
  ])
  // `child.killed` only means a signal was sent; it does not prove the
  // process exited. Escalate a hung packaged app so the smoke test cannot
  // leave an orphan holding the temporary profile or microphone helper.
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await rm(profile, { recursive: true, force: true })
}
