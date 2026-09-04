/** Host-owned opt-in setting for model-selectable subagent delegation. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import {
  AllowedModelRouteSchema,
  assertAllowedModelRoutes,
  modelRouteKey,
  type AllowedModelRoute,
} from './model-selection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference sampled when a new Agent receives its delegation tools. */
    subagentModelSelection: SubagentModelSelectionConfig
  }
}

/** User-settings section for model-selectable subagent delegation. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE = 'subagent-model-selection'

/** Stored user preference; the shipped composition defaults it off. */
export interface SubagentModelSelectionSettings {
  /** Whether newly composed top-level Sessions receive model selection. */
  enabled: boolean
  /** Exact child LLM routes offered to newly composed top-level Sessions. */
  allowedModels: AllowedModelRoute[]
  /** Route used when a delegation call selects no model; undefined inherits the parent route. */
  defaultRoute?: AllowedModelRoute
  /**
   * Route for delegation rows declared as `role: arbiter` when they select no
   * model; undefined falls back to {@link SubagentModelSelectionSettings.defaultRoute}.
   */
  arbiterRoute?: AllowedModelRoute
}

/** Schema served to settings clients for the opt-in preference. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA: z<SubagentModelSelectionSettings> = z.object({
  enabled: z.boolean().default(false),
  allowedModels: z.array(AllowedModelRouteSchema).default([]),
  // Preserve omission; Schemastery would materialize an omitted route as `{}`.
  defaultRoute: AllowedModelRouteSchema.default(undefined as unknown as AllowedModelRoute),
  arbiterRoute: AllowedModelRouteSchema.default(undefined as unknown as AllowedModelRoute),
})

/** Optional deployment base for the preference. */
export interface Config {
  /** Initial enabled state inherited when the user document does not override it. */
  enabled?: boolean
  /** Initial route list inherited when the user document does not override it. */
  allowedModels?: AllowedModelRoute[]
  /** Initial no-selection default inherited when the user document does not override it. */
  defaultRoute?: AllowedModelRoute
  /** Initial arbiter route inherited when the user document does not override it. */
  arbiterRoute?: AllowedModelRoute
}

/** Singleton settings owner read by delegation tools when an Agent is published. */
export class SubagentModelSelectionConfig extends Service {
  static Config: z<Config> = z.object({
    enabled: z.boolean().default(false),
    allowedModels: z.array(AllowedModelRouteSchema).default([]),
    defaultRoute: AllowedModelRouteSchema.default(undefined as unknown as AllowedModelRoute),
    arbiterRoute: AllowedModelRouteSchema.default(undefined as unknown as AllowedModelRoute),
  })

  private source: () => SubagentModelSelectionSettings

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'subagentModelSelection')
    // Cordis supplies the schema default; the fallback also covers direct construction.
    /* v8 ignore next */
    const entry: SubagentModelSelectionSettings = {
      enabled: config.enabled ?? false,
      allowedModels: config.allowedModels ?? [],
      ...config.defaultRoute === undefined ? {} : { defaultRoute: { ...config.defaultRoute } },
      ...config.arbiterRoute === undefined ? {} : { arbiterRoute: { ...config.arbiterRoute } },
    }
    this.validate(entry)
    this.source = () => entry
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(
        ctx,
        SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE,
        SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA,
        entry,
        {
          setSource: (source) => { this.source = source },
          validate: (value) => { this.validate(value) },
          // Consumers sample at Agent publication, so a settings update never
          // rebuilds the tool definitions of an Agent that is already running.
          onChange: () => {},
        },
      )
    })
  }

  /**
   * Read a detached selection preference for the next eligible Agent publication.
   * @returns the enabled state, exact allowed routes, and the optional no-selection routes.
   */
  current(): SubagentModelSelectionSettings {
    const current = this.source()
    return {
      enabled: current.enabled,
      allowedModels: current.allowedModels.map(route => ({ ...route })),
      ...current.defaultRoute === undefined ? {} : { defaultRoute: { ...current.defaultRoute } },
      ...current.arbiterRoute === undefined ? {} : { arbiterRoute: { ...current.arbiterRoute } },
    }
  }

  private validate(value: SubagentModelSelectionSettings): void {
    assertAllowedModelRoutes(value.allowedModels)
    if (value.enabled && value.allowedModels.length === 0) {
      throw new Error('enabled subagent model selection requires at least one allowed model')
    }
    // Both no-selection routes answer to the same two rules: the opt-in must be
    // on, and the route must be one the Agent may select explicitly.
    for (const [route, label] of [
      [value.defaultRoute, 'default route'],
      [value.arbiterRoute, 'arbiter route'],
    ] as const) {
      if (route === undefined) continue
      if (!value.enabled) {
        throw new Error(`a subagent ${label} requires enabled subagent model selection`)
      }
      assertAllowedModelRoutes([route])
      if (!value.allowedModels.some(candidate => modelRouteKey(candidate) === modelRouteKey(route))) {
        throw new Error(`subagent ${label} "${route.provider}/${route.model}" is not an allowed model`)
      }
    }
  }
}

export const name = 'subagent-model-selection-settings'
export default SubagentModelSelectionConfig
