import { readFileSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'

type WindowPort = Pick<BrowserWindow, 'setAlwaysOnTop' | 'setVisibleOnAllWorkspaces'>

interface StoredWindowPreferences {
  readonly alwaysOnTop: boolean
}

function readPreferences(path: string): StoredWindowPreferences {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { alwaysOnTop?: unknown }).alwaysOnTop === 'boolean') {
      return { alwaysOnTop: (parsed as { alwaysOnTop: boolean }).alwaysOnTop }
    }
  } catch {
    // Missing or malformed settings fail closed to ordinary window behavior.
  }
  return { alwaysOnTop: false }
}

export class WindowBehaviorController {
  readonly #path: string
  #alwaysOnTop: boolean
  #window: WindowPort | null = null
  #writeQueue: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.#path = path
    this.#alwaysOnTop = readPreferences(path).alwaysOnTop
  }

  get alwaysOnTop(): boolean {
    return this.#alwaysOnTop
  }

  attach(window: WindowPort): void {
    this.#window = window
    this.#apply()
  }

  setAlwaysOnTop(enabled: boolean): Promise<void> {
    const operation = this.#writeQueue.then(async () => {
      if (enabled === this.#alwaysOnTop) return
      const previous = this.#alwaysOnTop
      this.#alwaysOnTop = enabled
      this.#apply()
      try {
        await this.#persist()
      } catch (error) {
        this.#alwaysOnTop = previous
        this.#apply()
        throw error
      }
    })
    this.#writeQueue = operation.catch(() => undefined)
    return operation
  }

  #apply(): void {
    if (this.#window === null) return
    this.#window.setAlwaysOnTop(this.#alwaysOnTop, this.#alwaysOnTop ? 'floating' : 'normal')
    // Pinning never implies following the user across Spaces or covering
    // fullscreen apps. Those high-interruption behaviors remain disabled.
    this.#window.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: false })
  }

  async #persist(): Promise<void> {
    const temporary = `${this.#path}.tmp-${process.pid}`
    try {
      await writeFile(temporary, `${JSON.stringify({ alwaysOnTop: this.#alwaysOnTop })}\n`, { mode: 0o600 })
      await rename(temporary, this.#path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}
