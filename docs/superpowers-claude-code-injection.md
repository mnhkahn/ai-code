# Superpowers 如何"插装"进 Claude Code：插件、Hooks 与协议注入

Superpowers（`github.com/obra/superpowers`，219k stars）是当前最火的"AI 编码方法论框架"。它声称"装上后 Claude 就有了 Superpowers"，但**没有魔改 Claude Code 任何一行源码**。所有"插装"都走的是 Claude Code 官方的 Plugin + Hooks 扩展点。本文拆解它的注入机制、与原生 Skill 机制的差异，以及它在上下文压缩场景下的精妙设计。

---

## 一、TL;DR

**Superpowers = Claude Code 原生 Plugin 机制 + SessionStart Hook 注入一段强制性 Meta-Skill。**

技术上零外部依赖、零二进制劫持、不改 Claude Code 源码。杠杆点只有一个：把"用不用 skill"从 agent 的**自由裁量**变成**必须执行的工作流协议**。

---

## 二、三层结构

### 2.1 插件清单 `.claude-plugin/plugin.json`

```json
{
  "name": "superpowers",
  "description": "Core skills library for Claude Code: TDD, debugging, ...",
  "version": "5.1.0",
  ...
}
```

这只是声明"我是一个叫 superpowers 的插件"，让 Claude Code 在 `/plugin install` 时认识它。配套的 `.claude-plugin/marketplace.json` 把它登记到 marketplace，本质都是元数据。

### 2.2 Hook 注册 `hooks/hooks.json`

