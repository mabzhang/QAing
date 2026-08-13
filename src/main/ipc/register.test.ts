import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { IPC_CHANNELS } from '../../core/contracts'
import { MarkdownQaParseError } from '../data/importers'
import { registerIpcHandlers, type DesktopFacade } from './register'

function fixture(): {
  readonly handlers: Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>
  readonly event: IpcMainInvokeEvent
  readonly facade: DesktopFacade
  readonly importPresetQa: ReturnType<typeof vi.fn<DesktopFacade['importPresetQa']>>
  readonly requestAudioPermission: ReturnType<typeof vi.fn<DesktopFacade['requestAudioPermission']>>
  readonly restartApplication: ReturnType<typeof vi.fn<DesktopFacade['restartApplication']>>
  readonly dispatch: ReturnType<typeof vi.fn<DesktopFacade['dispatch']>>
  readonly getProjectTaskPage: ReturnType<typeof vi.fn<NonNullable<DesktopFacade['getProjectTaskPage']>>>
  readonly startProjectSync: ReturnType<typeof vi.fn<NonNullable<DesktopFacade['startProjectSync']>>>
  readonly renderer: WebContents
} {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const ipcMain = {
    removeHandler: vi.fn(),
    handle: vi.fn((channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }),
  } as unknown as IpcMain
  const mainFrame = {}
  const renderer = {
    id: 41,
    mainFrame,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as WebContents
  const importPresetQa = vi.fn<DesktopFacade['importPresetQa']>()
  const requestAudioPermission = vi.fn<DesktopFacade['requestAudioPermission']>()
  const restartApplication = vi.fn<DesktopFacade['restartApplication']>()
  const dispatch = vi.fn<DesktopFacade['dispatch']>()
  const getProjectTaskPage = vi.fn<NonNullable<DesktopFacade['getProjectTaskPage']>>()
  const startProjectSync = vi.fn<NonNullable<DesktopFacade['startProjectSync']>>()
  const facade: DesktopFacade = {
    getSnapshot: vi.fn(),
    dispatch,
    configureProvider: vi.fn(),
    clearProvider: vi.fn(),
    importSourceDocuments: vi.fn(),
    importPresetQa,
    deleteDocument: vi.fn(),
    openSystemPermissions: vi.fn(),
    requestAudioPermission,
    restartApplication,
    setAlwaysOnTop: vi.fn(),
    getProjectTaskPage,
    startProjectSync,
  }
  registerIpcHandlers(ipcMain, renderer, facade)
  const event = { sender: renderer, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  return {
    handlers,
    event,
    facade,
    importPresetQa,
    requestAudioPermission,
    restartApplication,
    dispatch,
    getProjectTaskPage,
    startProjectSync,
    renderer,
  }
}

describe('IPC public error boundary', () => {
  it('exposes only a bounded Markdown QA code and line number', async () => {
    const target = fixture()
    const privateDetail = '/Users/private/qa.md contains secret source text'
    target.importPresetQa.mockRejectedValue(
      new MarkdownQaParseError('EXPECTED_ANSWER', 37, privateDetail),
    )
    const handler = target.handlers.get(IPC_CHANNELS.importPresetQa)
    if (!handler) throw new Error('Expected importPresetQa IPC handler')

    const failure = await handler(target.event).then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('QAING_QA_FORMAT:EXPECTED_ANSWER:37')
    expect((failure as Error).message).not.toMatch(/private|secret|qa\.md/u)
  })

  it('keeps unknown import failures generic', async () => {
    const target = fixture()
    target.importPresetQa.mockRejectedValue(
      new Error('/Users/private/qa.md contains secret source text'),
    )
    const handler = target.handlers.get(IPC_CHANNELS.importPresetQa)
    if (!handler) throw new Error('Expected importPresetQa IPC handler')

    const failure = await handler(target.event).then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('操作未完成，当前内容已保留，请重试')
    expect((failure as Error).message).not.toMatch(/private|secret|qa\.md/u)
  })

  it('validates the explicit permission wizard, application restart, and skip command boundaries', async () => {
    const target = fixture()
    target.requestAudioPermission.mockResolvedValue({ status: 'restart_required', code: 'SCREEN_PERMISSION_RESTART_REQUIRED' })

    const requestPermission = target.handlers.get(IPC_CHANNELS.requestAudioPermission)
    const restartApplication = target.handlers.get(IPC_CHANNELS.restartApplication)
    const dispatch = target.handlers.get(IPC_CHANNELS.dispatch)
    if (!requestPermission || !restartApplication || !dispatch) throw new Error('Expected permission and command handlers')

    await expect(requestPermission(target.event, 'system')).resolves.toEqual({
      status: 'restart_required',
      code: 'SCREEN_PERMISSION_RESTART_REQUIRED',
    })
    expect(target.requestAudioPermission).toHaveBeenCalledWith('system')
    await expect(requestPermission(target.event, 'invalid-source')).rejects.toThrow('请求参数无效')

    await expect(restartApplication(target.event)).resolves.toBeUndefined()
    expect(target.restartApplication).toHaveBeenCalledTimes(1)

    await expect(dispatch(target.event, { type: 'skip_question' })).resolves.toBeUndefined()
    expect(target.dispatch).toHaveBeenCalledWith({ type: 'skip_question' })
  })

  it('validates bounded opaque workspace cursors before reading answer history', async () => {
    const target = fixture()
    const getQaWorkspacePage = vi.fn(() => Promise.resolve({
      projectId: 'project_12345678', totalRounds: 0, items: [], nextCursor: null, dataRevision: 7,
    }))
    Object.assign(target.facade, { getQaWorkspacePage })
    const handler = target.handlers.get(IPC_CHANNELS.getQaWorkspacePage)
    if (!handler) throw new Error('Expected workspace page IPC handler')

    await expect(handler(target.event, {
      projectId: 'project_12345678', cursor: 'b3JkaW5hbF8xMA', limit: 20,
    })).resolves.toEqual({
      projectId: 'project_12345678',
      totalRounds: 0,
      items: [],
      nextCursor: null,
      dataRevision: 7,
    })
    expect(getQaWorkspacePage).toHaveBeenCalledWith({
      projectId: 'project_12345678', cursor: 'b3JkaW5hbF8xMA', limit: 20,
    })
    await expect(handler(target.event, {
      projectId: 'project_12345678', cursor: '../private/path', limit: 20,
    })).rejects.toThrow('请求参数无效')
    await expect(handler(target.event, { projectId: 'project_12345678', limit: 21 })).rejects.toThrow('请求参数无效')
    await expect(handler(target.event, { limit: 20 })).rejects.toThrow('请求参数无效')
  })

  it('validates project-scoped workspace delete, clear, and export mutations', async () => {
    const target = fixture()
    const deleteQaWorkspaceRound = vi.fn(() => Promise.resolve({ deleted: true, dataRevision: 8 }))
    const clearQaWorkspaceProject = vi.fn(() => Promise.resolve({ deletedRounds: 2, deletedTurns: 2, dataRevision: 9 }))
    const exportQaWorkspaceProject = vi.fn(() => Promise.resolve())
    Object.assign(target.facade, { deleteQaWorkspaceRound, clearQaWorkspaceProject, exportQaWorkspaceProject })
    const deleteHandler = target.handlers.get(IPC_CHANNELS.deleteQaWorkspaceRound)
    const clearHandler = target.handlers.get(IPC_CHANNELS.clearQaWorkspaceProject)
    const exportHandler = target.handlers.get(IPC_CHANNELS.exportQaWorkspaceProject)
    if (!deleteHandler || !clearHandler || !exportHandler) throw new Error('Expected workspace mutation IPC handlers')

    await expect(deleteHandler(target.event, 'project_12345678', 'round_12345678')).resolves.toEqual({
      deleted: true, dataRevision: 8,
    })
    await expect(clearHandler(target.event, 'project_12345678')).resolves.toEqual({
      deletedRounds: 2, deletedTurns: 2, dataRevision: 9,
    })
    await expect(exportHandler(target.event, 'project_12345678')).resolves.toBeUndefined()
    expect(deleteQaWorkspaceRound).toHaveBeenCalledWith('project_12345678', 'round_12345678')
    expect(clearQaWorkspaceProject).toHaveBeenCalledWith('project_12345678')
    expect(exportQaWorkspaceProject).toHaveBeenCalledWith('project_12345678')
    await expect(deleteHandler(target.event, 'project_12345678', '../private')).rejects.toThrow('请求参数无效')
  })

  it('keeps project paging and sync identifiers inside the closed IPC schema', async () => {
    const target = fixture()
    target.getProjectTaskPage.mockResolvedValue({ items: [], nextCursor: null, dataRevision: 11 })
    target.startProjectSync.mockResolvedValue({
      id: 'run_12345678',
      projectId: 'project_12345678',
      status: 'running',
      stage: 'scanning',
      completedItems: 0,
      totalItems: null,
      startedAt: 1,
      completedAt: null,
    })
    const getPage = target.handlers.get(IPC_CHANNELS.getProjectTaskPage)
    const start = target.handlers.get(IPC_CHANNELS.startProjectSync)
    if (!getPage || !start) throw new Error('Expected project IPC handlers')

    await expect(getPage(target.event, {
      projectId: 'project_12345678',
      filter: 'action_required',
      cursor: 'cGFnZV8y',
      limit: 20,
    })).resolves.toEqual({ items: [], nextCursor: null, dataRevision: 11 })
    expect(target.getProjectTaskPage).toHaveBeenCalledWith({
      projectId: 'project_12345678',
      filter: 'action_required',
      cursor: 'cGFnZV8y',
      limit: 20,
    })
    await expect(getPage(target.event, {
      projectId: 'project_12345678',
      cursor: '../../private',
    })).rejects.toThrow('请求参数无效')
    await expect(getPage(target.event, {
      projectId: 'project_12345678',
      limit: 21,
    })).rejects.toThrow('请求参数无效')

    await expect(start(target.event, 'project_12345678')).resolves.toMatchObject({
      id: 'run_12345678',
      projectId: 'project_12345678',
    })
    await expect(start(target.event, '/Users/private/project')).rejects.toThrow('请求参数无效')
  })

  it('publishes only lightweight monotonic project changes', () => {
    const listeners = new Set<(event: { projectId: string; dataRevision: number; scope: 'summary' | 'tasks' | 'all' }) => void>()
    const target = fixture()
    target.facade.subscribeProject = (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    // The registration must capture the subscription at construction, so use
    // a fresh fixture-like registration with the subscribed facade.
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
    const ipcMain = {
      removeHandler: vi.fn(),
      handle: vi.fn((channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler)
      }),
    } as unknown as IpcMain
    const registration = registerIpcHandlers(ipcMain, target.renderer, target.facade)
    const event = { projectId: 'project_12345678', dataRevision: 14, scope: 'tasks' as const }
    for (const listener of listeners) listener(event)
    // The fixture installs a standalone mock and never relies on WebContents
    // receiver binding.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const send = target.renderer.send as unknown as ReturnType<typeof vi.fn>
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.projectChanged, event)
    registration.dispose()
    expect(listeners.size).toBe(0)
  })
})
