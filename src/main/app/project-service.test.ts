import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataStore } from '../data/database'
import { canonicalizeProjectInput } from '../project/canonical'
import { DataStoreProjectSyncRepository } from '../project/data-repository'
import { ProjectSyncService } from '../project/service'
import type { ProjectConverter, ProjectWatchHandle } from '../project/types'
import { DesktopProjectApplicationService } from './project-service'

class DeterministicConverter implements ProjectConverter {
  readonly convert = vi.fn<ProjectConverter['convert']>(async (request) => canonicalizeProjectInput(request))
  readonly dispose = vi.fn(async () => undefined)
}

class DirectoryGateway {
  readonly diagnostics: Array<{ readonly name: string; readonly content: string }> = []
  constructor(public rootPath: string) {}
  async selectDirectory(): Promise<string> { return this.rootPath }
  async saveDiagnostics(name: string, content: string): Promise<void> {
    this.diagnostics.push({ name, content })
  }
}

const fixtures: string[] = []
const applications: DesktopProjectApplicationService[] = []

async function setup(): Promise<{
  readonly root: string
  readonly store: DataStore
  readonly gateway: DirectoryGateway
  readonly application: DesktopProjectApplicationService
}> {
  const root = await mkdtemp(join(tmpdir(), 'qaing-project-app-'))
  fixtures.push(root)
  const store = new DataStore(':memory:')
  const converter = new DeterministicConverter()
  const repository = new DataStoreProjectSyncRepository({ store })
  const holder: { application?: DesktopProjectApplicationService } = {}
  const sync = new ProjectSyncService({
    repository,
    converter,
    watchFactory: (): ProjectWatchHandle => ({ close: () => undefined }),
    onProgress: (event) => holder.application?.handleProgress(event),
  })
  const gateway = new DirectoryGateway(root)
  const application = new DesktopProjectApplicationService({ store, sync, directories: gateway })
  holder.application = application
  applications.push(application)
  return { root, store, gateway, application }
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.dispose()))
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('DesktopProjectApplicationService', () => {
  it('requires an explicit confirmation before creating the fixed project layout', async () => {
    const { root, store, application } = await setup()
    const selected = await application.selectRoot()
    expect(selected).toMatchObject({ status: 'confirmation_required' })
    if (selected.status !== 'confirmation_required') throw new Error('expected confirmation')
    expect(selected.confirmation.directories).toEqual([
      '原始资料',
      '预设QA',
      '转换资料库/资料',
      '转换资料库/预设QA',
      '.qaing',
    ])

    const summary = await application.confirmDirectories(selected.confirmation.projectId)
    expect(summary.displayName).toBe(root.split('/').at(-1))
    expect(store.getActiveProjectId()).toBe(summary.id)
    await expect(readFile(join(root, '.qaing', 'project.json'), 'utf8')).resolves.toContain(summary.id)
    const state = await application.getState()
    expect(state).toMatchObject({ activeProjectId: summary.id, directoryConfirmation: null })
    expect(JSON.stringify(state)).not.toContain(root)
  })

  it('syncs only converted project content and exposes relative, revision-fenced task rows', async () => {
    const { root, store, application } = await setup()
    const selected = await application.selectRoot()
    if (selected.status !== 'confirmation_required') throw new Error('expected confirmation')
    const project = await application.confirmDirectories(selected.confirmation.projectId)
    await writeFile(join(root, '原始资料', '品牌手册.txt'), '品牌的核心定位是可靠与高效。')

    const started = await application.startSync(project.id)
    expect(started.projectId).toBe(project.id)
    await vi.waitFor(async () => {
      const state = await application.getState()
      expect(state.run?.status).toBe('completed')
    })
    const state = await application.getState()
    const page = await application.getTaskPage({ projectId: project.id, limit: 20 })
    expect(page.dataRevision).toBe(state.dataRevision)
    expect(page.items).toEqual([
      expect.objectContaining({
        projectId: project.id,
        relativePath: '原始资料/品牌手册.txt',
        kind: 'source_document',
      }),
    ])
    expect(JSON.stringify(page)).not.toContain(root)
    const outputRelativePath = store.listProjectManifestEntries(project.id)[0]?.outputRelativePath
    expect(outputRelativePath).toBeTruthy()
    await expect(readFile(join(root, outputRelativePath ?? ''), 'utf8')).resolves.toContain('source_relative_path')
  })

  it('restores completed progress from the persisted run after an application-service restart', async () => {
    const { root, store, gateway, application } = await setup()
    const selected = await application.selectRoot()
    if (selected.status !== 'confirmation_required') throw new Error('expected confirmation')
    const project = await application.confirmDirectories(selected.confirmation.projectId)
    await Promise.all([
      writeFile(join(root, '原始资料', 'one.txt'), 'one'),
      writeFile(join(root, '原始资料', 'two.txt'), 'two'),
      writeFile(join(root, '原始资料', 'three.txt'), 'three'),
      writeFile(join(root, '原始资料', 'four.txt'), 'four'),
    ])
    await application.startSync(project.id)
    await vi.waitFor(async () => {
      expect((await application.getState()).run).toMatchObject({
        status: 'completed', completedItems: 4, totalItems: 4,
      })
    })
    await application.dispose()

    const converter = new DeterministicConverter()
    const repository = new DataStoreProjectSyncRepository({ store })
    const holder: { application?: DesktopProjectApplicationService } = {}
    const sync = new ProjectSyncService({
      repository,
      converter,
      watchFactory: (): ProjectWatchHandle => ({ close: () => undefined }),
      onProgress: (event) => holder.application?.handleProgress(event),
    })
    const restarted = new DesktopProjectApplicationService({ store, sync, directories: gateway })
    holder.application = restarted
    applications.push(restarted)

    await expect(restarted.getState()).resolves.toMatchObject({
      run: { status: 'completed', completedItems: 4, totalItems: 4 },
      counts: { completed: 4, total: 4 },
    })
  })

  it('uses one terminal count projection for non-convertible files before and after persistence', async () => {
    const { root, store, application } = await setup()
    const selected = await application.selectRoot()
    if (selected.status !== 'confirmation_required') throw new Error('expected confirmation')
    const project = await application.confirmDirectories(selected.confirmation.projectId)
    await writeFile(join(root, '原始资料', 'external.pdf'), '%PDF-1.7\nexternal conversion required')

    const started = await application.startSync(project.id)
    await vi.waitFor(async () => {
      await expect(application.getState()).resolves.toMatchObject({
        run: { status: 'completed', completedItems: 1, totalItems: 1 },
      })
    })
    expect(store.getProjectSyncRun(started.id)).toMatchObject({
      counts: { discovered: 1, blocked: 1 },
    })
  })

  it('reopens a previously selected project, preserves its policy, and starts visible reconciliation', async () => {
    const { root, store, application } = await setup()
    const selected = await application.selectRoot()
    if (selected.status !== 'confirmation_required') throw new Error('expected confirmation')
    const project = await application.confirmDirectories(selected.confirmation.projectId)
    await application.setSyncPolicy(project.id, 'manual')
    await writeFile(join(root, '原始资料', 'new-after-reopen.txt'), 'new project material')

    const reopened = await application.selectRoot()
    expect(reopened).toMatchObject({ status: 'ready', project: { id: project.id, syncPolicy: 'manual' } })
    expect(store.listProjects()).toHaveLength(1)
    await vi.waitFor(async () => {
      expect((await application.getState()).run).toMatchObject({ status: 'completed', totalItems: 1 })
    })
    expect(store.getProject(project.id)).toMatchObject({ syncPolicy: 'manual' })
    expect(store.listProjectDocumentLinks(project.id)).toHaveLength(1)
  })

  it('exports a bounded diagnostic summary without absolute paths or document bodies', async () => {
    const { root, gateway, application } = await setup()
    const selected = await application.selectRoot()
    if (selected.status !== 'confirmation_required') throw new Error('expected confirmation')
    const project = await application.confirmDirectories(selected.confirmation.projectId)
    await writeFile(join(root, '原始资料', 'safe.txt'), 'PRIVATE_BODY_MARKER')
    await application.startSync(project.id)
    await vi.waitFor(async () => {
      expect((await application.getState()).run?.status).toBe('completed')
    })

    await application.exportDiagnostics(project.id)
    expect(gateway.diagnostics).toHaveLength(1)
    const diagnostic = gateway.diagnostics[0]?.content ?? ''
    expect(diagnostic).not.toContain(root)
    expect(diagnostic).not.toContain('PRIVATE_BODY_MARKER')
    expect(diagnostic).toContain('原始资料/safe.txt')
  })

  it('uses one global revision floor across unselected, active, and background project changes', async () => {
    const { root, store, gateway, application } = await setup()
    const selectedA = await application.selectRoot()
    if (selectedA.status !== 'confirmation_required') throw new Error('expected project A confirmation')
    const projectA = await application.confirmDirectories(selectedA.confirmation.projectId)
    await writeFile(join(root, '原始资料', 'a.txt'), 'A project data')
    await application.startSync(projectA.id)
    await vi.waitFor(async () => { expect((await application.getState()).run?.status).toBe('completed') })

    const secondRoot = await mkdtemp(join(tmpdir(), 'qaing-project-app-b-'))
    fixtures.push(secondRoot)
    gateway.rootPath = secondRoot
    const selectedB = await application.selectRoot()
    if (selectedB.status !== 'confirmation_required') throw new Error('expected project B confirmation')
    const projectB = await application.confirmDirectories(selectedB.confirmation.projectId)
    const beforeBackgroundChange = store.projectDataRevision()
    const events: number[] = []
    const unsubscribe = application.subscribe((event) => { events.push(event.dataRevision) })
    await application.setSyncPolicy(projectA.id, 'manual')
    unsubscribe()

    const state = await application.getState()
    const page = await application.getTaskPage({ projectId: projectB.id, limit: 20 })
    expect(store.getProject(projectB.id)?.dataRevision).toBeLessThan(state.dataRevision)
    expect(state.dataRevision).toBeGreaterThan(beforeBackgroundChange)
    expect(page.dataRevision).toBe(state.dataRevision)
    expect(events.at(-1)).toBe(state.dataRevision)
  })
})
