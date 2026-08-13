import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowBehaviorController } from './window-behavior'

const temporaryDirectories: string[] = []

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qaing-window-'))
  temporaryDirectories.push(directory)
  return join(directory, 'window-preferences.json')
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('WindowBehaviorController', () => {
  it('defaults to a normal current-Space window and persists an explicit pin', async () => {
    const path = temporaryPath()
    const window = {
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
    }
    const controller = new WindowBehaviorController(path)
    controller.attach(window)
    expect(controller.alwaysOnTop).toBe(false)
    expect(window.setAlwaysOnTop).toHaveBeenLastCalledWith(false, 'normal')
    expect(window.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(false, { visibleOnFullScreen: false })

    await controller.setAlwaysOnTop(true)
    expect(window.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'floating')
    expect(new WindowBehaviorController(path).alwaysOnTop).toBe(true)

    await controller.setAlwaysOnTop(false)
    expect(new WindowBehaviorController(path).alwaysOnTop).toBe(false)
  })

  it('fails closed when stored preferences are malformed', () => {
    const path = temporaryPath()
    writeFileSync(path, '{not-json', 'utf8')
    expect(new WindowBehaviorController(path).alwaysOnTop).toBe(false)
  })
})
