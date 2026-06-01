# 会话历史与记忆系统

Claude Code 有两套独立的数据持久化机制：**会话历史（Session History）** 和 **记忆（Memory）**。它们维度不同、用途不同、生命周期不同，但通过"提取"和"整理"两条管线连接在一起。

---

## 一、核心区别

| 维度 | 会话历史 | 记忆 |
|---|---|---|
| **维度** | 会话（Session） | 项目（Project） |
| **存储内容** | 完整对话记录（用户消息、助手回复、工具调用、系统消息） | 提炼后的决策摘要、用户偏好、项目事实 |
| **存储格式** | JSONL（每行一条 Entry） | Markdown（带 frontmatter） |
| **存储路径** | `~/.claude/projects/<cwd-hash>/<sessionId>.jsonl` | `~/.claude/projects/<git-root>/memory/` |
| **生命周期** | 随会话创建，会话结束后不变 | 跨会话累积，定期整理压缩 |
| **用途** | 会话恢复、统计、记忆提取的原始素材 | 新会话的上下文注入，避免从零开始 |
| **能否直接注入上下文** | 否（太大，需压缩后才能用） | 是（MEMORY.md 自动加载 + 按需检索） |

关键点：**会话历史是会话维度的**——每个 JSONL 文件对应一次会话；**记忆是项目维度的**——同一个 git 仓库的所有会话共享同一份 memory 目录。路径中的 `<cwd-hash>` 是工作目录的哈希，而 memory 路径中的 `<git-root>` 是 git 仓库的规范路径（`findCanonicalGitRoot`），同一仓库的所有 worktree 共享一份记忆。

---

## 二、会话历史

### 2.1 存储结构

```
~/.claude/projects/
├── -Users-bytedance-code-myapp/     ← <cwd-hash>
│   ├── a1b2c3d4.jsonl              ← 会话 1
│   ├── e5f6g7h8.jsonl              ← 会话 2
│   └── e5f6g7h8/
│       └── subagents/
│           └── agent-x9y8.jsonl    ← 子代理记录
└── -Users-bytedance-code-other/
    └── ...
```

### 2.2 JSONL Entry 类型

每行是一个 JSON 对象，`type` 字段区分种类：

| type | 说明 |
|---|---|
| `user` | 用户消息 |
| `assistant` | 助手回复（含 tool_use 块和 usage 信息） |
| `system` | 系统消息 |
| `attachment` | 附件消息 |
| `progress` | 进度消息 |
| `mode` | 模式切换 |
| `speculation-accept` | 推测接受（含 timeSavedMs） |
| `file-history-snapshot` | 文件历史快照 |
| `attribution-snapshot` | 归因快照 |

### 2.3 /insights 命令详解

`/insights` 是会话历史最强大的消费方式。它扫描所有会话 JSONL，提取结构化数据，调用 Opus 模型生成洞察，最终输出一个可交互的 HTML 报告。

#### 数据采集

从每个会话的 JSONL 中提取以下维度（`SessionMeta`）：

| 维度 | 说明 |
|---|---|
| 基础信息 | 会话 ID、项目路径、开始时间、持续时长 |
| 消息统计 | 用户消息数、助手消息数 |
| 工具使用 | 各工具调用次数（Bash、Edit、Read 等） |
| 语言分布 | 按文件扩展名统计操作的语言（TS、Go、Python 等） |
| Git 活动 | 提交次数、推送次数 |
| Token 消耗 | input_tokens、output_tokens |
| 代码变更 | 新增行数、删除行数、修改文件数 |
| 交互质量 | 用户中断次数、工具错误次数及分类、用户响应时间 |
| 高级特性 | 是否使用 Task Agent、MCP、Web Search、Web Fetch |
| 多会话并行 | 检测 multi-clauding（多会话重叠使用） |

#### AI 洞察生成

采集完成后，系统并行调用 Opus 模型生成 6-8 个洞察章节：

