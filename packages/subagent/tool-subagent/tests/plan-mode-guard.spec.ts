/** Plan-mode read-only enforcement of the delegation tool. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { z } from 'zod'
import * as tool from '../src/index.ts'
import * as mock from './scripted-provider.ts'
import {
  isPlanModeActive,
  planModeToolFilter,
  PLAN_MODE_DENY_NAMES,
  PLAN_MODE_DYNAMIC_DENY_NAMES,
  PLAN_MODE_TOOL_FILTER_ERROR,
} from '../src/plan-mode-guard.ts'

const testSignal = new AbortController().signal
let callCounter = 0

/** A stripped-in plan projection that folds only `plan/mode` (the real one is
 * owned by @deepseek-ai/dsh-plan-mode; this bench keeps the dependency out). */
interface PlanModeEvent {
  type: string
  data?: { active?: unknown }
}

/** A stripped-in plan projection folding only `plan/mode` (typed structurally
 * to avoid pulling @deepseek-ai/dsh-plan-mode into this bench). */
function registerMinimalPlanProjection(ctx: Context): void {
  const definition = {
    key: 'plan' as const,
    stateVersion: 1,
    stateSchema: z.object({ active: z.boolean() }),
    init: () => ({ active: false }),
    apply: (state: { active: boolean }, event: PlanModeEvent) => event.type === 'plan/mode'
      ? { active: event.data?.active === true }
      : state,
  }
  ctx.sessionProjections.register(definition as never)
}

/** An agent with a real context so `agent.ctx.get('sessionProjections')` resolves. */
function scopedAgent(ctx: Context, id = 'plan-parent'): Agent & { session: Session } {
  const scope = createScope(ctx, { name: `plan-guard-${id}` })
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session, options: {}, ctx: scope.ctx } as unknown as Agent & { session: Session }
}

function registerTestTool(ctx: Context, name: string): void {
  const tools = ctx.get('tools') as ToolRuntime
  tools.register(defineTool({
    name,
    description: 'test tool',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [],
    },
    execute: () => Promise.resolve({}),
  }))
}

