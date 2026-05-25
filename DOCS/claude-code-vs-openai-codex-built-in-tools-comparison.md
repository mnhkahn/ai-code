# Claude Code vs OpenAI Codex — 内置工具对比总结

## 一、工具大类划分

两者的内置工具可归为 8 大类：

| 大类 | Claude Code | Codex |
|------|-------------|-------|
| 1. 文件读取 | ✅ | ✅ |
| 2. 文件编辑/创建 | ✅ | ✅ |
| 3. 文件搜索（模式匹配） | ✅ | ✅ |
| 4. Shell 命令执行 | ✅ | ✅ |
| 5. Web 搜索/抓取 | ✅ | ✅ |
| 6. 子代理/并行任务 | ✅ | ✅ |
| 7. 图片生成 | ❌ | ✅ |
| 8. Computer Use（GUI操作） | ❌ | ✅ |

---

## 二、各大类细分对比

### 1. 文件读取

| Claude Code | Codex |
|-------------|-------|
| Read — 读取文本/图片/PDF/Notebook | Shell 内 cat/读文件（无独立 Read 工具） |
| LSP — 代码智能（定义跳转、引用查找） | 无对应 |

### 2. 文件编辑/创建

| Claude Code | Codex |
|-------------|-------|
| Edit — 精确字符串替换 | Apply Patch — V4A diff 格式 |
| Write — 整文件覆盖写入 | Apply Patch create_file 操作 |
| NotebookEdit — Jupyter cell 编辑 | 无对应（通过 Shell 操作） |

差异：Claude Code 用「查找旧字符串→替换新字符串」模式；Codex 用「统一 diff patch」模式。

### 3. 文件搜索

| Claude Code | Codex |
|-------------|-------|
| Glob — 文件名模式匹配 | Shell 内 find/ls |
| Grep — 文件内容正则搜索 | Shell 内 grep/rg |
| 无 | File Search — 语义向量搜索（需上传到 Vector Store） |
| 无 | Tool Search — 搜索可用工具 |

差异：Claude Code 有专用的 Glob/Grep 工具避免 Shell 调用；Codex 本地靠 Shell，但多了语义搜索能力。

### 4. Shell 命令执行

| Claude Code | Codex |
|-------------|-------|
| Bash — 本地 Shell（持久会话） | Shell — 支持本地 + 托管容器两种模式 |
| PowerShell — Windows 专用 | 无独立 PowerShell |
| Monitor — 后台命令监控 | 容器复用实现类似效果 |

差异：Codex 的 Shell 支持云端托管容器（Debian 12，预装多语言运行时），可跨请求复用；Claude Code 只在本地执行。

### 5. Web 搜索/抓取

| Claude Code | Codex |
|-------------|-------|
| WebSearch — 关键词搜索 | Web Search — 支持普通搜索 + Agentic 搜索 + Deep Research |
| WebFetch — 抓取指定 URL 内容 | Web Search 的 open_page/find_in_page |

差异：Codex 的 Web Search 有三档模式（普通/代理式/深度研究），支持域名过滤和地理位置定制；Claude Code 分成 Search 和 Fetch 两个独立工具。

### 6. 子代理/并行任务

| Claude Code | Codex |
|-------------|-------|
| Agent — 可指定子代理类型（Explore/Plan/通用） | Subagents — 并行子任务 |
| TaskCreate/TaskUpdate/TaskList/TaskGet — 任务管理 | 无对应 |
| TeamCreate/SendMessage/TeamDelete — 多代理协作 | 无对应 |

差异：Claude Code 有完整的任务管理 + 团队协作系统；Codex 子代理更轻量。

### 7. 仅 Codex 有

| 工具 | 说明 |
|------|------|
| Image Generation | 通过 gpt-image-2 生成/编辑图片 |
| Computer Use | GUI 屏幕操作（点击、输入、截图） |
| Code Interpreter | 沙箱代码执行环境 |

### 8. 仅 Claude Code 有

| 工具 | 说明 |
|------|------|
| LSP | Language Server 代码智能 |
| EnterPlanMode / ExitPlanMode | 规划模式切换 |
| EnterWorktree / ExitWorktree | Git Worktree 隔离 |
| CronCreate/Delete/List | 定时任务调度 |
| PushNotification | 桌面/移动推送通知 |
| AskUserQuestion | 结构化多选提问 |
| Skill | 技能系统调用 |
| NotebookEdit | Jupyter 编辑 |
| RemoteTrigger | 远程 Routine 触发 |

---

## 三、数量对比

| 类别 | Claude Code | Codex |
|------|-------------|-------|
| 内置工具总数 | ~38 个 | ~10 个核心工具 |
| 设计哲学 | 细粒度专用工具，避免 Shell 滥用 | 以 Shell + Apply Patch 为核心，其余为增强 |

---

## 四、核心设计差异总结

1. **Claude Code**：多专用工具 - 文件操作拆成 Read/Edit/Write/Glob/Grep 五个独立工具，强制模型用结构化方式操作，减少 Shell 副作用。
2. **Codex**：Shell 为中心 - 大部分文件操作通过 Shell 完成，只把 Apply Patch 独立出来做结构化编辑。
3. **Codex 多模态能力**：图片生成、Computer Use、Code Interpreter。
4. **Claude Code 协作能力**：团队多代理、任务管理、定时任务、规划模式。