| 章节 | 内容 |
|---|---|
| **At a Glance** | 一句话总结：什么有效、什么阻碍、快速改进、进阶方向 |
| **What You Work On** | 项目领域分类（4-5 个），每个领域的会话数和描述 |
| **How You Use Claude Code** | 交互风格分析（迭代式 vs 规划式、中断频率等） |
| **Impressive Things You Did** | 3 个高效工作流亮点 |
| **Where Things Go Wrong** | 3 个摩擦类别，每类 2 个具体案例 |
| **Features to Try** | CLAUDE.md 建议添加项 + 推荐尝试的 CC 特性（MCP/Skills/Hooks/Headless/Task Agents）+ 使用模式建议 |
| **On the Horizon** | 3 个进阶自动化机会（并行代理、自主工作流等） |
| **Fun Ending** | 会话中有趣/令人印象深刻的瞬间 |

Ant 内部用户额外生成：CC 团队改进建议、模型行为改进建议。

#### HTML 报告

所有洞察渲染为一个自包含的 HTML 文件，包含：

- **概览卡片**：会话数、消息数、时长、提交数
- **At a Glance**：四象限快速摘要，链接到对应章节
- **项目领域**：按工作领域分类的会话统计
- **交互风格**：叙述式分析 + 关键模式提炼
- **图表**：每日活动热力图、语言分布、工具使用分布、每日 Token 消耗、一天中活跃时段
- **代码变更统计**：总新增行数、总删除行数、修改文件数
- **洞察章节**：上述 AI 生成的各章节

#### 使用方式

```
/insights              # 分析本地所有会话
/insights --homespaces # Ant 内部：同时采集远程 homespace 的会话
```

#### 实现架构

```
/insights 触发
  │
  ├─ 1. 数据采集
  │     扫描 ~/.claude/projects/ 下所有 JSONL
  │     → 提取 SessionMeta（工具计数、语言、Token、代码行变更等）
  │     → 提取 SessionFacets（Opus 分析每个会话的目标/结果/满意度）
  │
  ├─ 2. 数据聚合
  │     aggregateData() → AggregatedData
  │     汇总所有会话的统计 + 检测 multi-clauding
  │
  ├─ 3. 并行洞察生成
  │     6-8 个 Opus 调用并行执行
  │     每个调用传入聚合数据 + 会话摘要列表
  │     → 返回结构化 JSON（project_areas / interaction_style / what_works / ...）
  │
  ├─ 4. HTML 渲染
  │     generateHtmlReport(data, insights)
  │     → 自包含 HTML（内联 CSS + 图表）
  │     → 保存到临时文件
  │
  └─ 5. 输出
        本地用户：file:// URL
        Ant 内部：上传 S3 → 返回 HTTPS URL
```

### 2.4 /cost 命令详解

`/cost` 显示**当前会话**的模型调用详情和费用。`/insights` 是跨会话的宏观分析，但缺少按模型拆分的调用细节；`/cost` 正好补上这个缺口。

#### 输出示例

```
Total cost:            $1.2345
Total duration (API):  5m 30s
Total duration (wall): 12m 15s
Total code changes:    150 lines added, 30 lines removed
Usage by model:
        claude-sonnet-4:  50,000 input, 8,000 output, 30,000 cache read, 5,000 cache write ($0.45)
     claude-opus-4:  20,000 input, 3,000 output, 10,000 cache read, 2,000 cache write ($0.78)
```

#### 数据来源

`/cost` 的数据来自内存中的实时累计（`cost-tracker.ts`），不是从 JSONL 重新解析。每次 API 调用返回后，`addToTotalModelUsage()` 即时更新计数器。因此 `/cost` 只反映当前会话，不含历史会话。

#### 按模型拆分的维度

| 维度 | 说明 |
|---|---|
| input tokens | 输入 Token 数 |
| output tokens | 输出 Token 数 |
| cache read tokens | 命中缓存的 Token 数 |
| cache write tokens | 写入缓存的 Token 数 |
| web search requests | Web 搜索请求数 |
| cost USD | 该模型的费用 |

模型名会自动归并为短名（如 `claude-sonnet-4-20250514` → `claude-sonnet-4`）。

#### 与 /insights 的互补

| | /insights | /cost |
|---|---|---|
| 范围 | 跨会话（全部历史） | 当前会话 |
| 模型拆分 | 仅 input/output tokens 总量 | 按模型拆分 Token + 费用 |
| 代码行变更 | 总新增/删除行数 | 总新增/删除行数 |
| API 耗时 | 无 | 有（API 时间 + 墙钟时间） |
| 输出格式 | HTML 报告 | 终端文本 |

