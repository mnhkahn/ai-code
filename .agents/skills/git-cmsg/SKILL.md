---
name: git-cmsg
description: Use when generating Git commit messages, writing commit messages, committing code, or when the user mentions commit、提交、commit message、提交信息. Generates Conventional Commits format messages in Chinese and requires explicit confirmation before committing.
allowed-tools: AskUserQuestion, Bash
---

# Git Commit Message Generator

Generate Conventional Commits format commit messages in Chinese. Commit but never push.

## When to Use

- User wants to commit code changes
- User asks to generate a commit message
- User mentions "提交", "commit", "commit message"

## Conventional Commits Specification

Format:

```
<type>(<scope>): <subject>

<body>

BREAKING CHANGE: <description>
Closes #<issue>
```

**All text must be in Chinese** except type, scope, and special tokens (BREAKING CHANGE, Closes).

## Types

| Type | Chinese | When |
|------|---------|------|
| feat | 新增功能 | New feature |
| fix | 修复缺陷 | Bug fix |
| docs | 文档变更 | Documentation only |
| style | 代码格式 | Formatting, whitespace, semicolons (no logic change) |
| refactor | 重构 | Neither new feature nor bug fix |
| perf | 性能优化 | Performance improvement |
| test | 测试相关 | Adding or fixing tests |
| chore | 构建/工具/依赖 | Build, tools, dependencies |
| ci | CI/CD 配置 | CI/CD configuration |
| revert | 回退提交 | Reverting a commit |
| build | 构建系统 | Build system or external dependencies |

## Rules

1. **Analyze staged changes first.** Run `git diff --cached` to understand what changed. Never guess.
2. **Determine type from changes, not from user description.** If user says "update" but the change adds a feature, use `feat`.
3. **Scope is optional but recommended.** Infer from changed file paths (package name, module name, directory). Use one scope per commit.
4. **Subject line:** Chinese, imperative mood, no period, under 50 chars. Concise summary of WHAT and WHY, not HOW.
5. **Body:** Chinese, explain WHY the change was made. Use numbered list for multiple changes. One change per line.
6. **Do NOT include HOW details** (implementation specifics) in the message.
7. **Commit but do NOT push.** Run `git commit` only. Never `git push`.
8. **必须等待用户确认。** 生成 commit message 后，展示给用户并等待明确同意。用户未回复前禁止执行 `git commit`。如果用户提出修改意见，按意见调整后再次展示确认。
9. **Use the current agent's question tool.** Claude Code should use `AskUserQuestion`. Codex should use `request_user_input` when that tool is listed, available, and permitted in the current mode. If no structured question tool is available or the tool call fails, ask the same question in plain text and wait for the user's reply.

## Decision UI

For every user decision in this skill, use this order:

1. **Claude Code:** use `AskUserQuestion` with the listed `question`, `header`, and `options`.
2. **Codex:** use `request_user_input` with one question object. Include `header`, a stable snake_case `id`, `question`, and 2-3 options. Put the recommended option first and suffix its label with `(Recommended)`.
3. **Fallback:** if the current agent does not expose either structured question tool, or the tool is unavailable, not permitted, or fails, ask the same options as plain text. Do not continue until the user clearly chooses an option.

Never invent a tool name that is not available in the current runtime.

## Pre-commit File Check

Before generating the commit message, inspect staged files for files that should not be committed.

### Detection Rules

Flag staged files matching any of these patterns:

| Category | Patterns |
|----------|----------|
| IDE/Editor | `.idea/`, `.vscode/`, `*.swp`, `*.swo`, `*~`, `.DS_Store` |
| Build output | `*.o`, `*.a`, `*.so`, `*.exe`, `*.dll`, `*.pyc`, `__pycache__/`, `*.class`, `*.jar`, `*.war`, `dist/`, `build/`, `out/`, `target/` |
| Dependencies | `node_modules/`, `vendor/`, `venv/`, `.venv/`, `Gopkg.lock` (if not needed) |
| Secrets/Credentials | `.env`, `*.pem`, `*.key`, `*.p12`, `credentials.*`, `*.secret`, `id_rsa*` |
| Generated files | `*.min.js`, `*.min.css`, `*.generated.*`, `*.pb.go`, `*.mock.go` (unless intentional) |
| Log/Temp | `*.log`, `*.tmp`, `*.bak`, `*.cache`, `.cache/` |
| OS files | `Thumbs.db`, `Desktop.ini`, `.DS_Store` |

### Workflow

