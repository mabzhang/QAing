import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  AudioLevelSample,
  ProjectPublicState,
  ProjectSyncPolicy,
  ProjectTaskFilter,
  ProjectTaskPage,
  PublicSnapshot,
  QaSimulationJobSummary,
  QaSimulationPage,
  QaSimulationPageInput,
} from '../../core/contracts'
import type { QaWorkspacePage } from '../../core/types'
import App from '../App'
import {
  createUiAdapter,
  isQaingBridge,
  mapSnapshotToEnvironment,
  mergeSnapshotUpdate,
} from '../ui/bridge-adapter'
import { BootstrapScreen } from '../ui/BootstrapScreen'
import { appendAudioLevelSample } from '../ui/audio-level'
import type { ProjectUiState, SimulatedQaSlot } from '../ui/contracts'
import {
  simulationCursorTransition,
  simulationEventMatchesJob,
  simulationJobCanReplace,
  simulationJobMeetsEvent,
  simulationPageMatchesJob,
} from '../ui/simulated-qa'
import {
  QA_WORKSPACE_PAGE_LIMIT,
  advanceWorkspaceRevisionFloor,
  appendWorkspacePage,
  mergeWorkspaceRefresh,
  workspaceCursorMatchesRevisionFloor,
  workspaceEventAdvancesRevisionFloor,
  workspaceLoadMoreDisposition,
  workspaceMutationRequiresRefresh,
  workspacePageMeetsRevisionFloor,
  workspacePageMatchesProject,
  workspaceSelectionIsCurrent,
  workspaceRevisionIsValid,
} from '../ui/qa-workspace'
import {
  appendProjectTaskPage,
  PROJECT_TASK_PAGE_LIMIT,
  projectChangedEventDisposition,
  projectEventAffectsActiveSelection,
  projectRefreshPairDisposition,
  projectTaskPageDisposition,
} from '../project-runtime'
import '../ui/styles.css'

