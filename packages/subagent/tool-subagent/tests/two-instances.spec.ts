/** Several model-selectable delegation rows installed on one Agent. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as tool from '../src/index.ts'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'
import { acquireListSubagentModels } from '../src/list-models.ts'
import { text } from './harness.ts'

const ALLOWED_MODELS = [
  { provider: 'alpha', model: 'fast-model' },
  { provider: 'alpha', model: 'review-model' },
]

let callCounter = 0

/** Mount the real settings, Agent, provider, and tool services. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: ALLOWED_MODELS })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  return ctx
}

type ToolFiber = Awaited<ReturnType<Context['plugin']>>

/** Compose one Agent while retaining each delegation row's independent fiber. */
async function createAgent(ctx: Context, id: string) {
  const fibers: ToolFiber[] = []
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx) => {
      fibers.push(await agentCtx.plugin(tool, {
        provider: 'spawn',
        toolName: 'subagent',
        modelSelectionSettings: true,
        backgroundMode: 'continuable',
      }))
      fibers.push(await agentCtx.plugin(tool, {
        provider: 'spawn',
        toolName: 'subagent_reviewer',
        modelSelectionSettings: true,
        backgroundMode: 'continuable',
      }))
    },
  })
  return { ...handle, fibers }
}

/** Execute discovery through the real scoped tool pipeline. */
async function discover(ctx: Context, agent: Awaited<ReturnType<typeof createAgent>>['agent']): Promise<string> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`two-instances-${++callCounter}`),
    name: 'list_subagent_models',
    arguments: {},
    agent,
  })
  expect(result.isError).toBe(false)
  return text(result)
}

/** Assert the discovery registration's scoped visibility and callable policy. */
async function expectDiscovery(ctx: Context, agent: Awaited<ReturnType<typeof createAgent>>['agent']): Promise<void> {
  expect(ctx.tools.schemas(agent).filter(schema => schema.name === 'list_subagent_models')).toHaveLength(1)
  await expect(discover(ctx, agent)).resolves.toBe('(no LLM providers)')
}

describe('several model-selectable delegation rows on one Agent', () => {
  it('registers every row\'s own tool name', async () => {
    const ctx = await boot()
    const { agent } = await createAgent(ctx, 'two-rows')

    const names = ctx.tools.schemas(agent).map(schema => schema.name)
    expect(names).toContain('subagent')
    expect(names).toContain('subagent_reviewer')
    await ctx.fiber.dispose()
  })

  it('transfers discovery when the first owner disposes and survives replacement order', async () => {
    const ctx = await boot()
    const { agent, fibers } = await createAgent(ctx, 'two-rows-discovery-owner-first')
    const [first, second] = fibers
    if (first === undefined || second === undefined) throw new Error('missing delegation row fibers')

    await expectDiscovery(ctx, agent)
    await first.dispose()
    await expectDiscovery(ctx, agent)

    const replacement = await agent.ctx.plugin(tool, {
      provider: 'spawn',
      toolName: 'subagent_replacement',
      modelSelectionSettings: true,
      backgroundMode: 'continuable',
    })
    await second.dispose()
    await expectDiscovery(ctx, agent)
    await replacement.dispose()
    expect(ctx.tools.schemas(agent).some(schema => schema.name === 'list_subagent_models')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('keeps discovery with its owner when the other row disposes first', async () => {
    const ctx = await boot()
    const { agent, fibers } = await createAgent(ctx, 'two-rows-discovery-owner-last')
    const [first, second] = fibers
    if (first === undefined || second === undefined) throw new Error('missing delegation row fibers')

    await second.dispose()
    await expectDiscovery(ctx, agent)
    await first.dispose()
    expect(ctx.tools.schemas(agent).some(schema => schema.name === 'list_subagent_models')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('rejects conflicting discovery policies in one scope', async () => {
    const ctx = await boot()
    const { agent } = await createAgent(ctx, 'two-rows-conflicting-policy')

    expect(() => acquireListSubagentModels(agent.ctx, {
      routes: [{ provider: 'beta', model: 'other-model' }],
    })).toThrow('selectable rows in one scope must use the same model-selection policy')
    await expectDiscovery(ctx, agent)
    await ctx.fiber.dispose()
  })

  it('makes every row selectable, not only the first', async () => {
    const ctx = await boot()
    const { agent } = await createAgent(ctx, 'two-rows-selectable')

    const properties = (name: string) => {
      const schema = ctx.tools.schemas(agent).find(candidate => candidate.name === name)
      const parameters = schema?.parameters as { properties?: Record<string, unknown> } | undefined
      return parameters?.properties
    }
    for (const name of ['subagent', 'subagent_reviewer']) {
      expect(properties(name)?.['provider'], name).toBeDefined()
      expect(properties(name)?.['model'], name).toBeDefined()
    }
    await ctx.fiber.dispose()
  })
})
