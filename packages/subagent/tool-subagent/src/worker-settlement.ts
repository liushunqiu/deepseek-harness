/**
 * Live-parent Reviewer admission over named Workers and their latest results.
 * Continuable epochs follow service lifecycle events; one-shot runs remain
 * pending through disposal. Successful text is evidence to review, not proof
 * that the delegated task is correct.
 * @module @deepseek-ai/dsh-tool-subagent/worker-settlement
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'

/** Reservation held from delegation admission through publication and settlement. */
export interface WorkerSettlement {
  /** Release an unsuccessful startup without retaining an anonymous Worker. */
  failStart(): void
  /**
   * Bind the reservation to its published child.
   * @param childId - durable child session id, not the lifecycle run id.
   * @param continuable - whether service epoch events own settlement.
   */
  publish(childId: SessionId, continuable: boolean): void
  /**
   * Record the job id accepted as an alternative Worker reference.
   * @param jobId - parent-visible background job id.
   */
  associateJob(jobId: JobId): void
  /**
   * Finish a one-shot run after resource disposal; repeated calls are ignored.
   * @param hasResult - whether completion and disposal succeeded with nonblank final text.
   */
  settle(hasResult: boolean): void
}

interface ChildState {
  readonly parent: Agent
  readonly label: string
  readonly worker: ChildState | undefined
  childId?: SessionId
  jobId?: JobId
  continuable: boolean
  running: boolean
  deliveries: number
  hasResult: boolean
  epoch?: SubagentRunInfo
}

type ObservedEpoch = SubagentRunInfo | SubagentRunEndInfo

/** Tool-row-shared accounting; disposed parents cannot authorize a later review. */
export class WorkerSettlementTracker {
  private readonly parents = new WeakMap<Agent, Set<ChildState>>()
  private readonly children = new Map<SessionId, ChildState>()
  private readonly unpublished = new Set<ChildState>()
  private readonly observed = new Map<SessionId, ObservedEpoch>()
  private readonly deliveries = new Set<ToolExecutionToken>()

  /**
   * Reserve a Worker synchronously, rejecting overlap with an active Reviewer.
   * @param parent - exact live parent Agent.
   * @param label - task description used to disambiguate Worker references.
   * @returns the reservation owned by this tool call.
   */
  start(parent: Agent, label = 'Worker'): WorkerSettlement {
    this.assertNoReviewer(parent)
    return this.reserve(parent, label)
  }

  /**
   * Bind a Reviewer to one Worker's latest successful result and reserve it.
   * @param parent - exact live parent Agent.
   * @param reference - model-supplied child or job id; omission requires exactly one Worker.
   * @returns the reservation blocking Worker mutations until this Reviewer settles.
   */
  startReview(parent: Agent, reference?: string): WorkerSettlement {
    const workers = [...this.parents.get(parent) ?? []].filter(child => child.worker === undefined)
    const worker = reference === undefined
      ? workers.length === 1 ? workers[0] : undefined
      : workers.find(child => child.childId === reference || child.jobId === reference)
    if (worker === undefined) {
      const choices = workers.map(child => `${child.childId ?? child.jobId ?? '(starting)'} (${child.label})`).join(', ')
      throw new Error(`Reviewer requires worker_id identifying one Worker started by this parent.${choices ? ` Workers: ${choices}` : ' Start a Worker first.'}`)
    }
    this.assertReviewable(worker)
    return this.reserve(parent, 'Reviewer', worker)
  }

  /**
   * Observe the newest residency epoch, including publication racing tool return.
   * @param info - service-owned child and run identities.
   */
  observeStart(info: SubagentRunInfo): void {
    const child = this.children.get(info.id)
    if (child?.continuable) {
      if (child.epoch?.runId === info.runId) return
      child.epoch = info
      child.running = true
      child.hasResult = false
    } else if (child === undefined && this.unpublished.size > 0) {
      this.observed.set(info.id, info)
    }
  }

  /**
   * Accept only the current epoch's normal completion with nonblank final text.
   * @param info - terminal service facts, not a child status notification.
   */
  observeEnd(info: SubagentRunEndInfo): void {
    const child = this.children.get(info.id)
    if (child?.continuable && child.epoch?.runId === info.runId) {
      child.running = false
      child.hasResult = info.stopReason === 'completed'
        && info.lastAssistantMessage?.some(block => block.type === 'text' && block.text.trim().length > 0) === true
    } else if (child === undefined && this.observed.get(info.id)?.runId === info.runId) {
      this.observed.set(info.id, info)
    }
  }

  /**
   * Check tracked follow-up admission without changing accounting.
   * @param exec - registry-validated tool execution identity and JSON arguments.
   * @returns denial text, or undefined for an admitted or unrelated call.
   */
  followupDenial(exec: ToolExecution): string | undefined {
    const child = this.followupChild(exec)
    if (child === undefined) return undefined
    try {
      if (child.worker === undefined) this.assertNoReviewer(child.parent)
      else this.assertReviewable(child.worker)
      return undefined
    } catch (error) {
      return (error as Error).message
    }
  }

