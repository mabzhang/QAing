import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp-build'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '..', '..')

async function alphaStats(relativePath: string): Promise<{
  width: number
  height: number
  transparent: number
  visible: number
  opaqueWhite: number
  keyGreen: number
}> {
  const { data, info } = await sharp(resolve(projectRoot, relativePath))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let transparent = 0
  let visible = 0
  let opaqueWhite = 0
  let keyGreen = 0
  for (let offset = 0; offset < data.length; offset += 4) {
    const red = data[offset] ?? 0
    const green = data[offset + 1] ?? 0
    const blue = data[offset + 2] ?? 0
    const alpha = data[offset + 3] ?? 0
    if (alpha === 0) transparent += 1
    if (alpha > 16) {
      visible += 1
      if (red > 248 && green > 248 && blue > 248 && alpha > 248) opaqueWhite += 1
      if (green > 245 && red < 15 && blue < 15) keyGreen += 1
    }
  }
  return { width: info.width, height: info.height, transparent, visible, opaqueWhite, keyGreen }
}

describe('ZenX brand assets', () => {
  it('keeps the app wordmark transparent and free of chroma-key green', async () => {
    const stats = await alphaStats('build/brand/ZenX-wordmark-transparent.png')
    expect(stats).toMatchObject({ width: 1748, height: 432, keyGreen: 0 })
    expect(stats.transparent).toBeGreaterThan(stats.visible)
    expect(existsSync(resolve(projectRoot, 'build/brand/ZenX-wordmark-chroma.png'))).toBe(false)
  })

  it('uses a white Dock tile with transparent rounded corners', async () => {
    const stats = await alphaStats('build/icons/QAing.png')
    expect(stats).toMatchObject({ width: 1024, height: 1024, keyGreen: 0 })
    expect(stats.transparent).toBeGreaterThan(40_000)
    expect(stats.opaqueWhite).toBeGreaterThan(800_000)
  })

  it('provides correctly sized monochrome transparent menu-bar templates', async () => {
    expect(await alphaStats('build/icons/ZenXMenuBarTemplate.png')).toMatchObject({
      width: 64,
      height: 18,
      keyGreen: 0,
    })
    expect(await alphaStats('build/icons/ZenXMenuBarTemplate@2x.png')).toMatchObject({
      width: 128,
      height: 36,
      keyGreen: 0,
    })
    const oneX = await alphaStats('build/icons/ZenXMenuBarTemplate.png')
    expect(oneX.transparent).toBeGreaterThan(0)
    expect(oneX.visible).toBeGreaterThan(100)
    expect(oneX.opaqueWhite).toBe(0)
  })

  it('ships the approved installer background at the configured Finder window size', async () => {
    const backgroundPath = resolve(projectRoot, 'build/dmg/ZenX-dmg-background.png')
    const sourcePath = resolve(projectRoot, 'build/dmg/ZenX-dmg-background-source.png')
    await expect(sharp(backgroundPath).metadata()).resolves.toMatchObject({ width: 660, height: 420 })
    await expect(sharp(sourcePath).metadata()).resolves.toMatchObject({ width: 1571, height: 1001 })
    const digest = createHash('sha256').update(await readFile(backgroundPath)).digest('hex')
    expect(digest).toBe('60c75ac5a7af36dd4a0456219e0e8b3fd7d709bbea6ccfa5ac902d2cd4794759')

    const packageConfig = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8')) as {
      build?: { dmg?: { contents?: readonly { x?: number; y?: number }[] } }
    }
    expect(packageConfig.build?.dmg?.contents).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: 170, y: 235 }),
      expect.objectContaining({ x: 490, y: 235 }),
    ]))
  })
})