/** Boot a real in-process child so plan restrictions are tested at execution. */
async function realChildBench(attemptedTool: string): Promise<{
  ctx: Context
  parent: Agent & { session: Session }
  adapter: MockAdapter
  getChild: () => Agent | undefined
  getChildNames: () => string[] | undefined
}> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  registerMinimalPlanProjection(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  for (const name of PLAN_MODE_DENY_NAMES.filter(name => name !== 'read_image' && name !== 'dev_tool_search')) registerTestTool(ctx, name)
  for (const name of PLAN_MODE_DYNAMIC_DENY_NAMES) registerTestTool(ctx, name)
  registerTestTool(ctx, 'cordis_inspect_list')
  const adapter = new MockAdapter([
    toolCallResponse('c1', attemptedTool, {}),
    textResponse('done'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(tool, { provider: 'spawn', maxDepth: 2 })
  const parent = await ctx.agentLoop.create(SessionId('real-plan-parent'), { provider: 'mock', model: 'mock' })
  let child: Agent | undefined
  let childNames: string[] | undefined
  ctx.on('subagent/start', (info) => {
    if (info.provider === 'spawn') {
      child = ctx.agents.get(info.id)
      if (child !== undefined) childNames = ctx.tools.schemas(child).map(schema => schema.name)
    }
  })
  setPlanMode(ctx, parent, true)
  return { ctx, parent, adapter, getChild: () => child, getChildNames: () => childNames }
}

async function bench(options: { dynamicTools?: readonly string[] } = {}): Promise<{ ctx: Context; agent: Agent & { session: Session } }> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  registerMinimalPlanProjection(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const name of PLAN_MODE_DENY_NAMES) registerTestTool(ctx, name)
  for (const name of options.dynamicTools ?? []) registerTestTool(ctx, name)
  await ctx.plugin(SubagentRuntime)
  await mock.mountScriptedProvider(ctx, { name: 'mock', reply: 'ok' })
  await ctx.plugin(tool, { provider: 'mock', maxDepth: 2 })
  return { ctx, agent: scopedAgent(ctx) }
}

/** Append one plan/mode event and drive it into the projection synchronously. */
function setPlanMode(ctx: Context, agent: Agent & { session: Session }, active: boolean): void {
  const event = agent.session.append('plan/mode', { active })
  ctx.emit('session/event', agent.session, event)
}

function call(ctx: Context, agent: Agent & { session: Session }, args: Record<string, unknown> = {}) {
  callCounter += 1
  return ctx.tools.execute({
    signal: testSignal,
    callId: ToolCallId(`plan-guard-${callCounter}`),
    name: 'subagent',
    arguments: { description: 'd', prompt: 'p', run_in_background: false, ...args },
    agent,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('dsh-tool-subagent plan-mode guard', () => {
  it('treats missing agent context or plan projection as inactive', () => {
    expect(isPlanModeActive(undefined)).toBe(false)
    expect(isPlanModeActive({} as Agent)).toBe(false)
    expect(isPlanModeActive(scopedAgent(new Context(), 'no-plan-service'))).toBe(false)
  })

  it('keeps an explicit allow list and filters the fixed mask to available names', () => {
    const filtered = planModeToolFilter({ allow: ['read'], deny: ['custom'] }, ['write', 'workflow'])
    expect(filtered.allow).toEqual(['read'])
    expect(filtered.deny).toEqual(['custom', 'write', 'workflow'])
    const unbounded = planModeToolFilter(undefined)
    expect(unbounded.deny).toEqual([...PLAN_MODE_DENY_NAMES, ...PLAN_MODE_DYNAMIC_DENY_NAMES])
  })

  it('lets a non-plan session delegate unmasked (no plan projection -> unrestricted)', async () => {
    const { ctx, agent } = await bench()
    const seen: ResolvedSubagentStartRequest[] = []
    const provider = ctx.subagents.getProvider('mock')!
    const originalStart = provider.start.bind(provider)
    provider.start = (async (request: ResolvedSubagentStartRequest) => {
      seen.push(request)
      return originalStart(request)
    })

    const result = await call(ctx, agent)
    expect(result.isError).toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.toolFilter).toBeUndefined()
    expect(seen[0]!.maxDepth).toBe(2)
    provider.start = originalStart
  })

  it('forces a read-only tool filter and a depth cap while plan mode is active', async () => {
    const { ctx, agent } = await bench()
    setPlanMode(ctx, agent, true)
    const seen: ResolvedSubagentStartRequest[] = []
    const provider = ctx.subagents.getProvider('mock')!
    const originalStart = provider.start.bind(provider)
    provider.start = (async (request: ResolvedSubagentStartRequest) => {
      seen.push(request)
      return originalStart(request)
    })

    const result = await call(ctx, agent)
    expect(result.isError).toBe(false)
    const request = seen[0]!
    expect(request.toolFilter?.deny).toEqual(expect.arrayContaining([...PLAN_MODE_DENY_NAMES]))
    // Parent depth 0 -> child depth 1 is the plan-mode cap; the configured cap 2 is wider.
    expect(request.maxDepth).toBe(1)
    provider.start = originalStart
  })

  it('denies optional orchestration tools only when the deployment exposes them', async () => {
    const { ctx, agent } = await bench({ dynamicTools: [...PLAN_MODE_DYNAMIC_DENY_NAMES, 'cordis_inspect_list'] })
    setPlanMode(ctx, agent, true)
    const seen: ResolvedSubagentStartRequest[] = []
    const provider = ctx.subagents.getProvider('mock')!
    const originalStart = provider.start.bind(provider)
    provider.start = (async (request: ResolvedSubagentStartRequest) => {
      seen.push(request)
      return originalStart(request)
    })

    const result = await call(ctx, agent)
    expect(result.isError).toBe(false)
    expect(seen[0]!.toolFilter?.deny).toEqual(expect.arrayContaining([...PLAN_MODE_DENY_NAMES, ...PLAN_MODE_DYNAMIC_DENY_NAMES]))
    expect(seen[0]!.toolFilter?.deny).not.toContain('cordis_inspect_list')
    provider.start = originalStart
  })

  it('does not name an optional tool registered only in the parent Agent scope', async () => {
    const { ctx, agent } = await bench()
    registerTestTool(agent.ctx, 'workflow')
    setPlanMode(ctx, agent, true)
    const seen: ResolvedSubagentStartRequest[] = []
    const provider = ctx.subagents.getProvider('mock')!
    const originalStart = provider.start.bind(provider)
    provider.start = (async (request: ResolvedSubagentStartRequest) => {
      seen.push(request)
      return originalStart(request)
    })

    const result = await call(ctx, agent)
    expect(result.isError).toBe(false)
    expect(seen[0]!.toolFilter?.deny).not.toContain('workflow')
    provider.start = originalStart
  })

  it('names an optional tool inherited from the parent preset scope', async () => {
    const { ctx, agent } = await bench()
    const preset = createScope(ctx, { name: 'plan-preset' })
    registerTestTool(preset.ctx, 'workflow')
    const parentScope = scopeOf(preset.ctx)
    if (parentScope === undefined) throw new Error('preset scope was not created')
    const childScope = createScope(ctx, { name: 'plan-inherited-parent' }, { parent: parentScope })
    const inheritedAgent = {
      ...agent,
      ctx: childScope.ctx,
      id: SessionId('plan-inherited-parent'),
      session: Session.create(SessionId('plan-inherited-parent')),
    } as unknown as Agent & { session: Session }
    setPlanMode(ctx, inheritedAgent, true)
    const seen: ResolvedSubagentStartRequest[] = []
    const provider = ctx.subagents.getProvider('mock')!
    const originalStart = provider.start.bind(provider)
    provider.start = (async (request: ResolvedSubagentStartRequest) => {
      seen.push(request)
      return originalStart(request)
    })

    const result = await call(ctx, inheritedAgent)
    expect(result.isError).toBe(false)
    expect(seen[0]!.toolFilter?.deny).toContain('workflow')
    provider.start = originalStart
  })

  it.each([...PLAN_MODE_DYNAMIC_DENY_NAMES])(
    'enforces the plan-mode dynamic deny at the real child schema and execution layers: %s',
    async (attemptedTool) => {
      const { ctx, parent, adapter, getChild, getChildNames } = await realChildBench(attemptedTool)
      expect(adapter.requests).toHaveLength(0)
      expect(isPlanModeActive(parent)).toBe(true)
      const result = await ctx.tools.execute({
        signal: testSignal,
        callId: ToolCallId(`plan-real-${attemptedTool}`),
        name: 'subagent',
        arguments: { description: 'd', prompt: 'p', run_in_background: false },
        agent: parent,
      })
      expect(result.isError).toBe(false)
      const child = getChild()
      expect(child).toBeDefined()
      if (child === undefined) throw new Error('real child was not published')
      const childNames = getChildNames()
      expect(childNames).toBeDefined()
      if (childNames === undefined) throw new Error('child schema was not captured at publication')
      expect(childNames).not.toContain(attemptedTool)
      expect(childNames).not.toContain('workflow')
      expect(childNames).not.toContain('ralph')
      expect(childNames).toContain('cordis_inspect_list')
      expect((adapter.requests[0]?.tools ?? []).map(schema => schema.name)).not.toContain(attemptedTool)
      const toolResult = child.session.snapshotEvents().find(event => event.type === 'tool/result')
      expect(JSON.stringify(toolResult?.data)).toContain('unknown tool')
    },
  )

  it('honors an explicit stricter maxDepth (0 = forbid delegation) over the plan-mode cap', async () => {
    const { ctx } = await bench()
    const agent = scopedAgent(ctx, 'plan-strict')
    setPlanMode(ctx, agent, true)
    // Re-mount a stricter instance for this bench (distinct toolName).
    await mock.mountScriptedProvider(ctx, { name: 'mock-strict', reply: 'ok' })
    await ctx.plugin(tool, { provider: 'mock-strict', toolName: 'subagent_strict', maxDepth: 0 })
    const seen: ResolvedSubagentStartRequest[] = []
    const provider = ctx.subagents.getProvider('mock-strict')!
    const originalStart = provider.start.bind(provider)
    provider.start = (async (request: ResolvedSubagentStartRequest) => {
      seen.push(request)
      return originalStart(request)
    })

    const result = await ctx.tools.execute({
      signal: testSignal,
      callId: ToolCallId('plan-guard-strict'),
      name: 'subagent_strict',
      arguments: { description: 'd', prompt: 'p', run_in_background: false },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(seen[0]!.maxDepth).toBe(0)
    provider.start = originalStart
  })

  it('merges a configured deny mask with the plan-mode mask', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    registerMinimalPlanProjection(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    for (const name of PLAN_MODE_DENY_NAMES) registerTestTool(ctx, name)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'mock-merged', reply: 'ok' })
    await ctx.plugin(tool, {
      provider: 'mock-merged',
      toolName: 'subagent_merged',
      maxDepth: 'provider-managed',
      toolFilter: { deny: ['custom-denied'] },
    })
    const agent = scopedAgent(ctx, 'plan-merged')
    setPlanMode(ctx, agent, true)
    const seen: ResolvedSubagentStartRequest[] = []
    const provider = ctx.subagents.getProvider('mock-merged')!
    const originalStart = provider.start.bind(provider)
    provider.start = (async (request: ResolvedSubagentStartRequest) => {
      seen.push(request)
      return originalStart(request)
    })

    const result = await ctx.tools.execute({
      signal: testSignal,
      callId: ToolCallId('plan-guard-merged'),
      name: 'subagent_merged',
      arguments: { description: 'd', prompt: 'p', run_in_background: false },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(seen[0]!.toolFilter?.deny).toEqual(expect.arrayContaining(['custom-denied', ...PLAN_MODE_DENY_NAMES]))
    provider.start = originalStart
  })

  it('lifts the mask when plan mode turns off', async () => {
    const { ctx, agent } = await bench()
    setPlanMode(ctx, agent, true)
    setPlanMode(ctx, agent, false)
    const seen: ResolvedSubagentStartRequest[] = []
    const provider = ctx.subagents.getProvider('mock')!
    const originalStart = provider.start.bind(provider)
    provider.start = (async (request: ResolvedSubagentStartRequest) => {
      seen.push(request)
      return originalStart(request)
    })

    const result = await call(ctx, agent)
    expect(result.isError).toBe(false)
    expect(seen[0]!.toolFilter).toBeUndefined()
    provider.start = originalStart
  })

  it('rejects the delegation when plan mode is active but the provider cannot enforce a tool filter', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    registerMinimalPlanProjection(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, {
      name: 'mock-nofilter',
      reply: 'ok',
      capabilities: { toolFilter: false },
    })
    await ctx.plugin(tool, { provider: 'mock-nofilter', toolName: 'subagent_nofilter', maxDepth: 'provider-managed' })
    const agent = scopedAgent(ctx, 'plan-nofilter')
    setPlanMode(ctx, agent, true)

    const result = await ctx.tools.execute({
      signal: testSignal,
      callId: ToolCallId('plan-guard-nofilter'),
      name: 'subagent_nofilter',
      arguments: { description: 'd', prompt: 'p', run_in_background: false },
      agent,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(PLAN_MODE_TOOL_FILTER_ERROR)
  })

  it('rejects the delegation when plan mode is active but the provider cannot enforce a depth cap', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    registerMinimalPlanProjection(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, {
      name: 'mock-nodepth',
      reply: 'ok',
      capabilities: { depthLimit: false },
    })
    await ctx.plugin(tool, {
      provider: 'mock-nodepth',
      toolName: 'subagent_nodepth',
      maxDepth: 'provider-managed',
    })
    const agent = scopedAgent(ctx, 'plan-nodepth')
    setPlanMode(ctx, agent, true)

    const result = await ctx.tools.execute({
      signal: testSignal,
      callId: ToolCallId('plan-guard-nodepth'),
      name: 'subagent_nodepth',
      arguments: { description: 'd', prompt: 'p', run_in_background: false },
      agent,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(PLAN_MODE_TOOL_FILTER_ERROR)
  })
})