  /**
   * Hold follow-up admission until delivery settles, including failed delivery.
   * @param exec - around-dispatch execution; sibling tool rows share its token.
   * @returns release function, or undefined for an unrelated/already-wrapped call.
   */
  beginFollowup(exec: ToolExecution): (() => void) | undefined {
    if (this.deliveries.has(exec.token)) return undefined
    const child = this.followupChild(exec)
    if (child === undefined) return undefined
    const denial = this.followupDenial(exec)
    if (denial !== undefined) throw new Error(denial)
    child.deliveries += 1
    this.deliveries.add(exec.token)
    return () => {
      if (!this.deliveries.delete(exec.token)) return
      child.deliveries -= 1
    }
  }

  /**
   * Remove live admission facts and pending publication buffers for a parent.
   * @param parent - disposed Agent.
   */
  dispose(parent: Agent): void {
    for (const child of this.parents.get(parent) ?? []) {
      if (child.childId !== undefined) this.children.delete(child.childId)
      this.unpublished.delete(child)
    }
    this.parents.delete(parent)
    this.pruneObserved()
  }

  private followupChild(exec: ToolExecution): ChildState | undefined {
    if (exec.name !== 'send_message' || exec.agent === undefined) return undefined
    const args = exec.arguments
    if (typeof args !== 'object' || args === null || !('agent_id' in args) || typeof args.agent_id !== 'string') return undefined
    const child = this.children.get(SessionId(args.agent_id))
    return child?.parent === exec.agent ? child : undefined
  }

  private assertReviewable(worker: ChildState): void {
    const siblings = this.parents.get(worker.parent)
    if (siblings === undefined || !worker.hasResult) {
      throw new Error('Reviewer requires the selected Worker\'s latest run to complete successfully with nonblank final text')
    }
    if ([...siblings].some(child => child.worker === undefined && (child.running || child.deliveries > 0))) {
      throw new Error('Reviewer cannot start while a Worker is running or receiving a follow-up')
    }
  }

  private assertNoReviewer(parent: Agent): void {
    if ([...this.parents.get(parent) ?? []].some(child => child.worker !== undefined && (child.running || child.deliveries > 0))) {
      throw new Error('Worker cannot start or receive a follow-up while a Reviewer is running')
    }
  }

  private reserve(parent: Agent, label: string, worker?: ChildState): WorkerSettlement {
    let siblings = this.parents.get(parent)
    if (siblings === undefined) {
      siblings = new Set()
      this.parents.set(parent, siblings)
    }
    const child: ChildState = { parent, label, worker, continuable: false, running: true, deliveries: 0, hasResult: false }
    siblings.add(child)
    this.unpublished.add(child)
    let settled = false
    return {
      failStart: () => {
        if (settled) return
        settled = true
        child.running = false
        child.hasResult = false
        if (child.childId === undefined && child.jobId === undefined) siblings.delete(child)
        this.unpublished.delete(child)
        this.pruneObserved()
      },
      associateJob: (jobId) => { child.jobId = jobId },
      publish: (childId, continuable) => {
        if (!this.unpublished.delete(child)) return
        child.childId = childId
        child.continuable = continuable
        this.children.set(childId, child)
        const epoch = this.observed.get(childId)
        if (continuable && epoch !== undefined) {
          this.observeStart(epoch)
          if ('stopReason' in epoch) this.observeEnd(epoch)
        }
        this.observed.delete(childId)
        this.pruneObserved()
      },
      settle: (hasResult) => {
        if (settled) return
        settled = true
        child.running = false
        child.hasResult = hasResult
        this.unpublished.delete(child)
        this.pruneObserved()
      },
    }
  }

  private pruneObserved(): void {
    if (this.unpublished.size === 0) this.observed.clear()
  }
}

const trackers = new WeakMap<object, WorkerSettlementTracker>()
const attachedContexts = new WeakSet<Context>()

/**
 * Share accounting by the original subagent service identity and install scoped,
 * effect-owned lifecycle and tool-execution listeners.
 * @param ctx - tool row's scope, receiving its parent's lifecycle and tool events.
 * @returns the service's live-parent admission tracker.
 */
export function workerSettlementTracker(ctx: Context): WorkerSettlementTracker {
  const subagents = ctx.get('subagents') as {
    readonly typertRemote?: { readonly service?: object }
  } | undefined
  const owner = subagents?.typertRemote?.service ?? subagents ?? ctx
  let tracker = trackers.get(owner)
  if (tracker === undefined) {
    tracker = new WorkerSettlementTracker()
    trackers.set(owner, tracker)
  }
  if (!attachedContexts.has(ctx)) {
    ctx.effect(() => {
      attachedContexts.add(ctx)
      return () => { attachedContexts.delete(ctx) }
    })
    ctx.on('subagent/start', (info) => { tracker.observeStart(info) })
    ctx.on('subagent/end', (info) => { tracker.observeEnd(info) })
    ctx.on('agent/disposed', ({ agent }) => { tracker.dispose(agent) })
    ctx.tools.guard(exec => tracker.followupDenial(exec))
    ctx.on('tools/execute', async (exec, next) => {
      const release = tracker.beginFollowup(exec)
      try {
        return await next()
      } finally {
        release?.()
      }
    })
  }
  return tracker
}
