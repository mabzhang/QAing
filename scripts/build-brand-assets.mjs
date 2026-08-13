import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import sharp from 'sharp'

const projectRoot = resolve(import.meta.dirname, '..')
const defaultSource = join(projectRoot, 'build', 'brand', 'ZenX-wordmark-source.png')
const suppliedSource = process.argv[2] ? resolve(process.argv[2]) : defaultSource
const brandDir = join(projectRoot, 'build', 'brand')
const iconDir = join(projectRoot, 'build', 'icons')
const rendererAssetDir = join(projectRoot, 'src', 'renderer', 'assets')
const iconsetDir = join(iconDir, 'QAing.iconset')
const menuBarWidth = 64
const menuBarHeight = 18
const forbiddenKeyGreen = ({ red, green, blue }) => green > 245 && red < 15 && blue < 15
const appIconSizes = [16, 32, 64, 128, 256, 512, 1024]

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)))

async function whiteToAlpha(source) {
  const { data, info } = await sharp(source)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const output = Buffer.alloc(info.width * info.height * 4)

  for (let sourceOffset = 0, targetOffset = 0; sourceOffset < data.length; sourceOffset += 3, targetOffset += 4) {
    const red = data[sourceOffset]
    const green = data[sourceOffset + 1]
    const blue = data[sourceOffset + 2]
    let alpha = 255 - Math.min(red, green, blue)
    if (alpha <= 12) alpha = 0
    else if (alpha < 40) alpha = clamp(((alpha - 12) / 28) * 40)

    if (alpha === 0) {
      output[targetOffset] = 0
      output[targetOffset + 1] = 0
      output[targetOffset + 2] = 0
      output[targetOffset + 3] = 0
      continue
    }

    const backgroundContribution = 255 - alpha
    output[targetOffset] = clamp(((red - backgroundContribution) * 255) / alpha)
    output[targetOffset + 1] = clamp(((green - backgroundContribution) * 255) / alpha)
    output[targetOffset + 2] = clamp(((blue - backgroundContribution) * 255) / alpha)
    output[targetOffset + 3] = alpha
  }

  return sharp(output, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).png().toBuffer()
}

async function roundedWhiteTile(wordmark) {
  const wordmarkMeta = await sharp(wordmark).metadata()
  const symbolLeft = Math.floor((wordmarkMeta.width ?? 0) * 0.6)
  const symbolWidth = (wordmarkMeta.width ?? 0) - symbolLeft
  const symbolSlice = await sharp(wordmark)
    .extract({ left: symbolLeft, top: 0, width: symbolWidth, height: wordmarkMeta.height ?? 0 })
    .png()
    .toBuffer()
  const symbol = await sharp(symbolSlice)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
    .png()
    .toBuffer()
  const logo = await sharp(symbol)
    .resize({ width: 820, height: 620, fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer()
  const logoMeta = await sharp(logo).metadata()
  const left = Math.round((1024 - (logoMeta.width ?? 0)) / 2)
  const top = Math.round((1024 - (logoMeta.height ?? 0)) / 2)
  const tile = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: logo, left, top }])
    .png()
    .toBuffer()

  const mask = Buffer.alloc(1024 * 1024)
  const radius = 224
  const max = 1023
  for (let y = 0; y <= max; y += 1) {
    for (let x = 0; x <= max; x += 1) {
      const nearestX = x < radius ? radius : x > max - radius ? max - radius : x
      const nearestY = y < radius ? radius : y > max - radius ? max - radius : y
      const dx = x - nearestX
      const dy = y - nearestY
      mask[(y * 1024) + x] = dx * dx + dy * dy <= radius * radius ? 255 : 0
    }
  }

  const alphaPixels = Buffer.alloc(1024 * 1024 * 4)
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4
    alphaPixels[offset] = 255
    alphaPixels[offset + 1] = 255
    alphaPixels[offset + 2] = 255
    alphaPixels[offset + 3] = mask[index]
  }
  const alphaMask = await sharp(alphaPixels, {
    raw: { width: 1024, height: 1024, channels: 4 },
  }).png().toBuffer()
  return sharp(tile)
    .ensureAlpha()
    .composite([{ input: alphaMask, blend: 'dest-in' }])
    .png()
    .toBuffer()
}

