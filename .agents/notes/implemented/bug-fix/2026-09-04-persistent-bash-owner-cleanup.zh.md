# Agent Note: 持久 Bash 的 owner 清理

Status: implemented

[English](2026-09-04-persistent-bash-owner-cleanup.md) | 中文

## Problem

持久 Bash 工具缓存每个 agent 的 PTY identity，但它的 owner 生命周期 disposer 过去只删除缓存条目。terminal registry 仍然持有已发布会话，因此 agent 销毁后可能留下交互式 Bash 进程，后续让 shell 操作表现为卡住。

## Decision

持久 Bash 工具在首次创建 shell 时安装异步的 owner 作用域 disposer。该 disposer 删除缓存 identity，并通过 `ctx.terminals.kill()` 关闭已发布 PTY，等待 terminal 清理达到完全停稳。工具销毁会等待正在进行的 shell 创建结算，然后关闭每个已发布 shell，最后清空存活缓存。

未发布的 PTY 创建仍由 `TerminalSessionService` 所有：它的 owner 清理负责中止并回滚后端 setup。持久工具不在 owner disposer 中等待未完成创建，因为该 disposer 正在同一 owner teardown 链中执行，等待 terminal service 随后的 owner 清理会形成死锁。

## Alternatives considered

**只删除缓存。** 拒绝，因为缓存失效不会终止 terminal service 持有的 PTY 会话。

**在持久工具的 owner disposer 中等待未完成创建。** 拒绝，因为 pending creation 的中止属于 terminal service 的 owner 清理，而该清理在同一 teardown 链中晚于持久工具 disposer 执行。

**只依赖 terminal service 清理。** 拒绝，因为 terminal service 可以比单个 agent 存活，并且必须继续服务其他 owner。

## Consequences

agent 销毁现在会在 owner 生命周期边界关闭持久 Bash 会话，避免 Web host 累积失效的交互式 shell。工具销毁仍会关闭所有已发布会话，同时保留 terminal service 作为唯一 PTY owner。未完成创建由 terminal service 中止并回滚，而不是由持久工具处理。

## Verification

持久 Bash 工具测试断言销毁 owner 会调用后端会话的 close 操作并移除 terminal listing。现有持久 Bash 生命周期测试继续覆盖超时、取消、启动失败、替换和工具销毁。