```
1. git diff --cached --name-only → Get staged file list
2. Match against detection rules
3. If suspicious files found:
   a. List them with reasons
   b. Use Decision UI to ask: remove from staging, or confirm intentional commit
      - question: "发现可能不应提交的文件，要怎么处理？"
      - header: "可疑文件处理"
      - id: "suspicious_file_action"
      - options: [
          { label: "移除文件", description: "从暂存区移除这些文件，但保留在工作区" },
          { label: "继续提交", description: "确认这些文件是故意提交的" },
          { label: "取消操作", description: "取消当前提交操作" }
        ]
   c. If patterns suggest missing .gitignore:
      - Check if .gitignore exists and already covers these patterns
      - If not covered, propose .gitignore additions
      - Use Decision UI to ask: whether to create/update .gitignore
        - question: "是否要创建/更新 .gitignore 文件？"
        - header: "Git忽略文件"
        - id: "gitignore_action"
        - options: [
            { label: "创建/更新", description: "创建或更新 .gitignore 文件以忽略这些模式" },
            { label: "不处理", description: "不创建/更新 .gitignore 文件" },
            { label: "取消操作", description: "取消当前提交操作" }
          ]
   d. After user decision, proceed with remaining staged files
4. If no suspicious files, proceed normally
```

### .gitignore Handling

- If `.gitignore` does not exist in the repo root, offer to create one with appropriate patterns for the project's language/framework.
- If `.gitignore` exists but misses patterns for the flagged files, propose appending the missing patterns.
- Never modify `.gitignore` without user confirmation.
- If user confirms `.gitignore` update, stage the `.gitignore` change and include it in the same commit with type `chore`.

## Workflow

```
1. git diff --cached --stat        → Overview of changes
2. git diff --cached --name-only   → Staged file list
3. Pre-commit file check           → Detect suspicious files, handle .gitignore
   ⚠️ 如果发现可疑文件，MUST STOP 等待用户决定后才能继续
4. git diff --cached               → Detailed diff (after any file removals)
5. Analyze: type + scope + subject + body
6. ⚠️ MUST STOP: 使用 Decision UI 展示生成的 commit message 并等待用户确认
   - question: "生成的提交信息是否符合要求？\n\n提交信息预览：\n```\n{commit_message}\n```"
   - header: "提交信息确认"
   - id: "commit_message_action"
   - options: [
       { label: "提交并推送", description: "使用此提交信息进行提交并直接 push 到远程仓库" },
       { label: "确认提交", description: "使用此提交信息进行提交" },
       { label: "重新生成", description: "重新分析代码变更并生成新的提交信息" },
       { label: "取消操作", description: "取消当前提交操作" }
     ]
7. git commit -m "<message>"       → Execute commit (only after user confirms)
8. If user chose "提交并推送": git push  → Execute push (only after commit is successful)
9. Show git log -1 --oneline       → Confirm result
```

## Subject Examples

Good:
- `feat(user): 新增用户注册接口`
- `fix(cache): 修复缓存过期时间未生效的问题`
- `refactor(handler): 优化指标打点逻辑并调整handleBinlogMessage参数`
- `perf(query): 减少数据库查询次数`
- `chore(deps): 升级Gin框架至v1.9.0`

Bad:
- `feat(user): 新增了一个用户注册的接口功能` (too verbose)
- `fix: fix bug` (no scope, no detail)
- `update code` (not Conventional Commits)
- `feat(user): add user register API` (not Chinese)

## Body Examples

Good:
```
refactor(handler): 优化指标打点逻辑并调整handleBinlogMessage参数

1. 重构emitCounter函数，移除固定name参数，内置指标名并通过tagkv传递维度信息
2. 调整handleBinlogMessage签名，新增topic参数用于传递binlog主题
3. 统一所有指标打点的标签格式，补充binlog主题、失败原因等维度信息
4. 调整日志和指标打点的关联逻辑，移除重复的指标调用
```

Bad:
```
fix: 修复了一些问题

- 改了代码
- 修了bug
```
(vague, no real information)


## Edge Cases

- **No staged changes:** Warn user to `git add` first. Do not commit.
- **Mixed types in one commit:** Pick the most significant type. If a refactor also fixes a bug, use `fix` if the bug fix is the primary intent, `refactor` if the restructuring is the primary intent.
- **Multiple scopes:** Use the most affected scope, or omit scope if no single scope dominates.
- **Breaking changes:** Always add `BREAKING CHANGE:` footer in body.