这是**真正的插装点**：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
            "async": false
          }
        ]
      }
    ]
  }
}
```

`async: false` 意味着 Claude Code **同步执行**这个命令，并把它 stdout 输出的 JSON 解析为 `additionalContext`，**拼接到新会话的 system prompt 里**。

`run-hook.cmd` 是个 polyglot 脚本：Windows 上是 cmd 块（找 Git Bash 调用），Unix 上是 bash 块（直接 exec）。这样同一个 `session-start` 脚本跨平台。

### 2.3 注入内容 `hooks/session-start`

bash 脚本核心逻辑：

1. 读 `skills/using-superpowers/SKILL.md` 全文；
2. bash 参数替换做 JSON 转义（`${s//\\/\\\\}` 这种，避开 bash 5.3 heredoc hang 的 bug）；
3. 套上 `<EXTREMELY_IMPORTANT>` 标签；
4. 按当前宿主输出对应字段名（Claude Code / Cursor / Copilot CLI 各家协议不同）；
5. 退出 0。

最终注入到 system prompt 的内容长这样（简化）：

```xml
<EXTREMELY_IMPORTANT>
You have superpowers.

**Below is the full content of your 'superpowers:using-superpowers' skill...**

[skills/using-superpowers/SKILL.md 全文]

</EXTREMELY_IMPORTANT>
```

---

## 三、与默认 Skill 加载的本质差异

Claude Code 原生就有 Skill 机制：把 `SKILL.md` 放到 `~/.claude/skills/` 或 `.claude/skills/`，自动注册到 `Skill` 工具的可用列表。那 Superpowers 到底改了什么？

### 3.1 默认是"能力暴露"，Superpowers 是"行为约束"

| 维度 | Claude Code 原生 | Superpowers |
|---|---|---|
| Skill 注册 | 工具列表中可见 | 工具列表中可见 |
| 加载决策方 | **Agent 自主判断** | **强制**：1% 相关就加载 |
| 元规则加载 | 无（无法加载，因为没人告诉 agent 必须加载） | SessionStart 注入，绕开 agent 决策 |
| 对抗偷懒 | 无 | 显式反合理化清单 |
| 流程定义 | 自由 | 状态机式流程图 |
| 优先级 | 默认行为为最高 | 显式压过默认系统 prompt |

### 3.2 元规则免疫的精妙设计

`using-superpowers` 这条 skill 自己**不是通过 Skill 工具加载的**——如果它走 Skill 工具，就会陷入"agent 觉得不需要就不加载"的死结。

它走的是 `SessionStart` Hook → `additionalContext` → 直接进 system prompt。所以"强制检查并加载 skill"这条规则本身**是被强制注入的**，免疫于它自己所对抗的"agent 自由裁量"问题。

### 3.3 反合理化（Anti-Rationalization）武器

`using-superpowers` skill 里的核心话术：

> **IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.**
>
> This is not negotiable. This is not optional. You cannot rationalize your way out of this.

并附带流程图：

```
用户消息 → "有没有 skill 可能相关？" → 是（哪怕 1%）→ 必须先调 Skill 工具 → 才能回复
```

以及 Red Flags 清单，明确把以下念头标记为**正在合理化 = 必须停下来**：

- "这任务简单，跳过流程"
- "用户赶时间"
- "我直接写代码更快"
- "这个 skill 不完全适用"

这是从 CBT（认知行为疗法）借来的行为干预技术，针对 LLM "急于产出答案"的默认倾向。**不是告诉 agent 怎么做，而是堵死它逃避的借口。**

### 3.4 优先级覆盖

skill 文本里有一句关键声明：

> Superpowers skills override default system prompt behavior, but user instructions always take precedence

意思是：当 Superpowers 与 Claude Code 默认的"快速帮用户"倾向冲突时，**Superpowers 赢**。这等于在 system prompt 内部立了一个"宪法层"。

---

## 四、最精妙的一招：抗上下文压缩

`hooks.json` 的 matcher 是 `startup|clear|compact`，**包括 `compact`**。

这意味着：

### 4.1 默认行为下的脆弱性

默认机制里，Skill 工具的返回值（skill 全文）会变成**普通对话内容**进入上下文。当上下文撑爆触发自动 compact 时，这些 skill 文本**会一起被压缩掉**——时间一长，agent 就"忘了还有 TDD 这回事"。

### 4.2 Superpowers 的解法

SessionStart Hook 在每次 compact 之后**重新跑一次**，把 `using-superpowers` 全文连同反合理化清单**重新注入到 system prompt**。

```
compact 触发
   ↓
Hook 重跑
   ↓
"你必须用 skill" 协议重新进入 system prompt
   ↓
Agent 重新获得"先检查 skill"的约束
   ↓
Agent 通过 Skill 工具按需重新加载具体的 TDD / brainstorming 等
```

效果是**"协议持久 + 内容按需重拉"**：

- **元规则**（"1% 相关就用 skill"）→ durable，compact 后自动恢复
- **单个技能**（TDD / brainstorming）→ 仍然按需加载，但被元规则保护，会被自动重新调出来

简单说：默认是"skill 内容活在对话历史里、随压缩蒸发"；Superpowers 是"提醒器活在系统提示里、每次压缩后自动刷新"。

---

## 五、抽象出来的设计模式

Superpowers 展示了一套可复用的"在不修改 LLM 宿主的前提下改变 agent 行为"的设计模式：

### 5.1 三层插装模型

```
┌──────────────────────────────────────────────┐
│ 1. 插件清单（plugin.json）                      │
│    → 让宿主认识你                              │
├──────────────────────────────────────────────┤
│ 2. 生命周期 Hook（hooks.json）                 │
│    → 选择在哪个时机插装（startup/compact/...）  │
├──────────────────────────────────────────────┤
│ 3. 协议注入（session-start 脚本）               │
│    → 注入的文本里包含：                         │
│       - 强制规则（"必须 X"）                    │
│       - 状态机流程图（"先 A 再 B"）              │
│       - 反合理化清单（"这些念头都是借口"）       │
│       - 优先级声明（"我覆盖默认行为"）            │
└──────────────────────────────────────────────┘
```

### 5.2 关键设计原则

1. **元规则不能依赖自己**——bootstrap 规则必须由系统级机制（Hook）直接注入，不能走 agent 自主决策的路径，否则陷入递归。

2. **抗压缩是必修课**——任何"agent 行为约束"如果不能扛住上下文压缩，撑不过一个长 session 就失效。匹配 `compact` matcher 是必备。

3. **协议比工具有效**——光给 agent 工具（Skill 工具）不够，必须配套硬性协议（"必须调"）和反合理化（"不许找借口不调"）。

4. **跨平台 polyglot**——Hook 脚本是 polyglot（`run-hook.cmd` 同一个文件 Windows cmd 块 + Unix bash 块），保证 Claude Code / Cursor / Copilot CLI 等不同宿主都能跑。

5. **行为杠杆在文本里**——Superpowers 90% 的代码是 Markdown 文本。"插装"本质是 prompt engineering 在系统提示层面的工程化版本。

---

## 六、对我们自己的启示

如果想给 opencode / Claude Code / Codex 等编码 agent 增强行为约束，可以直接复用这个模式：

| 需求 | 复用 Superpowers 的哪一层 |
|---|---|
| 注册自定义 skill | `plugin.json` + `skills/` 目录 |
| 强制 agent 走某流程 | SessionStart Hook + 注入流程图 |
| 抗上下文压缩 | matcher 加 `compact` |
| 堵住 agent 偷懒 | 注入反合理化清单 |
| 跨平台兼容 | polyglot Hook 脚本 |

**核心洞察**：LLM 是不可靠的"自由 agent"，把它变成"流程合规 agent"不需要 hack 宿主，只需要在**正确的时机**向 system prompt 注入**正确的协议文本**。Superpowers 把这件事做到了极致。
