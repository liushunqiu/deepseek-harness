import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { WorkerSettlementTracker, workerSettlementTracker } from '../src/worker-settlement.ts'
import { fakeAgent } from './harness.ts'

function epoch(childId = 'child', runId = 'epoch-1'): SubagentRunInfo {
  return { id: SessionId(childId), runId: SubagentRunId(runId), provider: 'spawn', local: true }
}

function completed(info: SubagentRunInfo): SubagentRunEndInfo {
  return { ...info, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'evidence' }] }
}

function delivery(agent: Agent, childId: string): ToolExecution {
  return {
    agent,
    name: 'send_message',
    arguments: { agent_id: childId, message: 'follow up' },
    callId: ToolCallId('send'),
    rootCallId: ToolCallId('send'),
    token: Symbol('delivery') as ToolExecutionToken,
    signal: new AbortController().signal,
  }
}

describe('WorkerSettlementTracker', () => {
  it('binds the selected Worker and waits for every Worker to finish', () => {
    const tracker = new WorkerSettlementTracker()
    const owner = fakeAgent('owner')
    const first = tracker.start(owner, 'first task')
    const second = tracker.start(owner, 'second task')
    first.publish(SessionId('first'), false)
    second.publish(SessionId('second'), false)
    first.settle(true)
    expect(() => tracker.startReview(owner, 'first')).toThrow('Worker is running')
    second.settle(false)
    second.settle(true)
    expect(() => tracker.startReview(owner)).toThrow('worker_id')
    expect(() => tracker.startReview(owner, 'second')).toThrow('latest run')
    tracker.startReview(owner, 'first').failStart()
    expect(() => tracker.startReview(owner, 'absent')).toThrow('worker_id')
  })

  it('keeps parents isolated and excludes failed anonymous startups', () => {
    const tracker = new WorkerSettlementTracker()
    const alice = fakeAgent('alice')
    const bob = fakeAgent('bob')
    const failed = tracker.start(alice)
    failed.failStart()
    failed.failStart()
    failed.settle(true)
    const bobWorker = tracker.start(bob)
    bobWorker.publish(SessionId('bob-child'), false)
    bobWorker.settle(true)
    tracker.startReview(bob).failStart()
    expect(() => tracker.startReview(alice, 'bob-child')).toThrow('Start a Worker first')
  })

  it('accepts a background job id as a concrete Worker reference', () => {
    const tracker = new WorkerSettlementTracker()
    const owner = fakeAgent()
    const worker = tracker.start(owner)
    worker.associateJob(JobId('worker-job'))
    worker.publish(SessionId('worker-session'), false)
    worker.settle(true)
    tracker.startReview(owner, 'worker-job').failStart()
    tracker.startReview(owner, 'worker-session').failStart()
  })

  it.each(['error', 'aborted', 'refusal', 'max-tokens'] as const)('rejects a continuable %s outcome with partial text', (stopReason) => {
    const tracker = new WorkerSettlementTracker()
    const owner = fakeAgent()
    tracker.start(owner).publish(SessionId('child'), true)
    tracker.observeStart(epoch())
    tracker.observeEnd({ ...completed(epoch()), stopReason })
    expect(() => tracker.startReview(owner)).toThrow('latest run')
  })

  it.each([undefined, [], [{ type: 'text' as const, text: ' \n ' }]])('rejects completed epochs without nonblank text: %j', (lastAssistantMessage) => {
    const tracker = new WorkerSettlementTracker()
    const owner = fakeAgent()
    tracker.start(owner).publish(SessionId('child'), true)
    tracker.observeStart(epoch())
    tracker.observeEnd({ ...epoch(), stopReason: 'completed', ...lastAssistantMessage === undefined ? {} : { lastAssistantMessage } })
    expect(() => tracker.startReview(owner)).toThrow('latest run')
  })

  it('captures an epoch that completes before the start tool returns', () => {
    const tracker = new WorkerSettlementTracker()
    const owner = fakeAgent()
    const worker = tracker.start(owner)
    tracker.observeStart(epoch())
    tracker.observeEnd(completed(epoch()))
    worker.publish(SessionId('child'), true)
    worker.publish(SessionId('ignored'), true)
    tracker.startReview(owner).failStart()
  })

  it('invalidates old success at the next epoch and ignores an old terminal event', () => {
    const tracker = new WorkerSettlementTracker()
    const owner = fakeAgent()
    tracker.start(owner).publish(SessionId('child'), true)
    tracker.observeStart(epoch())
    tracker.observeEnd(completed(epoch()))
    tracker.startReview(owner).failStart()
    const latest = epoch('child', 'epoch-2')
    tracker.observeStart(latest)
    tracker.observeStart(latest)
    tracker.observeEnd(completed(epoch()))
    expect(() => tracker.startReview(owner)).toThrow('latest run')
    tracker.observeEnd(completed(latest))
    tracker.startReview(owner).failStart()
  })

  it('holds delivery admission before an epoch starts and restores failed delivery', () => {
    const tracker = new WorkerSettlementTracker()
    const owner = fakeAgent()
    tracker.start(owner).publish(SessionId('child'), true)
    tracker.observeStart(epoch())
    tracker.observeEnd(completed(epoch()))
    const execution = delivery(owner, 'child')
    const release = tracker.beginFollowup(execution)!
    expect(tracker.beginFollowup(execution)).toBeUndefined()
    expect(() => tracker.startReview(owner)).toThrow('receiving a follow-up')
    release()
    release()
    tracker.startReview(owner).failStart()
  })

  it('revalidates Reviewer follow-ups against the same Worker after repairs', () => {
    const tracker = new WorkerSettlementTracker()
    const owner = fakeAgent()
    tracker.start(owner).publish(SessionId('child'), true)
    tracker.observeStart(epoch())
    tracker.observeEnd(completed(epoch()))
    const reviewer = tracker.startReview(owner)
    reviewer.publish(SessionId('reviewer'), true)
    const reviewEpoch = epoch('reviewer', 'review-1')
    tracker.observeStart(reviewEpoch)
    expect(() => tracker.start(owner)).toThrow('Reviewer is running')
    expect(tracker.followupDenial(delivery(owner, 'child'))).toContain('Reviewer is running')
    tracker.observeEnd(completed(reviewEpoch))
    const repairEpoch = epoch('child', 'repair')
    tracker.observeStart(repairEpoch)
    expect(tracker.followupDenial(delivery(owner, 'reviewer'))).toContain('latest run')
    expect(() => tracker.beginFollowup(delivery(owner, 'reviewer'))).toThrow('latest run')
    tracker.observeEnd(completed(repairEpoch))
    const release = tracker.beginFollowup(delivery(owner, 'reviewer'))!
    expect(() => tracker.start(owner)).toThrow('Reviewer is running')
    release()
    tracker.start(owner).failStart()
  })

  it('does not treat unrelated controls, malformed tool JSON, or another parent as tracked delivery', () => {
    const tracker = new WorkerSettlementTracker()
    const owner = fakeAgent()
    tracker.start(owner).publish(SessionId('child'), true)
    const execution = delivery(owner, 'child')
    for (const unrelated of [
      { ...execution, name: 'read' },
      { ...execution, agent: fakeAgent('other-parent') },
      { ...execution, arguments: null },
      { ...execution, arguments: {} },
      { ...execution, arguments: { agent_id: 12 } },
      delivery(owner, 'unknown'),
    ]) {
      expect(tracker.followupDenial(unrelated)).toBeUndefined()
      expect(tracker.beginFollowup(unrelated)).toBeUndefined()
    }
  })

  it('forgets a disposed parent without releasing another parent or reviving late publication', () => {
    const tracker = new WorkerSettlementTracker()
    const alice = fakeAgent('alice')
    const bob = fakeAgent('bob')
    const late = tracker.start(alice)
    tracker.start(bob).publish(SessionId('bob-child'), true)
    tracker.dispose(alice)
    late.publish(SessionId('late-child'), true)
    late.settle(true)
    tracker.observeStart(epoch('bob-child'))
    tracker.observeEnd(completed(epoch('bob-child')))
    tracker.startReview(bob).failStart()
    tracker.dispose(bob)
    expect(() => tracker.startReview(alice)).toThrow('Start a Worker first')
    expect(() => tracker.startReview(bob)).toThrow('Start a Worker first')
  })

  it('shares effect-owned listeners across repeated reads in one context', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const first = workerSettlementTracker(ctx)
      expect(workerSettlementTracker(ctx)).toBe(first)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