### 2.5 如何查询当前项目的会话

#### 用户命令

| 命令 | 作用 |
|---|---|
| `/resume` | 列出当前项目（及 git worktree）的历史会话，可选择恢复 |
| `/resume <关键词>` | 按自定义标题或会话 ID 搜索匹配的会话 |

`/resume` 展示的每个会话包含：会话 ID、摘要（customTitle > aiTitle > lastPrompt > firstPrompt）、最后修改时间、git 分支、标签。

#### 程序化查询（SDK）

`listSessionsImpl()` 提供会话列表查询能力（`src/utils/listSessionsImpl.ts`）：

```typescript
type SessionInfo = {
  sessionId: string
  summary: string          // 摘要：customTitle > aiTitle > lastPrompt > firstPrompt
  lastModified: number     // 最后修改时间（epoch ms）
  fileSize?: number
  customTitle?: string     // 用户自定义标题
  firstPrompt?: string     // 会话第一条用户消息
  gitBranch?: string       // git 分支
  cwd?: string             // 工作目录
  tag?: string             // 会话标签
  createdAt?: number       // 创建时间（epoch ms）
}

// 查询当前项目的会话
listSessionsImpl({ dir: '/path/to/project', limit: 20 })

// 查询所有项目的会话
listSessionsImpl({ limit: 50 })
```

#### 性能优化

会话列表不需要完整解析 JSONL。系统采用**轻量读取策略**：

1. **stat 阶段**：仅 `stat()` 获取 mtime，按时间排序，跳过不需要的文件
2. **head/tail 阶段**：对候选文件只读头部 64KB + 尾部 64KB（`readSessionLite`），从中提取 `customTitle`、`aiTitle`、`lastPrompt`、`summary`、`gitBranch`、`tag` 等字段
3. **分页**：`limit` + `offset` 参数控制，有 limit 时先 stat 排序再读内容，避免读取全部文件

这意味着查询 1000 个会话只需 ~1000 次 stat + ~20 次部分文件读取（limit=20 时），而非 1000 次完整文件解析。

#### 会话摘要的来源

`summary` 字段的优先级：`customTitle` > `aiTitle` > `lastPrompt` > `firstPrompt`。其中 `customTitle` 和 `aiTitle` 是会话过程中写入的标题条目，`lastPrompt` 是最后一条用户消息，`firstPrompt` 是第一条用户消息。这些信息都从 JSONL 的 head/tail 中直接提取，无需完整解析。

---

## 三、记忆（Memory）

### 3.1 存储结构

```
~/.claude/projects/<git-root>/memory/
├── MEMORY.md              ← 入口索引（≤200行/25KB，自动加载到 system prompt）
├── user_role.md           ← 用户记忆
├── feedback_testing.md    ← 反馈记忆
├── project_goals.md       ← 项目记忆
├── reference_links.md     ← 引用记忆
├── team/                  ← Team Memory（需 feature flag）
│   ├── MEMORY.md
│   └── coding_std.md
└── logs/                  ← 助手模式日志（KAIROS feature flag）
    └── 2026/
        └── 06/
            └── 2026-06-01.md
```

### 3.2 记忆类型

四种类型，每种有明确的保存时机和使用方式：

| 类型 | 作用域 | 保存什么 | 示例 |
|---|---|---|---|
| `user` | 始终私有 | 用户角色、偏好、知识背景 | "用户是数据科学家，关注可观测性" |
| `feedback` | 默认私有 | 用户对工作方式的纠正和确认 | "不要 mock 数据库，之前出过事故" |
| `project` | 偏向团队 | 项目目标、决策、进度（不可从代码推导的） | "合并冻结从 2026-03-05 开始" |
| `reference` | 通常团队 | 外部系统指针 | "pipeline bug 在 Linear 项目 INGEST 中" |

### 3.3 记忆文件格式

```markdown
---
name: 用户偏好
description: 用户的工作偏好和纠正
type: feedback
---

不要 mock 数据库——上次 mock 通过但生产迁移失败了。

**Why:** 2026 Q1 事故，mock/prod 不一致掩盖了迁移 bug
**How to apply:** 集成测试必须连真实数据库
```

