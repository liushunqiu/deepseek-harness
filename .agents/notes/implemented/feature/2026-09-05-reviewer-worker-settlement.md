# Agent Note: Reviewer admission after Worker settlement

Status: implemented

English | [中文](2026-09-05-reviewer-worker-settlement.zh.md)

## Problem

A Reviewer must judge evidence produced by a Worker, but a model can issue the Reviewer call while a Worker is still running or after Worker startup failed. Tool rows may run in different Cordis Contexts while sharing one SubagentRuntime, and each parent Agent needs independent accounting.

## Decision

`dsh-tool-subagent` exposes `requiresCompletedWorker`. An enabled instance binds each Reviewer to one same-parent Worker, selected by child or job id through `worker_id`; omission requires exactly one Worker. The latest run must complete normally with nonblank final text, and every Worker must have settled. Startup, execution, cancellation, truncation, empty output, and cleanup failures cannot authorize review. Admission reserves the Worker or Reviewer synchronously before route preflight, preventing overlapping repair and review.

Tool rows share the original `SubagentRuntime` identity retained by its Typert binding; a weak parent map isolates each Agent's tracked children. Foreground and one-shot background runs remain pending through resource disposal. Continuable children retain their identity across residency epochs: `subagent/start` invalidates the old result, and only the matching run id's `subagent/end` can complete the current epoch. Lifecycle events arriving before inbox acceptance returns are retained until child publication. Parent disposal removes admission facts. Reviewer and arbiter rows do not count as Workers. Plan-mode delegation also restricts exposed mutation and orchestration tools and caps child depth; absent optional tools do not create invalid restrictions.

The monotonic tool guard rechecks Reviewer `send_message` calls against their bound Worker. An around-dispatch listener holds a delivery reservation before any asynchronous send, releasing it on success or failure; service lifecycle events own the resulting epoch. Shared execution tokens prevent sibling rows from double-accounting a delivery. Active Reviewer reservations reject Worker starts and follow-ups, so a review cannot race the repair it is intended to judge.

## Alternatives considered

**Use one process-wide Worker counter.** Rejected because a Worker from one parent could unlock another parent's Reviewer.

**Key trackers by the value returned from `ctx.get('subagents')`.** Rejected because Cordis returns a new traceable Proxy for each Context read, which would split rows that use one SubagentRuntime.

**Settle a continuable Worker when `startContinuable()` accepts its inbox.** Rejected because acceptance starts an independent child residency epoch; the Worker remains active until the manager publishes `subagent/end`.

**Add Reviewer-specific fields to the Subagent service or provider protocol.** Rejected because the admission rule belongs to the model-facing tool composition and needs no provider-specific state or wire change.

## Consequences

- A Reviewer configuration is explicit and remains opt-in; ordinary delegation keeps its existing behavior.
- The policy checks lifecycle completion and text presence, not task-specific report fields or correctness. It applies to tracked tool delegations, not arbitrary service callers; restored parents need new tracked work.
- Multiple tool rows share accounting across nested runtime Contexts without sharing state between separate SubagentRuntime services or parent Agents.
- Plan-mode tests cover the fixed read-only mask and dynamic denial of exposed orchestration and Cordis mutation tools.
- Focused tests cover initial and follow-up admission, parent isolation, publication races, old terminal events, delivery rollback, and disposal. The [authored recorded session](../../../../snapshots/session/subagent-review-admission/session.jsonl) pins Loader-composed Reviewer schemas and rejection before work and after a truncated Worker.
