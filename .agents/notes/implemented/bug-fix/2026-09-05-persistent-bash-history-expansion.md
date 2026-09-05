# Agent Note: Persistent Bash preserves literal history characters

Status: implemented

English | [中文](2026-09-05-persistent-bash-history-expansion.zh.md)

## Problem

Bash 3.2 can history-expand `!` after an escaped apostrophe inside an ANSI-C quoted command. A command containing `'!archived/**'` or `'!js'` can therefore fail before the persistent tool's start and end markers execute. On macOS, the resulting prompt lacks the backend's normal readiness marker, so the tool waits until its command deadline despite the immediate parse failure.

## Decision

`quoteForBash()` encodes every exclamation mark as `\041` after escaping input backslashes. The outer interactive shell never receives a literal history-expansion introducer; ANSI-C decoding restores the original command before `eval` parses it. Existing literal `\041` text remains literal, and the fixed three-digit escape preserves adjacent digits. The command stays on one physical input line.

The encoding does not depend on mutable shell options, so an explicit `set -H` cannot reintroduce this failure. The [persistent tool's ownership](../feature/2026-07-29-persistent-bash-str-replace-editor.md) and the [backend's controlled-prompt protocol](2026-08-15-persistent-bash-keeps-controlled-prompt.md) remain unchanged.

## Alternatives considered

**Disable history expansion only during initialization.** A later command or sourced script can re-enable it. Encoding the submitted command protects every call without changing the shell's option state.

**Increase the command timeout.** The command's completion marker never executes after this parse failure, so a longer timeout only delays the same failure and shell reset.

## Consequences

The tool schema, command timeout, persistent state, and prompt ownership are unchanged. Bash history substitution is not part of the submitted command language; callers receive the literal exclamation marks they quoted.

The unit test checks the submitted physical line. The real Loader/PTY test enables history expansion and verifies quoted globs, YAML tags, adjacent digits, literal octal text, heredocs, and state retention. The [recorded session](../../../../snapshots/session/persistent-bash-literal-history/session.jsonl) pins results through the shipped headless profile. Other interactive-input waits still follow the documented command deadline.