### 3.4 什么不该存为记忆

- 代码模式、架构、文件结构——可以从代码推导
- Git 历史——`git log` 是权威来源
- 调试方案——修复已在代码中，上下文在 commit message
- CLAUDE.md 已有的内容
- 临时任务细节、当前对话上下文

### 3.5 记忆的检索

新会话启动时，记忆通过两条路径注入上下文：

1. **自动加载**：`MEMORY.md` 作为 system prompt 的一部分始终注入（≤200行/25KB）
2. **按需检索**：`findRelevantMemories()` → 扫描所有记忆文件的 frontmatter → Sonnet 模型做相关性选择（最多 5 个）→ 作为 Attachment 注入

检索流程：
```
用户输入
  → scanMemoryFiles() 扫描 memory/ 目录
  → 提取每个文件的 name + description frontmatter
  → sideQuery(Sonnet) 做相关性打分
  → 返回最多 5 个最相关的文件路径
  → 读取文件内容，注入到上下文
```

>1 天前的记忆会自动附加过期警告，系统提示指导模型"推荐前验证"。

---

## 四、记忆是怎么被生成的

记忆有**两条生成路径**，互斥运行：

### 路径一：主代理直接写入

主代理的 system prompt 中包含完整的记忆保存指令。当对话中出现值得记忆的信息时，主代理直接调用 Write/Edit 工具写入 memory 目录。

**特点**：
- 实时性强——信息出现时立即保存
- 无额外 token 消耗——在主对话中完成
- 写入后，后台提取代理会跳过该轮（`hasMemoryWritesSince` 检测）

### 路径二：Archivist 后台提取代理

当主代理**没有**主动写入记忆时，系统在每轮对话结束后自动 fork 一个后台代理（Archivist）来提取记忆。

#### 触发条件

```
每轮对话结束（handleStopHooks）
  → 检查：是否主代理？是
  → 检查：feature flag tengu_passport_quail 是否开启？是
  → 检查：autoMemory 是否启用？是
  → 检查：是否远程模式？否
  → 检查：主代理本轮是否已写入记忆？否
  → 检查：节流门控（tengu_bramble_lintel，默认每 1 轮触发一次）
  → 全部通过 → 启动 Archivist
```

#### 执行流程

```
┌─────────────────────────────────────────────────────┐
│ 1. 计算增量消息数                                      │
│    countModelVisibleMessagesSince(lastMemoryMessageUuid) │
│    只处理上次提取后的新增消息                              │
├─────────────────────────────────────────────────────┤
│ 2. 预扫描现有记忆                                      │
│    scanMemoryFiles() → formatMemoryManifest()         │
│    注入到 prompt 中，避免重复创建                         │
├─────────────────────────────────────────────────────┤
│ 3. Fork 后台代理                                      │
│    runForkedAgent({                                   │
│      promptMessages: [提取指令],                        │
│      forkLabel: 'extract_memories',                   │
│      maxTurns: 5,          ← 硬性上限                  │
│      canUseTool: 严格权限控制,                          │
│      skipTranscript: true  ← 不写入会话历史              │
│    })                                                 │
├─────────────────────────────────────────────────────┤
│ 4. Archivist 执行（2-4 轮）                            │
│    Turn 1: Read 所有可能更新的记忆文件（并行）             │
│    Turn 2: Write/Edit 写入新记忆 + 更新 MEMORY.md       │
├─────────────────────────────────────────────────────┤
│ 5. 推进游标                                           │
│    lastMemoryMessageUuid = 最后一条消息的 UUID           │
│    下次提取只看增量消息                                  │
├─────────────────────────────────────────────────────┤
│ 6. 通知主线程                                          │
│    如果写入了记忆文件 → appendSystemMessage()             │
│    用户看到 "Saved N memories" 提示                     │
└─────────────────────────────────────────────────────┘
```

#### 权限隔离

Archivist 的工具权限被严格限制：

| 工具 | 权限 |
|---|---|
| Read / Grep / Glob | 无限制（只读） |
| Bash | 仅只读命令（ls/find/grep/cat/stat/wc/head/tail） |
| Edit / Write | 仅 memory 目录内的路径 |
| 其他所有工具 | 拒绝（Agent、MCP 等） |

