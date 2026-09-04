# Agent Note: Persistent Bash owner cleanup

Status: implemented

English | [中文](2026-09-04-persistent-bash-owner-cleanup.zh.md)

## Problem

The persistent Bash tool cached each agent's PTY identity, but its owner lifecycle disposer only removed cache entries. The terminal registry still owned the published session, so an agent teardown could leave its interactive Bash process alive and later make shell operations appear stuck.

## Decision

The persistent Bash tool installs an asynchronous owner-scoped disposer when it first creates a shell. The disposer removes the cached identity and closes the published PTY through `ctx.terminals.kill()`, waiting for terminal cleanup to reach quiescence. Tool disposal waits for in-progress shell creation to settle, then closes every published shell before clearing its live cache.

Unpublished PTY creation remains owned by `TerminalSessionService`: its owner cleanup aborts and rolls back pending backend setup. The persistent tool does not wait for a pending creation from the owner disposer, because that disposer runs inside the same owner teardown chain and waiting for the service's later owner cleanup would deadlock.

## Alternatives considered

**Only remove the cache entry.** Rejected because cache invalidation does not terminate the PTY session held by the terminal service.

**Wait for pending creation from the persistent tool's owner disposer.** Rejected because pending creation cancellation belongs to the terminal service's owner cleanup, which runs after the persistent tool disposer in the same teardown chain.

**Rely only on terminal service disposal.** Rejected because the terminal service can outlive an individual agent and must continue serving other owners.

## Consequences

Agent teardown now closes persistent Bash sessions at the owner lifetime boundary, preventing stale interactive shells from accumulating under the Web host. Plugin disposal still closes all published sessions and preserves the terminal service as the sole PTY owner. A pending creation is cancelled and rolled back by the terminal service rather than by the persistent tool.

## Verification

The persistent Bash tool test asserts that disposing an owner calls the backend session's close operation and removes its terminal listing. Existing persistent Bash lifecycle tests continue to cover timeout, cancellation, failed startup, replacement, and plugin disposal.
