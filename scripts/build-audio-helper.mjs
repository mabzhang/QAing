import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
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

mkdirSync(dirname(outputPath), { recursive: true })
rmSync(outputPath, { force: true })
copyFileSync(sourcePath, outputPath)
chmodSync(outputPath, 0o755)

const architectures = execFileSync('lipo', ['-archs', outputPath], { encoding: 'utf8' }).trim()
if (architectures !== 'arm64') {
  throw new Error(`Native helper must contain only arm64, received: ${architectures}`)
}
