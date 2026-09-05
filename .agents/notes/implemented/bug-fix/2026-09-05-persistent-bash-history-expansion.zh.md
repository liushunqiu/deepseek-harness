# Agent Note: 持久 Bash 保留字面历史字符

Status: implemented

[English](2026-09-05-persistent-bash-history-expansion.md) | 中文

## 问题

Bash 3.2 可能对 ANSI-C 引用命令中转义单引号后的 `!` 执行历史展开。因此，包含 `'!archived/**'` 或 `'!js'` 的命令可能在持久工具的起止标记执行前就失败。在 macOS 上，此时的提示符缺少后端正常的就绪标记，因此即使解析立即失败，工具仍会等待到命令截止时间。

## 决策

`quoteForBash()` 在转义输入反斜杠后，把每个感叹号编码为 `\041`。外层交互式 shell 不会收到字面的历史展开起始字符；ANSI-C 解码会在 `eval` 解析前恢复原始命令。原有的字面 `\041` 文本保持不变，固定三位转义也保留相邻数字。命令仍只占一行物理输入。

编码不依赖可变的 shell 选项，因此显式执行 `set -H` 也不会重新引入此故障。[持久工具的所有权](../feature/2026-07-29-persistent-bash-str-replace-editor.zh.md)与[后端的受控提示符协议](2026-08-15-persistent-bash-keeps-controlled-prompt.zh.md)保持不变。

## 考虑过的替代方案

**仅在初始化时关闭历史展开。** 后续命令或加载的脚本可以重新启用它。对提交命令编码无需改变 shell 选项状态，就能保护每次调用。

**延长命令超时。** 发生此解析错误后，命令完成标记不会执行，因此延长超时只会推迟相同的失败和 shell 重置。

## 后果

工具 schema、命令超时、持久状态和提示符所有权保持不变。Bash 历史替换不属于提交命令的语言；调用方会收到其引用的字面感叹号。

单元测试检查提交的物理行。真实 Loader/PTY 测试开启历史展开，并验证带引号的 glob、YAML 标签、相邻数字、字面八进制文本、heredoc 和状态保留。[录制会话](../../../../snapshots/session/persistent-bash-literal-history/session.jsonl)通过随附的 headless profile 固定结果。其他交互式输入等待仍遵循文档中的命令截止时间。