#### 并发控制

- **互斥锁**：`inProgress` 标志防止重叠运行
- **游标机制**：`lastMemoryMessageUuid` 确保每条消息只被处理一次
- **尾随提取**：如果提取进行中又有新消息，stash 上下文，当前提取完成后自动运行一次尾随提取
- **主代理优先**：如果主代理本轮已写入记忆，Archivist 跳过该轮并推进游标

#### 与主代理的缓存共享

Archivist 通过 `createCacheSafeParams()` 与主代理共享 prompt cache——相同的 system prompt、相同的 tools、相同的消息前缀。这意味着 Archivist 的 API 调用大部分 token 命中缓存，成本远低于全新请求。

---

## 五、记忆的整理：Dream

记忆会随时间积累、过时、重复。`autoDream` 服务定期整理记忆，保持记忆库的精炼和准确。

### 5.1 触发条件

```
每轮对话结束（handleStopHooks）
  → 时间门控：距上次整理 ≥ 24 小时
  → 会话门控：上次整理后有 ≥ 5 个新会话
  → 锁检查：无其他进程正在整理
  → 全部通过 → 启动 Dream
```

### 5.2 整理流程（4 阶段）

```
┌──────────────────────────────────────────────────────┐
│ Phase 1 — Orient（定位）                               │
│   ls memory 目录，读取 MEMORY.md 索引                    │
│   浏览现有主题文件，了解当前记忆结构                       │
├──────────────────────────────────────────────────────┤
│ Phase 2 — Gather（收集信号）                            │
│   1. 日志文件（logs/YYYY/MM/YYYY-MM-DD.md）             │
│   2. 与代码现状矛盾的记忆                                │
│   3. 必要时 grep 会话 JSONL 获取特定上下文               │
├──────────────────────────────────────────────────────┤
│ Phase 3 — Consolidate（整合）                           │
│   合并新信号到现有主题文件（而非创建重复文件）              │
│   将相对日期转为绝对日期                                 │
│   删除已被推翻的事实                                    │
├──────────────────────────────────────────────────────┤
│ Phase 4 — Prune & Index（修剪与索引）                    │
│   更新 MEMORY.md：≤200行/25KB                          │
│   删除过时/错误/被取代的指针                              │
│   添加新重要的指针                                      │
│   解决矛盾：两个文件不一致时修正错误的那个                  │
└──────────────────────────────────────────────────────┘
```

### 5.3 Dream 的权限

与 Archivist 相同的权限隔离——只读 Bash + 仅 memory 目录内可写。Dream 同样通过 `runForkedAgent()` 运行，共享 prompt cache。

### 5.4 Dream 与 Archivist 的关系

| | Archivist | Dream |
|---|---|---|
| **做什么** | 从对话中提取新记忆 | 整理、合并、修剪已有记忆 |
| **触发频率** | 每轮对话（节流后） | 每 24h + 5 个新会话 |
| **输入** | 当前对话的消息 | memory 目录 + 会话 JSONL |
| **输出** | 新的记忆文件 | 更新/合并/删除记忆文件 |
| **forkLabel** | `extract_memories` | `auto_dream` |

---

## 六、全链路：从对话到记忆到检索

```
用户与 Claude 对话
  │
  ├─ 主代理直接写入记忆？──── 是 ──→ 写入 memory/ 目录
  │                                      │
  │                                      ▼
  │                                 推进游标，跳过 Archivist
  │
  └─ 主代理未写入 ──→ Archivist 后台提取
                        │
                        ▼
                   写入 memory/ 目录
                        │
                        ▼
              ┌──── 积累 ────┐
              │               │
              ▼               ▼
         24h + 5会话      用户手动 /dream
              │               │
              ▼               ▼
           autoDream 整理（合并、去重、修剪、更新索引）
              │
              ▼
         精炼的记忆库
              │
              ▼
    ┌── 新会话启动 ──┐
    │                 │
    ▼                 ▼
  MEMORY.md        findRelevantMemories()
  自动加载          Sonnet 选最多 5 条
  (≤200行)         按需注入
    │                 │
    └────┬────────────┘
         ▼
    代理基于历史知识工作
```

