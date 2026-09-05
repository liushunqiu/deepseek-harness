# Agent Note: Worker 结算后的 Reviewer 准入

Status: implemented

[English](2026-09-05-reviewer-worker-settlement.md) | 中文

## Problem

Reviewer 必须评判 Worker 产出的证据，但模型可能在 Worker 仍运行时，或 Worker 启动失败后，发起 Reviewer 调用。工具行可能位于不同的 Cordis Context 中却共享同一个 SubagentRuntime，因此每个父 Agent 都需要独立记账。

## Decision

`dsh-tool-subagent` 暴露 `requiresCompletedWorker`。启用该字段的实例把每个 Reviewer 绑定到同一父级下的一个 Worker，通过 `worker_id` 选择子会话或 job id；只有恰好一个 Worker 时才允许省略。最新一次运行必须正常完成并产出非空白最终文本，且所有 Worker 均已结算。启动、执行、取消、截断、空输出和清理失败均不能授权复核。准入在路由预检前同步预留 Worker 或 Reviewer，避免修复与复核重叠。

工具行通过 Typert 绑定保留的原始 `SubagentRuntime` 身份共享 tracker；弱父级映射隔离每个 Agent 跟踪的子级。前台与一次性后台运行在资源释放前保持 pending。可继续子级跨驻留轮次保留身份：`subagent/start` 使旧结果失效，只有运行 id 匹配的 `subagent/end` 才能结束当前轮次。inbox 接受返回前到达的生命周期事件会保留到子级发布。父 Agent 释放会删除准入事实。Reviewer 与 arbiter 行不计为 Worker。计划模式下的委派还会限制已暴露的变更与编排工具并约束子级深度；缺失的可选工具不会生成无效限制。

单调工具守卫根据已绑定 Worker 重新检查 Reviewer 的 `send_message` 调用。around-dispatch 监听器在任何异步发送前持有投递预留，并在成功或失败后释放；服务生命周期事件负责后续运行轮次。共享执行 token 防止同级工具行重复记账。活跃 Reviewer 预留拒绝 Worker 启动和续轮，因此复核不会与被复核的修复并发。

## Alternatives considered

**使用进程级 Worker 计数器。** 不采用，因为一个父级的 Worker 可能解锁另一个父级的 Reviewer。

**用 `ctx.get('subagents')` 返回的值作为 tracker 键。** 不采用，因为 Cordis 每次从 Context 读取都会返回新的 traceable Proxy，使用同一个 SubagentRuntime 的工具行会被拆成不同 tracker。

**在 `startContinuable()` 接受 inbox 时结算 Worker。** 不采用，因为接受只代表独立的子级 residency epoch 开始；Worker 仍要等管理器发布 `subagent/end` 才结束。

**向 Subagent 服务或提供方协议加入 Reviewer 专用字段。** 不采用，因为准入规则属于面向模型的工具组合，不需要提供方专用状态或 wire 变更。

## Consequences

- Reviewer 配置是显式且仍为 opt-in；普通委派保持原有行为。
- 策略检查生命周期完成与文本存在，不检查任务特定的报告字段或正确性。它适用于受跟踪的工具委派而非任意服务调用方；恢复后的父级需要新的受跟踪工作。
- 多个工具行可以跨嵌套 runtime Context 共享记账，同时不会在不同 SubagentRuntime 服务或父 Agent 之间共享状态。
- 计划模式测试覆盖固定只读掩码，以及对已暴露编排和 Cordis 变更工具的动态拒绝。
- 聚焦测试覆盖首次与续轮准入、父级隔离、发布竞态、旧终止事件、投递回滚和释放。[人工编写的会话快照](../../../../snapshots/session/subagent-review-admission/session.jsonl)固定 Loader 组合后的 Reviewer schema，以及工作开始前和 Worker 截断后的拒绝结果。