async function writePng(path, pipeline) {
  await mkdir(dirname(path), { recursive: true })
  await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(path)
}

async function menuBarAsset(wordmark, scale) {
  const rendered = await sharp(wordmark)
    .resize({
      width: menuBarWidth * scale,
      height: menuBarHeight * scale,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const output = Buffer.alloc(rendered.data.length)
  for (let offset = 0; offset < rendered.data.length; offset += 4) {
    output[offset] = 0
    output[offset + 1] = 0
    output[offset + 2] = 0
    output[offset + 3] = rendered.data[offset + 3]
  }
  return sharp(output, {
    raw: {
      width: rendered.info.width,
      height: rendered.info.height,
      channels: 4,
    },
  }).png().toBuffer()
}

await mkdir(brandDir, { recursive: true })
await mkdir(iconDir, { recursive: true })
await mkdir(rendererAssetDir, { recursive: true })

if (suppliedSource !== defaultSource) {
  await sharp(suppliedSource).png({ compressionLevel: 9 }).toFile(defaultSource)
}

const source = await readFile(defaultSource)
const transparentCanvas = await whiteToAlpha(source)
const wordmark = await sharp(transparentCanvas)
  .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
  .extend({ top: 24, bottom: 24, left: 24, right: 24, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer()

await writeFile(join(brandDir, 'ZenX-wordmark-transparent.png'), wordmark)
await writeFile(join(rendererAssetDir, 'ZenX-wordmark-transparent.png'), wordmark)

const appIcon = await roundedWhiteTile(wordmark)
await writeFile(join(iconDir, 'QAing.png'), appIcon)

for (const size of appIconSizes) {
  const resized = await sharp(appIcon).resize(size, size).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const visibleRows = new Set()
  for (let offset = 0; offset < resized.data.length; offset += 4) {
    const red = resized.data[offset]
    const green = resized.data[offset + 1]
    const blue = resized.data[offset + 2]
    const alpha = resized.data[offset + 3]
    if (alpha > 20 && !(red > 245 && green > 245 && blue > 245)) {
      visibleRows.add(Math.floor((offset / 4) / resized.info.width))
    }
  }
  if (visibleRows.size < Math.max(6, Math.floor(size * 0.4))) {
    throw new Error(`ZenX app icon is not optically legible at ${size}px`)
  }
}

await writeFile(join(iconDir, 'ZenXMenuBarTemplate.png'), await menuBarAsset(wordmark, 1))
await writeFile(join(iconDir, 'ZenXMenuBarTemplate@2x.png'), await menuBarAsset(wordmark, 2))

await rm(iconsetDir, { recursive: true, force: true })
await mkdir(iconsetDir, { recursive: true })
const iconSizes = [16, 32, 128, 256, 512]
for (const size of iconSizes) {
  await writePng(join(iconsetDir, `icon_${size}x${size}.png`), sharp(appIcon).resize(size, size))
  await writePng(join(iconsetDir, `icon_${size}x${size}@2x.png`), sharp(appIcon).resize(size * 2, size * 2))
}

const transparentMeta = await sharp(wordmark).metadata()
const menuStats = await sharp(join(iconDir, 'ZenXMenuBarTemplate@2x.png')).stats()
if (transparentMeta.hasAlpha !== true || menuStats.isOpaque) {
  throw new Error('ZenX transparent assets must retain an alpha channel')
}
if (extname(defaultSource).toLowerCase() !== '.png') throw new Error('ZenX source must remain a PNG')

for (const path of [
  join(brandDir, 'ZenX-wordmark-transparent.png'),
  join(iconDir, 'ZenXMenuBarTemplate.png'),
  join(iconDir, 'ZenXMenuBarTemplate@2x.png'),
]) {
  const { data } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let keyGreenPixels = 0
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] > 16 && forbiddenKeyGreen({
      red: data[offset],
      green: data[offset + 1],
      blue: data[offset + 2],
    })) keyGreenPixels += 1
  }
  if (keyGreenPixels > 0) throw new Error(`Forbidden green key color leaked into ${path}`)
}

process.stdout.write(
  `ZenX brand assets prepared from ${defaultSource}\n` +
  `Transparent wordmark: ${transparentMeta.width}x${transparentMeta.height}\n` +
  'Run iconutil -c icns build/icons/QAing.iconset -o build/icons/QAing.icns\n',
)