// eslint-disable-next-line react-refresh/only-export-components
function RendererRoot(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<PublicSnapshot | null>(null)
  const [audioLevels, setAudioLevels] = useState<readonly AudioLevelSample[]>([])
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [qaWorkspacePage, setQaWorkspacePage] = useState<QaWorkspacePage | null>(null)
  const [qaWorkspaceLoading, setQaWorkspaceLoading] = useState(true)
  const [qaWorkspaceLoadingMore, setQaWorkspaceLoadingMore] = useState(false)
  const [qaWorkspaceError, setQaWorkspaceError] = useState<string | null>(null)
  const [qaWorkspaceAttempt, setQaWorkspaceAttempt] = useState(0)
  const [projectPublicState, setProjectPublicState] = useState<ProjectPublicState | null>(null)
  const [projectTaskPage, setProjectTaskPage] = useState<ProjectTaskPage | null>(null)
  const [projectTaskFilter, setProjectTaskFilter] = useState<ProjectTaskFilter>('all')
  const [projectLoading, setProjectLoading] = useState(true)
  const [projectLoadingMore, setProjectLoadingMore] = useState(false)
  const [projectLoadFailed, setProjectLoadFailed] = useState(false)
  const [simulationJob, setSimulationJob] = useState<QaSimulationJobSummary | null>(null)
  const [simulationPage, setSimulationPage] = useState<QaSimulationPage | null>(null)
  const [simulationPageIndex, setSimulationPageIndex] = useState(0)
  const [simulationBusy, setSimulationBusy] = useState(false)
  const [simulationError, setSimulationError] = useState<string | null>(null)
  const qaWorkspaceGenerationRef = useRef(0)
  const qaWorkspaceRevisionFloorRef = useRef(0)
  const qaWorkspaceProjectRef = useRef<string | null>(null)
  const qaWorkspaceReplaceOnRefreshRef = useRef(false)
  const projectGenerationRef = useRef(0)
  const projectRevisionFloorRef = useRef(0)
  const projectPendingEventRevisionRef = useRef<number | null>(null)
  const projectTaskFilterRef = useRef<ProjectTaskFilter>('all')
  const simulationGenerationRef = useRef(0)
  const simulationJobRef = useRef<QaSimulationJobSummary | null>(null)
  const simulationCursorHistoryRef = useRef<readonly (string | null)[]>([])
  const bridgeCandidate: unknown = window.qaing
  const bridge = isQaingBridge(bridgeCandidate) ? bridgeCandidate : null
  const baseAdapter = useMemo(
    () => bridge === null ? null : createUiAdapter(bridge),
    [bridge],
  )

  const refreshProject = useCallback(async (showLoading = true): Promise<void> => {
    if (bridge === null) return
    const generation = ++projectGenerationRef.current
    if (showLoading) setProjectLoading(true)
    setProjectLoadingMore(false)
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const nextState = await bridge.getProjectState()
        if (generation !== projectGenerationRef.current) return
        const stateDisposition = projectRefreshPairDisposition(
          nextState.dataRevision,
          nextState.dataRevision,
          projectRevisionFloorRef.current,
        )
        if (stateDisposition === 'reject') {
          setProjectLoadFailed(true)
          return
        }
        if (stateDisposition === 'retry') {
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 50))
            continue
          }
          setProjectLoadFailed(true)
          return
        }
        projectRevisionFloorRef.current = Math.max(projectRevisionFloorRef.current, nextState.dataRevision)

        let nextPage: ProjectTaskPage | null = null
        if (nextState.activeProjectId !== null) {
          nextPage = await bridge.getProjectTaskPage({
            projectId: nextState.activeProjectId,
            filter: projectTaskFilterRef.current,
            limit: PROJECT_TASK_PAGE_LIMIT,
          })
          if (generation !== projectGenerationRef.current) return
          const pairDisposition = projectRefreshPairDisposition(
            nextState.dataRevision,
            nextPage.dataRevision,
            projectRevisionFloorRef.current,
          )
          if (pairDisposition === 'reject') {
            setProjectLoadFailed(true)
            return
          }
          if (pairDisposition !== 'accept') {
            projectRevisionFloorRef.current = Math.max(
              projectRevisionFloorRef.current,
              nextState.dataRevision,
              nextPage.dataRevision,
            )
            if (attempt < 2) {
              await new Promise((resolve) => setTimeout(resolve, 50))
              continue
            }
            setProjectLoadFailed(true)
            return
          }
          projectRevisionFloorRef.current = Math.max(projectRevisionFloorRef.current, nextPage.dataRevision)
        }

        setProjectPublicState(nextState)
        setProjectTaskPage(nextPage)
        setProjectLoadFailed(false)
        return
      }
    } catch {
      if (generation === projectGenerationRef.current) setProjectLoadFailed(true)
    } finally {
      if (generation === projectGenerationRef.current) setProjectLoading(false)
    }
  }, [bridge])

  const loadMoreProjectTasks = useCallback(async (): Promise<void> => {
    if (bridge === null || projectLoading || projectLoadingMore || projectTaskPage?.nextCursor == null) return
    const projectId = projectPublicState?.activeProjectId
    if (projectId === null || projectId === undefined) return
    const requestGeneration = projectGenerationRef.current
    const requestRevision = projectTaskPage.dataRevision
    setProjectLoadingMore(true)
    try {
      const page = await bridge.getProjectTaskPage({
        projectId,
        filter: projectTaskFilterRef.current,
        cursor: projectTaskPage.nextCursor,
        limit: PROJECT_TASK_PAGE_LIMIT,
      })
      if (requestGeneration !== projectGenerationRef.current) return
      const disposition = projectTaskPageDisposition(
        page,
        requestRevision,
        projectRevisionFloorRef.current,
      )
      if (disposition === 'refresh') {
        projectRevisionFloorRef.current = Math.max(projectRevisionFloorRef.current, page.dataRevision)
        await refreshProject()
        return
      }
      if (disposition === 'accept') setProjectTaskPage((current) => appendProjectTaskPage(current, page))
    } catch {
      if (requestGeneration === projectGenerationRef.current) setProjectLoadFailed(true)
    } finally {
      if (requestGeneration === projectGenerationRef.current) setProjectLoadingMore(false)
    }
  }, [bridge, projectLoading, projectLoadingMore, projectPublicState?.activeProjectId, projectTaskPage, refreshProject])

  const adapter = useMemo(() => {
    if (bridge === null || baseAdapter === null) return null
    return {
      ...baseAdapter,
      selectProjectRoot: async (): Promise<void> => {
        await bridge.selectProjectRoot()
        await refreshProject()
      },
      activateProject: async (projectId: string): Promise<void> => {
        await bridge.activateProject(projectId)
        await refreshProject()
      },
      confirmProjectDirectories: async (projectId: string): Promise<void> => {
        await bridge.confirmProjectDirectories(projectId)
        await refreshProject()
      },
      cancelProjectPreparation: async (projectId: string): Promise<void> => {
        await bridge.cancelProjectPreparation(projectId)
        await refreshProject()
      },
      startProjectSync: async (projectId: string): Promise<void> => {
        await bridge.startProjectSync(projectId)
        await refreshProject()
      },
      cancelProjectSync: async (runId: string): Promise<void> => {
        await bridge.cancelProjectSync(runId)
        await refreshProject()
      },
      retryFailedProjectSync: async (projectId: string, runId: string | null): Promise<void> => {
        await bridge.retryProjectSync(projectId, runId)
        await refreshProject()
      },
      relocateProject: async (projectId: string): Promise<void> => {
        await bridge.selectProjectRoot(projectId)
        await refreshProject()
      },
      setProjectSyncPolicy: async (projectId: string, policy: ProjectSyncPolicy): Promise<void> => {
        await bridge.setProjectSyncPolicy(projectId, policy)
        await refreshProject()
      },
      setProjectTaskFilter: async (filter: ProjectTaskFilter): Promise<void> => {
        projectTaskFilterRef.current = filter
        setProjectTaskFilter(filter)
        setProjectTaskPage(null)
        await refreshProject()
      },
      loadMoreProjectTasks,
    }
  }, [baseAdapter, bridge, loadMoreProjectTasks, refreshProject])

  useEffect(() => {
    if (bridge === null) return undefined
    let active = true
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = (dataRevision: number): void => {
      if (!active) return
      projectPendingEventRevisionRef.current = Math.max(
        projectPendingEventRevisionRef.current ?? 0,
        dataRevision,
      )
      if (refreshTimer !== null) return
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        projectPendingEventRevisionRef.current = null
        if (active) void refreshProject(false)
      }, 500)
    }
    const unsubscribe = bridge.onProjectChanged((event) => {
      const currentProjectId = projectPublicState?.activeProjectId ?? null
      // Background projects may advance the catalog revision without changing
      // the currently rendered project. Refresh the catalog summary only when
      // no project is selected; otherwise keep the active project's progress
      // stable until its own event arrives.
      if (!projectEventAffectsActiveSelection(event.projectId, currentProjectId)) return
      const disposition = projectChangedEventDisposition(
        event,
        projectRevisionFloorRef.current,
        projectPendingEventRevisionRef.current,
      )
      if (disposition === 'reject') return
      projectRevisionFloorRef.current = Math.max(projectRevisionFloorRef.current, event.dataRevision)
      if (disposition === 'refresh') {
        // Fence an in-flight read immediately. The debounced replacement gets
        // its own generation, so an older progress snapshot cannot flash back.
        projectGenerationRef.current += 1
        scheduleRefresh(event.dataRevision)
      }
    })
    void refreshProject()
    return () => {
      active = false
      if (refreshTimer !== null) clearTimeout(refreshTimer)
      projectPendingEventRevisionRef.current = null
      projectGenerationRef.current += 1
      unsubscribe()
    }
  }, [bridge, projectPublicState?.activeProjectId, refreshProject])

  useEffect(() => {
    const activeProjectId = projectPublicState?.activeProjectId ?? null
    const activeProject = projectPublicState?.projects.find((project) => project.id === activeProjectId) ?? null
    const knownJob = simulationJobRef.current
    if (
      activeProject === null
      || knownJob === null
      || knownJob.projectId !== activeProject.id
      || knownJob.knowledgeVersion !== activeProject.knowledgeVersion
    ) {
      simulationGenerationRef.current += 1
      simulationJobRef.current = null
      simulationCursorHistoryRef.current = []
      setSimulationJob(null)
      setSimulationPage(null)
      setSimulationPageIndex(0)
      setSimulationBusy(false)
      setSimulationError(null)
    }
  }, [projectPublicState?.activeProjectId, projectPublicState?.projects])

  useEffect(() => {
    if (bridge === null) return undefined
    const projectId = projectPublicState?.activeProjectId ?? null
    const activeProject = projectPublicState?.projects.find((project) => project.id === projectId) ?? null
    if (activeProject === null || activeProject.knowledgeVersion === null) return undefined
    const requestGeneration = ++simulationGenerationRef.current
    let active = true
    setSimulationBusy(true)
    setSimulationError(null)
    void bridge.getLatestQaSimulationJob(activeProject.id).then((job) => {
      if (!active || requestGeneration !== simulationGenerationRef.current) return
      if (job === null || job.projectId !== activeProject.id || job.knowledgeVersion !== activeProject.knowledgeVersion) {
        simulationJobRef.current = null
        setSimulationJob(null)
        return
      }
      simulationJobRef.current = job
      setSimulationJob(job)
      if (job.state !== 'review_required') return
      return bridge.getQaSimulationPage({ projectId: job.projectId, jobId: job.id, expectedDataRevision: job.dataRevision, limit: 10 }).then((page) => {
        if (!active || requestGeneration !== simulationGenerationRef.current || !simulationPageMatchesJob(page, job)) return
        simulationCursorHistoryRef.current = []
        setSimulationPageIndex(0)
        setSimulationPage(page)
      })
    }).catch(() => {
      if (active && requestGeneration === simulationGenerationRef.current) setSimulationError('模拟问答任务暂时无法读取，已保存内容不受影响。')
    }).finally(() => {
      if (active && requestGeneration === simulationGenerationRef.current) setSimulationBusy(false)
    })
    return () => {
      active = false
      if (simulationGenerationRef.current === requestGeneration) simulationGenerationRef.current += 1
    }
  }, [bridge, projectPublicState?.activeProjectId, projectPublicState?.projects])

  useEffect(() => {
    if (bridge === null) return undefined
    let active = true
    const unsubscribe = bridge.onQaSimulationChanged((event) => {
      const knownJob = simulationJobRef.current
      if (!active || knownJob === null || !simulationEventMatchesJob(event, knownJob)) return
      const requestGeneration = simulationGenerationRef.current
      void bridge.getQaSimulationJob(event.projectId, event.jobId).then((job) => {
        const latestJob = simulationJobRef.current
        if (
          !active
          || requestGeneration !== simulationGenerationRef.current
          || latestJob === null
          || !simulationJobMeetsEvent(job, event)
          || !simulationJobCanReplace(latestJob, job)
        ) return
        simulationJobRef.current = job
        setSimulationJob(job)
        if (job.state !== 'review_required') {
          setSimulationPage(null)
          return
        }
        void bridge.getQaSimulationPage({
          projectId: job.projectId,
          jobId: job.id,
          expectedDataRevision: job.dataRevision,
          limit: 10,
        }).then((page) => {
          const latestPageJob = simulationJobRef.current
          if (
            !active
            || requestGeneration !== simulationGenerationRef.current
            || latestPageJob === null
            || latestPageJob.dataRevision !== job.dataRevision
            || !simulationPageMatchesJob(page, latestPageJob)
          ) return
          simulationCursorHistoryRef.current = []
          setSimulationPageIndex(0)
          setSimulationPage(page)
        }).catch(() => undefined)
      }).catch(() => undefined)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [bridge])

  useEffect(() => {
    if (bridge === null) return undefined

    let active = true
    let receivedLiveSnapshot = false
    let currentSnapshot: PublicSnapshot | null = null
    const commitSnapshot = (nextSnapshot: PublicSnapshot): void => {
      const previousSessionId = currentSnapshot?.app.sessionId ?? null
      const previousSource = currentSnapshot?.app.audioSource
      currentSnapshot = nextSnapshot
      if (
        previousSessionId !== nextSnapshot.app.sessionId
        || (previousSource !== undefined && previousSource !== nextSnapshot.app.audioSource)
      ) setAudioLevels([])
      setSnapshot(nextSnapshot)
    }
    const unsubscribe = bridge.onSnapshot((update) => {
      if (!active) return
      const nextSnapshot = mergeSnapshotUpdate(currentSnapshot, update)
      if (nextSnapshot === null) return
      receivedLiveSnapshot = true
      commitSnapshot(nextSnapshot)
      setBootstrapError(null)
    })
    const unsubscribeAudioLevel = bridge.onAudioLevel((sample) => {
      if (!active || currentSnapshot === null) return
      setAudioLevels((history) => appendAudioLevelSample(
        history,
        sample,
        currentSnapshot?.app.sessionId ?? null,
        currentSnapshot?.app.audioSource ?? 'system',
      ))
    })

    void bridge.getSnapshot()
      .then((initialSnapshot) => {
        if (active && !receivedLiveSnapshot) {
          commitSnapshot(initialSnapshot)
        }
      })
      .catch(() => {
        if (active && !receivedLiveSnapshot) {
          setBootstrapError('主进程未能返回状态。请重试；已有本地资料不受影响。')
        }
      })

    return () => {
      active = false
      unsubscribe()
      unsubscribeAudioLevel()
    }
  }, [bridge, loadAttempt])

  useEffect(() => {
    if (bridge === null) return undefined
    const activeProjectId = projectPublicState?.activeProjectId ?? null
    const generation = ++qaWorkspaceGenerationRef.current
    const projectChanged = qaWorkspaceProjectRef.current !== activeProjectId
    if (projectChanged) {
      qaWorkspaceProjectRef.current = activeProjectId
      qaWorkspaceRevisionFloorRef.current = 0
      qaWorkspaceReplaceOnRefreshRef.current = true
      setQaWorkspacePage(null)
      setQaWorkspaceError(null)
      setQaWorkspaceLoadingMore(false)
    }
    if (activeProjectId === null) {
      setQaWorkspaceLoading(false)
      return () => {
        if (qaWorkspaceGenerationRef.current === generation) qaWorkspaceGenerationRef.current += 1
      }
    }
    let active = true
    let refreshSequence = 0
    let scheduled = false
    let refreshing = false
    let refreshAgain = false

    const refreshFirstPage = async (): Promise<void> => {
      if (refreshing) {
        refreshAgain = true
        return
      }
      refreshing = true
      const sequence = ++refreshSequence
      let accepted = false
      let failed = false
      try {
        const page = await bridge.getQaWorkspacePage({ projectId: activeProjectId, limit: QA_WORKSPACE_PAGE_LIMIT })
        if (
          !active
          || sequence !== refreshSequence
          || !workspaceSelectionIsCurrent(
            activeProjectId,
            generation,
            qaWorkspaceProjectRef.current,
            qaWorkspaceGenerationRef.current,
          )
        ) return
        if (!workspacePageMatchesProject(page, activeProjectId)) return
        if (!workspacePageMeetsRevisionFloor(page, qaWorkspaceRevisionFloorRef.current)) return
        qaWorkspaceRevisionFloorRef.current = advanceWorkspaceRevisionFloor(
          qaWorkspaceRevisionFloorRef.current,
          page.dataRevision,
        )
        if (qaWorkspaceReplaceOnRefreshRef.current) {
          qaWorkspaceReplaceOnRefreshRef.current = false
          setQaWorkspacePage(page)
        } else {
          setQaWorkspacePage((current) => mergeWorkspaceRefresh(current, page))
        }
        setQaWorkspaceError(null)
        accepted = true
      } catch {
        failed = true
      } finally {
        refreshing = false
        if (active && generation === qaWorkspaceGenerationRef.current && sequence === refreshSequence) {
          if (refreshAgain) {
            refreshAgain = false
            void refreshFirstPage()
          } else {
            if (failed) {
              setQaWorkspaceError('会话轮次暂时无法读取，已保存答案不受影响。')
            } else if (!accepted) {
              setQaWorkspaceError('会话工作台正在等待最新版本，请重新加载。')
            }
            setQaWorkspaceLoading(false)
          }
        }
      }
    }

    const scheduleRefresh = (): void => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (active) void refreshFirstPage()
      })
    }

    const unsubscribe = bridge.onQaWorkspaceChanged((event) => {
      if (!workspaceEventAdvancesRevisionFloor(
        event,
        activeProjectId,
        qaWorkspaceRevisionFloorRef.current,
      )) return
      qaWorkspaceRevisionFloorRef.current = advanceWorkspaceRevisionFloor(
        qaWorkspaceRevisionFloorRef.current,
        event.dataRevision,
      )
      setQaWorkspaceLoading(true)
      setQaWorkspaceError(null)
      scheduleRefresh()
    })
    setQaWorkspaceLoading(true)
    setQaWorkspaceLoadingMore(false)
    void refreshFirstPage()

    return () => {
      active = false
      if (qaWorkspaceGenerationRef.current === generation) qaWorkspaceGenerationRef.current += 1
      refreshSequence += 1
      unsubscribe()
    }
  }, [bridge, projectPublicState?.activeProjectId, qaWorkspaceAttempt])

  const loadMoreQaWorkspace = (): void => {
    if (bridge === null || qaWorkspaceLoading || qaWorkspaceLoadingMore) return
    if (qaWorkspacePage === null) return
    const projectId = projectPublicState?.activeProjectId
    if (projectId === null || projectId === undefined || !workspacePageMatchesProject(qaWorkspacePage, projectId)) return
    const cursor = qaWorkspacePage.nextCursor
    if (cursor === null || cursor === undefined) return
    const generation = qaWorkspaceGenerationRef.current
    const requestRevisionFloor = qaWorkspaceRevisionFloorRef.current
    if (!workspaceCursorMatchesRevisionFloor(qaWorkspacePage, requestRevisionFloor)) {
      setQaWorkspaceLoading(true)
      setQaWorkspaceError(null)
      setQaWorkspaceAttempt((attempt) => attempt + 1)
      return
    }
    setQaWorkspaceLoadingMore(true)
    setQaWorkspaceError(null)
    void bridge.getQaWorkspacePage({ projectId, cursor, limit: QA_WORKSPACE_PAGE_LIMIT })
      .then((page) => {
        if (
          !workspaceSelectionIsCurrent(
            projectId,
            generation,
            qaWorkspaceProjectRef.current,
            qaWorkspaceGenerationRef.current,
          )
          || !workspacePageMatchesProject(page, projectId)
        ) return
        const disposition = workspaceLoadMoreDisposition(
          page,
          requestRevisionFloor,
          qaWorkspaceRevisionFloorRef.current,
        )
        if (disposition === 'reject') return
        if (disposition === 'refresh') {
          qaWorkspaceRevisionFloorRef.current = advanceWorkspaceRevisionFloor(
            qaWorkspaceRevisionFloorRef.current,
            page.dataRevision,
          )
          setQaWorkspaceLoading(true)
          setQaWorkspaceError(null)
          setQaWorkspaceAttempt((attempt) => attempt + 1)
          return
        }
        qaWorkspaceRevisionFloorRef.current = advanceWorkspaceRevisionFloor(
          qaWorkspaceRevisionFloorRef.current,
          page.dataRevision,
        )
        setQaWorkspacePage((current) => appendWorkspacePage(current, page))
      })
      .catch(() => {
        if (
          generation !== qaWorkspaceGenerationRef.current
          || requestRevisionFloor !== qaWorkspaceRevisionFloorRef.current
        ) return
        setQaWorkspaceError('更早轮次暂时无法加载，当前内容已保留。')
      })
      .finally(() => {
        if (generation === qaWorkspaceGenerationRef.current) setQaWorkspaceLoadingMore(false)
      })
  }

  const loadSimulationPage = useCallback(async (
    projectId: string,
    jobId: string,
    direction: 'previous' | 'next',
    cursor: string | null,
    expectedDataRevision: number,
  ): Promise<void> => {
    if (bridge === null || simulationBusy) return
    const current = simulationJobRef.current
    if (
      current === null
      || current.projectId !== projectId
      || current.id !== jobId
      || current.dataRevision !== expectedDataRevision
    ) return
    const transition = simulationCursorTransition(
      simulationCursorHistoryRef.current,
      direction,
      cursor,
    )
    if (transition === null) return
    const requestGeneration = simulationGenerationRef.current
    setSimulationBusy(true)
    setSimulationError(null)
    try {
      const input: QaSimulationPageInput = {
        projectId,
        jobId,
        expectedDataRevision,
        cursor: transition.requestCursor,
        limit: 10,
      }
      const page = await bridge.getQaSimulationPage(input)
      const latestJob = simulationJobRef.current
      if (
        requestGeneration !== simulationGenerationRef.current
        || latestJob === null
        || latestJob.dataRevision !== expectedDataRevision
        || !simulationPageMatchesJob(page, latestJob, expectedDataRevision)
      ) return
      simulationCursorHistoryRef.current = transition.nextStack
      setSimulationPageIndex(transition.nextStack.length)
      setSimulationPage(page)
    } catch {
      if (requestGeneration === simulationGenerationRef.current) setSimulationError('审阅页暂时无法读取，请重试。')
    } finally {
      if (requestGeneration === simulationGenerationRef.current) setSimulationBusy(false)
    }
  }, [bridge, simulationBusy])

  const simulatedQa = useMemo<SimulatedQaSlot | undefined>(() => {
    if (bridge === null) return undefined
    const commitJob = (job: QaSimulationJobSummary): void => {
      simulationGenerationRef.current += 1
      simulationJobRef.current = job
      simulationCursorHistoryRef.current = []
      setSimulationJob(job)
      setSimulationPage(null)
      setSimulationPageIndex(0)
      setSimulationError(null)
    }
    const mutate = async (operation: () => Promise<QaSimulationJobSummary>): Promise<void> => {
      setSimulationBusy(true)
      setSimulationError(null)
      try {
        const job = await operation()
        const current = simulationJobRef.current
        if (current !== null && (
          job.projectId !== current.projectId
          || job.id !== current.id
          || job.generation !== current.generation
          || job.knowledgeVersion !== current.knowledgeVersion
          || job.dataRevision < current.dataRevision
        )) return
        simulationJobRef.current = job
        setSimulationJob(job)
        if (job.state !== 'review_required') {
          setSimulationPage(null)
          return
        }
        const page = await bridge.getQaSimulationPage({
          projectId: job.projectId,
          jobId: job.id,
          expectedDataRevision: job.dataRevision,
          limit: 10,
        })
        const latestJob = simulationJobRef.current
        if (
          latestJob === null
          || latestJob.dataRevision !== job.dataRevision
          || !simulationPageMatchesJob(page, latestJob)
        ) return
        simulationCursorHistoryRef.current = []
        setSimulationPageIndex(0)
        setSimulationPage(page)
      } catch (error) {
        setSimulationError('操作未完成，当前已保存的问答不受影响。')
        throw error
      } finally {
        setSimulationBusy(false)
      }
    }
    return {
      job: simulationJob,
      page: simulationPage,
      pageIndex: simulationPageIndex,
      canPageBackward: simulationPageIndex > 0,
      busy: simulationBusy,
      error: simulationError,
      onPreflight: async (input) => {
        setSimulationError(null)
        return bridge.preflightQaSimulation(input)
      },
      onStart: async (input) => {
        setSimulationBusy(true)
        setSimulationError(null)
        try { commitJob(await bridge.startQaSimulation(input)) } catch (error) { setSimulationError('模拟问答任务未启动，请重试。'); throw error } finally { setSimulationBusy(false) }
      },
      onCancel: async (projectId, jobId) => mutate(() => bridge.cancelQaSimulation(projectId, jobId)),
      onResume: async (projectId, jobId) => mutate(() => bridge.resumeQaSimulation(projectId, jobId)),
      onPage: loadSimulationPage,
      onEdit: async (input) => mutate(() => bridge.updateQaSimulationItem(input)),
      onReview: async (input) => mutate(() => bridge.reviewQaSimulationItems(input)),
      onPublish: async (input) => mutate(() => bridge.publishQaSimulation(input)),
    }
  }, [bridge, loadSimulationPage, simulationBusy, simulationError, simulationJob, simulationPage, simulationPageIndex])

  const projectUiState = useMemo<ProjectUiState>(() => {
    const projects = projectPublicState?.projects ?? []
    const activeProjectId = projectPublicState?.activeProjectId ?? null
    return {
      projects,
      activeProjectId,
      activeProject: projects.find((project) => project.id === activeProjectId) ?? null,
      run: projectPublicState?.run ?? null,
      counts: projectPublicState?.counts ?? {
        added: 0,
        changed: 0,
        deleted: 0,
        awaitingAgent: 0,
        failed: 0,
        actionRequired: 0,
        completed: 0,
        total: null,
      },
      taskPage: projectTaskPage,
      taskFilter: projectTaskFilter,
      directoryConfirmation: projectPublicState?.directoryConfirmation ?? null,
      loading: projectLoading,
      loadingMore: projectLoadingMore,
      errorCode: projectLoadFailed ? 'LOAD_FAILED' : null,
    }
  }, [
    projectLoadFailed,
    projectLoading,
    projectLoadingMore,
    projectPublicState,
    projectTaskFilter,
    projectTaskPage,
  ])
  const activeWorkspaceProjectId = projectPublicState?.activeProjectId ?? null
  const qaWorkspaceSelectionPending = activeWorkspaceProjectId !== null
    && qaWorkspacePage?.projectId !== activeWorkspaceProjectId

  if (bridge === null || adapter === null) {
    return (
      <BootstrapScreen
        error="安全桥接未加载。请重新载入或重启 QAing；本地资料和已保存的凭据不会受到影响。"
        onRetry={() => window.location.reload()}
      />
    )
  }

  if (snapshot === null) {
    return (
      <BootstrapScreen
        error={bootstrapError}
        onRetry={() => {
          setBootstrapError(null)
          setLoadAttempt((attempt) => attempt + 1)
        }}
      />
    )
  }

  return (
    <App
      state={snapshot.app}
      environment={mapSnapshotToEnvironment(snapshot)}
      adapter={adapter}
      audioLevels={audioLevels}
      qaWorkspace={{
        page: qaWorkspacePage,
        loading: qaWorkspaceLoading || qaWorkspaceSelectionPending,
        loadingMore: qaWorkspaceLoadingMore,
        error: qaWorkspaceError,
      }}
      onLoadMoreQaWorkspace={loadMoreQaWorkspace}
      onRetryQaWorkspace={() => {
        qaWorkspaceGenerationRef.current += 1
        setQaWorkspaceError(null)
        setQaWorkspaceLoading(true)
        setQaWorkspaceLoadingMore(false)
        setQaWorkspaceAttempt((attempt) => attempt + 1)
      }}
      onDeleteQaWorkspaceRound={async (projectId, roundId) => {
        const generation = qaWorkspaceGenerationRef.current
        const result = await bridge.deleteQaWorkspaceRound(projectId, roundId)
        if (!workspaceRevisionIsValid(result.dataRevision)) throw new Error('INVALID_QA_WORKSPACE_REVISION')
        if (!workspaceSelectionIsCurrent(
          projectId,
          generation,
          qaWorkspaceProjectRef.current,
          qaWorkspaceGenerationRef.current,
        )) return
        const refreshRequired = workspaceMutationRequiresRefresh(
          result.dataRevision,
          qaWorkspaceRevisionFloorRef.current,
        )
        const resultMeetsFloor = result.dataRevision >= qaWorkspaceRevisionFloorRef.current
        qaWorkspaceRevisionFloorRef.current = advanceWorkspaceRevisionFloor(
          qaWorkspaceRevisionFloorRef.current,
          result.dataRevision,
        )
        if (resultMeetsFloor) {
          setQaWorkspacePage((current) => current?.projectId === projectId ? {
            ...current,
            items: current.items.filter((round) => round.id !== roundId),
            nextCursor: null,
            totalRounds: Math.max(0, current.totalRounds - (result.deleted ? 1 : 0)),
            dataRevision: Math.max(current.dataRevision, result.dataRevision),
          } : current)
        }
        if (refreshRequired) {
          qaWorkspaceReplaceOnRefreshRef.current = true
          setQaWorkspaceLoading(true)
          setQaWorkspaceError(null)
          setQaWorkspaceAttempt((attempt) => attempt + 1)
        }
      }}
      onClearQaWorkspaceProject={async (projectId) => {
        const generation = qaWorkspaceGenerationRef.current
        const result = await bridge.clearQaWorkspaceProject(projectId)
        if (!workspaceRevisionIsValid(result.dataRevision)) throw new Error('INVALID_QA_WORKSPACE_REVISION')
        if (!workspaceSelectionIsCurrent(
          projectId,
          generation,
          qaWorkspaceProjectRef.current,
          qaWorkspaceGenerationRef.current,
        )) return
        const refreshRequired = workspaceMutationRequiresRefresh(
          result.dataRevision,
          qaWorkspaceRevisionFloorRef.current,
        )
        const resultMeetsFloor = result.dataRevision >= qaWorkspaceRevisionFloorRef.current
        qaWorkspaceRevisionFloorRef.current = advanceWorkspaceRevisionFloor(
          qaWorkspaceRevisionFloorRef.current,
          result.dataRevision,
        )
        if (resultMeetsFloor) {
          setQaWorkspacePage({
            projectId,
            totalRounds: 0,
            items: [],
            nextCursor: null,
            dataRevision: result.dataRevision,
          })
        }
        if (refreshRequired) {
          qaWorkspaceReplaceOnRefreshRef.current = true
          setQaWorkspaceLoading(true)
          setQaWorkspaceError(null)
          setQaWorkspaceAttempt((attempt) => attempt + 1)
        }
      }}
      onExportQaWorkspaceProject={async (projectId) => {
        await bridge.exportQaWorkspaceProject(projectId)
      }}
      project={{ state: projectUiState }}
      {...(simulatedQa === undefined ? {} : { simulatedQa })}
    />
  )
}

const container = document.getElementById('root')
if (container === null) throw new Error('Renderer root element is missing')

createRoot(container).render(
  <StrictMode>
    <RendererRoot />
  </StrictMode>,
)
