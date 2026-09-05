/**
 * Plan-mode read-only enforcement for one delegation tool instance.
 *
 * Plan mode's guidance says a sub-agent spawn is a way to carry out the plan
 * through someone else's hands: a spawned child is a fresh session that
 * inherits no plan state, so nothing in its composition knows the parent is
 * planning. The tool layer is the one trust boundary that does — it holds the
 * exact calling `Agent` and constructs the start request — so enforcement
 * lives here, on the request, not in prompt text.
 *
 * The enforcement is a hard constraint: while the calling session's `plan`
 * projection is active, every child this tool starts is forced to run with a
 * tool filter that denies mutation tools (write/edit/str_replace_editor, the
 * sandbox bash controls, background-job controls, self-modifying and goal/
 * todo drivers, discovery, and image reading). When the parent exposes them,
 * orchestration and dynamic-runtime mutation tools are denied too.
 * `tools.restrict()` denies at both visibility and execution, so the child
 * cannot re-acquire a denied tool by any route (the same hard-guarantee
 * mechanism the Reviewer role relies on). A provider that cannot apply a tool filter (`toolFilter` capability
 * absent) cannot make the child read-only — the delegation is REJECTED rather
 * than silently relaxing the mask, so nothing depends on the worker behaving
 * nicely.
 *
 * Recursion is capped too: the child's own depth is the absolute cap, so a
 * plan-mode child cannot spawn deeper children whose fresh sessions would
 * escape the mask (their own plan projection folds inactive). The cap applies
 * only to providers that advertise `depthLimit`, which is exactly the
 * filterable in-process provider set.
 *
 * The deny list deliberately does NOT name delegation tools themselves
 * (`subagent`, `subagent_reviewer`, ...): `modelSelectionSettings: true`
 * installs those tools into each Agent's OWN scope layer, and
 * `tools.restrict()` validates against the inherited (global) surface, so
 * naming an own-layer tool throws "unknown global tools" at every child
 * creation. The depth cap above is what closes the recursion route instead.
 *
 * The guard keeps read-only evidence gathering functional on purpose: the
 * read/grep/glob search set and the shell-less file inspection tools stay
 * usable, matching plan mode's "delegate only read-only evidence gathering"
 * rule.
 *
 * Plan state is read opportunistically through `ctx.get('sessionProjections')`
 * and never as a hard dependency: a deployment without plan mode leaves
 * delegations unrestricted.
 *
 * @module @deepseek-ai/dsh-tool-subagent/plan-mode-guard
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

/**
 * Global tool names a plan-mode child must not see or execute. Keep the list
 * aligned with the Reviewer role's deny mask in the preset composition — every
 * name must exist in the deployment's INHERITED global tool registry or
 * `tools.restrict()` fails loudly (unknown-name validation). Names that a
 * `modelSelectionSettings` composition registers into an Agent's own layer
 * (the delegation tools) must stay OUT of this list — see the header note.
 */
export const PLAN_MODE_DENY_NAMES = [
  'write',
  'edit',
  'str_replace_editor',
  'bash',
  'job_kill',
  'job_output',
  'create_goal',
  'update_goal',
  'get_goal',
  'todo_write',
  'dev_tool_search',
  'read_image',
] as const

/** Optional orchestration and dynamic-runtime tools that can mutate through a child. */
export const PLAN_MODE_DYNAMIC_DENY_NAMES = [
  'workflow',
  'ralph',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
] as const

/** Exact user-visible denial wording when the child cannot be made read-only. */
export const PLAN_MODE_TOOL_FILTER_ERROR
  = 'cannot delegate while this session is in plan mode: the configured provider cannot apply a tool filter, so the child could not be forced read-only'

/** The one `plan` unit fact this package reads, typed structurally (no dependency on dsh-plan-mode). */
interface PlanProjectionReader {
  stateOf(session: Session, key: string): { active?: boolean } | undefined
}

/**
 * Whether a calling agent's session is active in plan mode.
 * An absent plan projection (plan mode not composed) reads as inactive.
 * @param agent - the delegating agent, or undefined outside an agent.
 * @returns `true` when the plan projection exists and reports `active`.
 */
export function isPlanModeActive(agent: Agent | undefined): boolean {
  if (agent === undefined) return false
  const agentContext = (agent as unknown as { ctx?: Context }).ctx
  if (agentContext === undefined) return false
  const registry = agentContext.get('sessionProjections') as PlanProjectionReader | undefined
  if (registry === undefined) return false
  // `stateOf` is the synchronous materialized fold; the `plan` key is declared
  // by @deepseek-ai/dsh-plan-mode, which this package intentionally does not
  // depend on, so the read is structural.
  const state = registry.stateOf(agent.session, 'plan')
  return state?.active === true
}

/**
 * Intersect a caller's per-child tool filter with the plan-mode read-only
 * mask. Deny lists union (restriction intersections remove names), so a
 * preset-authored deny stays in force and an existing `allow` list only
 * narrows further.
 * @param filter - the configured per-child filter, if any.
 * @param availableNames - names currently exposed by the parent deployment;
 *   when provided, fixed and optional names are added only when present.
 * @returns the combined filter, or a fresh deny-only filter when none exists.
 */
export function planModeToolFilter(
  filter: ToolRestriction | undefined,
  availableNames?: Iterable<string>,
): ToolRestriction {
  const deny = new Set<string>(filter?.deny ?? [])
  const available = availableNames === undefined ? undefined : new Set(availableNames)
  for (const name of PLAN_MODE_DENY_NAMES) {
    if (available === undefined || available.has(name)) deny.add(name)
  }
  for (const name of PLAN_MODE_DYNAMIC_DENY_NAMES) {
    if (available === undefined || available.has(name)) deny.add(name)
  }
  return {
    ...(filter?.allow !== undefined ? { allow: [...filter.allow] } : {}),
    deny: [...deny],
  }
}

/**
 * The recursion cap for a plan-mode child: its own resolved depth, so the
 * child may not delegate any deeper (each deeper child's fresh session would
 * fold its own inactive plan projection and escape the mask).
 * @param parentDepth - the delegating parent's delegation depth.
 * @returns the child's depth, usable as `maxDepth`.
 */
export function planModeMaxDepth(parentDepth: number): number {
  return parentDepth + 1
}
