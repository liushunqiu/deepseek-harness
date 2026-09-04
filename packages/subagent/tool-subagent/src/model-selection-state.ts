/** Durable per-session state for the user-controlled model-selection opt-in. */

import { z as zod } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { assertAllowedModelRoutes, modelRouteKey, type AllowedModelRoute } from './model-selection.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records that this session's delegation tool exposes child provider,
     * model, and reasoning-effort selection. Appended before the first model
     * request; absence means the fixed-route definition. Log-only: it carries
     * no `surfaceOp` and never enters model history.
     */
    'subagent/model-selection-policy': {
      /** Exact routes this Session may select explicitly for a child. */
      allowedModels: AllowedModelRoute[]
      /**
       * Route used when a delegation call selects no model. Absent in logs
       * written before defaults existed, and in sessions without one.
       */
      defaultRoute?: AllowedModelRoute
      /**
       * Route used by `role: arbiter` rows that select no model. Absent in logs
       * written before role routes existed; such rows then use `defaultRoute`.
       */
      arbiterRoute?: AllowedModelRoute
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /**
     * The delegation policy captured for a model-selectable definition, or
     * null when this Session has none yet. Plain JSON so the persisted
     * projection cache can rehydrate the optional no-selection routes.
     */
    subagentModelSelectionPolicy: SubagentModelSelectionPolicy | null
  }
}

/** The sampled delegation policy one Session's tool instance installs with. */
export interface SubagentModelSelectionPolicy {
  /** Exact routes this Session may select explicitly for a child. */
  readonly allowedModels: AllowedModelRoute[]
  /** Route used when a delegation call selects no model; undefined inherits the parent route. */
  readonly defaultRoute?: AllowedModelRoute | undefined
  /** Route used by `role: arbiter` rows that select no model; undefined uses `defaultRoute`. */
  readonly arbiterRoute?: AllowedModelRoute | undefined
}

const modelRouteSchema = zod.object({
  provider: zod.string().min(1),
  model: zod.string().min(1),
}).strict()

const modelSelectionPolicySchema: zod.ZodType<SubagentModelSelectionPolicy | null> = zod.object({
  allowedModels: zod.array(modelRouteSchema).min(1),
  defaultRoute: modelRouteSchema.optional(),
  arbiterRoute: modelRouteSchema.optional(),
}).strict().nullable()

/** Host-only projection of the durable model-selection policy. */
export const subagentModelSelectionProjectionDefinition = {
  key: 'subagentModelSelectionPolicy',
  // v2: the fold value grew from a bare route list to a policy record carrying
  // the optional default/arbiter routes; persisted v1 rows must be discarded.
  stateVersion: 2,
  stateSchema: modelSelectionPolicySchema,
  init: () => null,
  apply: (policy, event) => {
    if (policy !== null || event.type !== 'subagent/model-selection-policy') return policy
    const { allowedModels, defaultRoute, arbiterRoute } = event.data
    assertAllowedModelRoutes(allowedModels)
    const routes = allowedModels.map(route => ({ ...route }))
    if (routes.length === 0) {
      throw new Error('subagent/model-selection-policy requires at least one route')
    }
    const member = (route: AllowedModelRoute, label: string): AllowedModelRoute => {
      assertAllowedModelRoutes([route])
      if (!routes.some(candidate => modelRouteKey(candidate) === modelRouteKey(route))) {
        throw new Error(`subagent/model-selection-policy ${label} "${route.provider}/${route.model}" is not an allowed model`)
      }
      return { ...route }
    }
    return {
      allowedModels: routes,
      ...defaultRoute === undefined ? {} : { defaultRoute: member(defaultRoute, 'default route') },
      ...arbiterRoute === undefined ? {} : { arbiterRoute: member(arbiterRoute, 'arbiter route') },
    }
  },
} satisfies ProjectionDefinition<'subagentModelSelectionPolicy', SubagentModelSelectionPolicy | null>

/**
 * Read the policy captured for a model-selectable definition.
 * @param projections - registry that owns the policy projection.
 * @param session - session whose durable decision is read.
 * @returns a detached policy record, or undefined for the fixed-route definition.
 */
export function subagentModelSelectionPolicy(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): SubagentModelSelectionPolicy | undefined {
  // null (no policy event yet) and undefined (key not registered) both read
  // as the fixed-route definition; only a recorded policy is returned.
  const policy = projections.stateOf(session, 'subagentModelSelectionPolicy')
  if (policy == null) return undefined
  return {
    allowedModels: policy.allowedModels.map(route => ({ ...route })),
    ...policy.defaultRoute === undefined ? {} : { defaultRoute: { ...policy.defaultRoute } },
    ...policy.arbiterRoute === undefined ? {} : { arbiterRoute: { ...policy.arbiterRoute } },
  }
}

/**
 * Append the policy once, before its definition can reach a model request.
 * @param projections - registry that owns the policy projection.
 * @param session - session receiving the model-selectable definition.
 * @param policy - exact routes the definition may select explicitly, and the
 *   optional routes a call that selects no model uses.
 */
export function recordSubagentModelSelection(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
  policy: SubagentModelSelectionPolicy,
): void {
  if (subagentModelSelectionPolicy(projections, session) !== undefined) return
  session.append('subagent/model-selection-policy', {
    allowedModels: policy.allowedModels.map(route => ({ ...route })),
    ...policy.defaultRoute === undefined ? {} : { defaultRoute: { ...policy.defaultRoute } },
    ...policy.arbiterRoute === undefined ? {} : { arbiterRoute: { ...policy.arbiterRoute } },
  })
}
