import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = join(projectRoot, 'native', 'audio-helper')
const outputPath = join(projectRoot, 'build', 'native', 'qaing-audio-helper')

execFileSync('swift', ['build', '--package-path', packagePath, '-c', 'release', '--arch', 'arm64'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
})

const binaryDirectory = execFileSync(
  'swift',
  ['build', '--package-path', packagePath, '-c', 'release', '--arch', 'arm64', '--show-bin-path'],
  { cwd: projectRoot, encoding: 'utf8', env: process.env },
).trim()
const sourcePath = join(binaryDirectory, 'qaing-audio-helper')
const strippedPath = `${outputPath}.stripped`

mkdirSync(dirname(outputPath), { recursive: true })
rmSync(outputPath, { force: true })
rmSync(strippedPath, { force: true })
copyFileSync(sourcePath, outputPath)
try {
  execFileSync('strip', ['-S', '-x', '-o', strippedPath, outputPath], {
    cwd: projectRoot,
    stdio: 'inherit',
  })
  rmSync(outputPath, { force: true })
  renameSync(strippedPath, outputPath)
} finally {
  rmSync(strippedPath, { force: true })
}
chmodSync(outputPath, 0o755)

if (readFileSync(outputPath).includes(Buffer.from('/Users/'))) {
  throw new Error('Native helper must not contain local macOS home-directory build paths')
}

const architectures = execFileSync('lipo', ['-archs', outputPath], { encoding: 'utf8' }).trim()
if (architectures !== 'arm64') {
  throw new Error(`Native helper must contain only arm64, received: ${architectures}`)
}
