# Agent Teams 和 Subagent 触发条件与价值分析

## 触发条件

### 功能启用条件
- **内部用户（USER_TYPE === 'ant'）**：始终启用 Agent Teams 功能
- **外部用户**：需同时满足两个条件
  - 环境变量 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 为 true **或**使用 `--agent-teams` 标志
  - GrowthBook 功能开关 `tengu_amber_flint` 已启用（安全开关）

### Agent Teams（团队）触发条件
使用 `TeamCreate` 工具：
- **必填参数**：`team_name`（团队名称）
- **可选参数**：`description`（团队描述）、`agent_type`（领导者类型）
- 限制：**一个领导者（team lead）只能管理一个团队**

### Subagent（子Agent）触发条件
使用 `Agent` 工具：
- **必填参数**：
  - `description`：任务简短描述（3-5个单词）
  - `prompt`：任务详细说明
- **可选参数**：
  - `subagent_type`：指定子Agent类型（如 `general-purpose`、`claude-code-guide` 等）
  - `name`：子Agent名称
  - `team_name`：指定所属团队（若已创建团队）
  - `mode`：权限模式（如 `plan` 模式）
  - `isolation`：隔离方式（如 `worktree`）
  - `run_in_background`：是否后台运行

## 功能价值

### 任务分工与协作
允许将**复杂任务分解为多个子任务**，分配给不同Agent，每个Agent专注于特定领域。

### 并行处理
多个Agent可同时工作，**提高任务执行效率**，适合处理多步骤、多领域专业知识的复杂问题。

### 资源隔离
可为每个Agent提供**独立工作目录**（通过 `cwd` 参数），支持git worktree隔离，防止代码冲突。

### 专业Agent类型
提供**不同类型的内置Agent**，如：
- `claude-code-guide`：专门处理Claude Code相关问题
- `general-purpose`：通用Agent
可根据任务特点选择合适的Agent类型。

## 触发原因与解决问题

### 触发原因
- **处理复杂任务**：当任务过于复杂，单个Agent难以完成时
- **加速任务执行**：通过**并行处理**缩短任务完成时间
- **专业领域需求**：需要特定领域专业知识的任务（如前端开发、API设计等）
- **隔离执行环境**：需要防止任务之间相互影响时

### 解决的问题
- **任务过载**：将大型任务分解为可管理的子任务
- **专业知识缺口**：为特定任务类型分配专业Agent
- **执行效率**：通过并行处理提高任务完成速度
- **环境隔离**：防止不同任务之间的资源冲突
- **协作需求**：支持多个Agent之间的通信和协作（通过 `SendMessage` 工具）

## 工具使用场景

| 工具                     | 主要使用场景                                 |
|--------------------------|------------------------------------------|
| TeamCreate               | 启动新的Agent Teams项目，建立团队上下文        |
| Agent                    | 为具体任务启动专业子Agent                     |
| SendMessage              | 团队成员之间的通信和协作                       |
| TaskCreate/TaskUpdate    | 任务管理和进度追踪                            |
| Bash/Read/Edit           | 执行系统命令和代码修改                          |

## 官方文档参考
完整工具参考请查阅：[Claude Code 工具参考](https://code.claude.com/docs/zh-CN/tools-reference)