# Claude Code 项目：模型返回数据处理全链路分析

> 分析日期：2026-06-04

---

## 一、整体架构概览

模型调用返回数据的处理分为以下几个核心层级：

```
Anthropic API (SSE Stream)
│   底层 HTTP SSE 连接，返回 delta 碎片事件流
│   src/services/api/claude.ts (SDK 调用处)
│
├── yield stream_event ──→ UI 层 (Ink/React CLI)
│   每收到一个 delta 立即推送，实现"逐字打出"效果
│
↓
withRetry (重试/降级层)
│   src/services/api/withRetry.ts:170
│   最多重试 10 次，指数退避：min(500ms×2^(n-1), 32s) + 随机抖动(0~25%)
│   有 Retry-After header 时优先使用其值
│   错误分类处理：
│     529 过载 → 前台最多 3 次后触发模型降级，后台直接放弃
│     429 限流 → fast mode 短延迟继续重试，长延迟(>20s)切标准模式
│     401 认证 → 刷新 OAuth token / 清 API key 缓存后重试
│     400 上下文溢出 → 解析错误中的 token 数，自动缩小 max_tokens 重试
│     5xx / 408 / 409 → 直接重试
│     ECONNRESET → 禁用 keep-alive 重建连接后重试
│   无人值守模式(CLAUDE_CODE_UNATTENDED_RETRY)：429/529 无限重试，
│     最大退避 5min，总上限 6h，每 30s yield 心跳保活
│
↓
queryModel (流式事件累积层)
│   src/services/api/claude.ts:1017
│   逐个接收 SSE delta 碎片，拼接为完整内容块：
│     text_delta       → contentBlock.text += delta.text
│     input_json_delta → contentBlock.input += delta.partial_json
│     thinking_delta   → contentBlock.thinking += delta.thinking
│   双通道输出：
│     ① 实时 yield stream_event → UI 渲染（不阻塞）
│     ② 流结束后 yield AssistantMessage → 交给下层（阻塞，等拼完才给）
│
↓
normalizeContentFromAPI (内容规范化)
│   src/utils/messages.ts:2651
│   将 tool_use.input 从 JSON 字符串 → 解析为对象
│   处理双重编码、空值降级为 {}、解析失败容错
│   同步调用，无阻塞
│
↓
queryLoop (对话循环/工具执行)
│   src/query.ts:241
│   核心 Agent 循环：
│     1. 等待完整 AssistantMessage
│     2. 判断 stop_reason：
│        - end_turn → 结束循环
│        - tool_use → 执行工具 → 构造 tool_result → 回到步骤 1
│     3. 管理 token budget、auto-compact、max turns
│
↓
QueryEngine (会话状态管理)
│   src/QueryEngine.ts:184
│   顶层入口（SDK/无头模式）：
│     - 消息列表持久化（写入 session JSONL）
│     - usage 统计、权限管理、file cache
│     - session compact（长会话裁剪）
│     - 每个对话一个实例，状态跨轮次保持
```

**为什么工具执行要等流结束？** tool_use 的 JSON input 是通过 `input_json_delta` 碎片式传输的，只有全部拼完才能 `JSON.parse` 并执行——所以 UI 不阻塞（边收边渲染），但 queryLoop 必须等完整消息。

---

## 二、返回数据的原始格式

项目使用 **Anthropic Beta Messages API** 的流式接口，返回的是 SSE (Server-Sent Events) 流。每个事件类型如下：

| 事件类型 | 作用 | 关键字段 |
|---------|------|---------|
| `message_start` | 初始化消息 | `message.id`, `message.model`, `message.usage`, `message.role` |
| `content_block_start` | 开始一个内容块 | `index`, `content_block.type`, `content_block.id` |
| `content_block_delta` | 增量更新内容块 | `index`, `delta.type` + 各种 delta 内容 |
| `content_block_stop` | 结束一个内容块 | `index` |
| `message_delta` | 消息级元数据更新 | `delta.stop_reason`, `usage` |
| `message_stop` | 消息结束 | — |

### Delta 类型详细分类

`content_block_delta` 中的 `delta.type` 有以下几种：

| delta.type | 适用内容块 | 含义 |
|------------|-----------|------|
| `text_delta` | text | 文本增量 |
| `input_json_delta` | tool_use / server_tool_use | 工具调用 JSON 增量 |
| `thinking_delta` | thinking | 思考内容增量 |
| `signature_delta` | thinking / connector_text | 签名增量 |
| `connector_text_delta` | connector_text | 连接器文本增量（feature flag 控制）|
| `citations_delta` | — | 引用增量（TODO：暂不处理）|

---

## 三、流式事件累积逻辑

在 `queryModel` 函数中，逐事件处理：

### 3.1 `message_start` — 初始化

- 保存部分消息作为后续模板（`partialMessage = part.message`）
- 记录首字节时间 TTFT（Time To First Token）
- 初始化 usage（`usage = updateUsage(usage, part.message?.usage)`）
- 内部特判：捕获 research 字段（仅 ant 内部用户）

### 3.2 `content_block_start` — 创建空内容块

根据 `content_block.type` 做不同初始化：

**关键特判逻辑**：

1. **text 初始化为空字符串**：SDK 的 bug 会在 `content_block_start` 返回 text 内容，然后在 `content_block_delta` 再次返回，所以强制清零
2. **thinking 的 signature 初始化为空字符串**：确保字段始终存在，即使 API 不发送 `signature_delta`
3. **tool_use 的 input 初始化为空字符串**：因为 API 使用 `input_json_delta` 增量推送 JSON 片段
4. **浅拷贝而非直接引用**：SDK 会就地突变 content block 对象，我们需要不可变性来自行累积状态
5. **server_tool_use 特判**：检测 advisor 工具调用，设置 `isAdvisorInProgress` 标记
6. **advisor_tool_result 检测**：在 default 分支中检测，清除 `isAdvisorInProgress` 标记

### 3.3 `content_block_delta` — 增量拼接

**关键特判逻辑**：

1. **`input_json_delta` 时 input 必须是 string**：流式模式下 input 是字符串拼接，但非流式降级时可能是对象，所以做类型检查
2. **`signature_delta` 是赋值而非拼接**：签名是整体替换的，不是增量拼接
3. **`connector_text_delta`** 是 feature flag 控制的实验性功能
4. 每种 delta 都有 **严格的类型守卫**：如果 content_block 类型不匹配，会记录 analytics 事件并抛错
5. **缺块的容错**：如果 delta 到达时对应的 contentBlock 不存在（流损坏），直接抛出 `RangeError`
6. **connector_text 的 signature_delta**：connector_text 类型也可能有 signature_delta，同样是赋值而非拼接

各 delta 类型的处理方式：
- `text_delta`：拼接文本（`contentBlock.text += delta.text`）
- `input_json_delta`：拼接 JSON 片段（`contentBlock.input += delta.partial_json`）
- `thinking_delta`：拼接思考内容（`contentBlock.thinking += delta.thinking`）
- `signature_delta`：整体赋值签名（`contentBlock.signature = delta.signature`）
- `citations_delta`：暂不处理

### 3.4 `content_block_stop` — 产出完整消息

- 校验 contentBlock 和 partialMessage 必须存在
- 调用 `normalizeContentFromAPI` 对内容做规范化
- 构造 `AssistantMessage` 对象，包含 message、requestId、type、uuid、timestamp 等字段
- 内部特判：research 字段（仅 ant 用户）和 advisor 模型字段
- **立即 yield 产出**，实现流式输出

**注意**：每个 `content_block_stop` 都会产出一条 `AssistantMessage`，而不是等整个消息完成。这是实时流式输出的关键——用户可以在消息未完全生成时就看到部分内容。

### 3.5 `message_delta` — 更新最终元数据

- 更新 usage 和 stop_reason
- **关键：回写 usage 和 stop_reason 到已产出的最后一条消息**
- 因为 content_block_stop 时产出的消息用的是 partialMessage（此时 output_tokens=0, stop_reason=null），message_delta 在 content_block_stop 之后到达，包含真实的值
- **必须使用直接属性突变**（`lastMsg.message.usage = usage`），而不是对象替换（`{ ...lastMsg.message, usage }`），因为 transcript 写队列持有的是旧对象的引用，替换会导致引用断开

**特殊 stop_reason 处理**：

- `max_tokens`：yield 错误消息，提示超出输出 token 上限，触发自动续写恢复
- `model_context_window_exceeded`：复用 max_output_tokens 恢复路径，提示达到上下文窗口限制
- 拒绝（refusal）检测：通过 `getErrorMessageIfRefusal` 检查并 yield 相应错误消息

**时序重点**：

```
message_start → (content_block_start → deltas → content_block_stop)×N → message_delta → message_stop
                     ↑ 这里 yield AssistantMessage（usage=null）           ↑ 这里回写真实 usage/stop_reason
```

---

## 四、内容规范化 — `normalizeContentFromAPI`

当内容块从 API 返回后，经过 `normalizeContentFromAPI` 做后处理：

### 4.1 tool_use 输入解析

- 输入可能是字符串（流式）或对象（非流式降级）
- 流式模式下拼接的 JSON 字符串通过 `safeParseJSON` 解析
- **JSON 解析失败的容错**：空字符串解析结果为 `null`，降级为 `{}`；非空字符串解析失败也降级为 `{}`，同时记录 analytics
- ant 内部用户额外记录 debug 日志（前 200 字符）
- **工具特定修正**：通过 `normalizeToolInput` 对不同工具的输入做额外规范化，归一化失败则保留原始输入

### 4.2 其他类型处理

- **text**：空白文本记录 analytics 但不修改内容（保留精确内容用于 prompt caching），空文本块由展示层处理
- **server_tool_use**：input 也可能需要 JSON 解析（同 tool_use 的字符串→对象逻辑）
- **code_execution_tool_result / mcp_tool_use / mcp_tool_result / container_upload**：Beta 专属内容块，直接透传
- **未知类型**：直接透传

---

## 五、Usage 统计的兼容逻辑 — `updateUsage`

`updateUsage` 函数处理了 Anthropic 流式 API 的一个重要特性：

> **流式 API 提供的是累积值，不是增量值**。但 `message_delta` 可能发送 0 值覆盖 `message_start` 中的真实值。

**核心兼容策略**：

| 字段类型 | 更新策略 | 原因 |
|---------|---------|------|
| input_tokens | `> 0` 守卫 | message_delta 可能发 0 覆盖真实值 |
| cache_*_input_tokens | `> 0` 守卫 | 同上 |
| output_tokens | `??` 守卫 | 允许 0 值（合法：消息刚开始时输出 token 可以为 0）|
| cache_creation 子字段 | `as BetaUsage` 强制转换 | SDK 类型定义缺失 |
| cache_deleted_input_tokens | feature flag 控制 | 仅内部构建包含，避免字段名泄露到外部 |

---

## 六、错误处理与降级逻辑

### 6.1 流式→非流式降级

当流式请求失败时，自动降级为非流式请求。触发条件有三类：

**1) 流处理异常（非用户中止）**

- 如果是 `APIUserAbortError` 且用户按了 ESC → 真正的用户中止，向上抛出
- 如果是 `APIUserAbortError` 但用户没按 ESC → SDK 内部超时，转为 `APIConnectionTimeoutError`
- 其他异常 → 降级到非流式

**2) 流 idle 超时（watchdog 机制）**

- 默认 90 秒内没有收到任何流式事件，主动中止流并触发降级（可通过环境变量 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 配置）
- 两级告警：先 warning（45s），再 abort（90s）

**3) 流创建时 404**

- 部分网关不支持流式端点，返回 404
- 在 v2.1.8 之前，404 在迭代时抛出（被内层 catch 处理）；现在使用 raw stream，404 在创建时抛出（被外层 catch 处理）

**降级流程**：调用 `executeNonStreamingRequest` 复用同一请求参数构建逻辑，降级后的消息构造与非流式一致。

### 6.2 空流检测

两种代理失败模式：
1. 没收到任何事件（`!partialMessage`）：代理返回 200 但内容不是 SSE
2. 收到部分事件但没有内容块完成且没有 stop_reason：流提前结束

**兼容特判**：structured output 场景下可能有合法的空响应（第一轮调 StructuredOutput tool，第二轮 end_turn 但无 content blocks），所以需要检查 `!stopReason`。

**为什么要检查 `!stopReason`**：在 structured output 模式下，第一轮模型调用 StructuredOutput 工具，第二轮以 `end_turn` 停止但没有内容块。这是合法的空响应，不应触发降级。

### 6.3 非流式请求的 token 限制调整

- 非流式请求有 10 分钟限制，SDK 的 21333-token 上限由此衍生
- 项目通过设置客户端超时绕过，允许更高的上限
- 最大非流式 token 数：64,000
- API 约束：`max_tokens` 必须大于 `thinking.budget_tokens`，如果启用了 thinking 且有 budget_tokens，需要确保 budget_tokens 至少比 max_tokens 少 1

### 6.4 APIUserAbortError 的双重语义

`APIUserAbortError` 可能来自两个不同的来源：
- 来源 1：用户按 ESC → 真正的用户中止 → 向上抛出
- 来源 2：SDK 内部超时 → 不是用户中止 → 转为 `APIConnectionTimeoutError`

---

## 七、重试策略（`withRetry`）

重试框架最大重试次数默认为 10 次。

### 7.1 错误分类与重试决策

| 错误场景 | HTTP 状态码 | 处理策略 |
|---------|-----------|---------|
| **服务过载** | 529 | 前台请求最多重试 3 次，然后触发模型降级；后台请求立即放弃 |
| **速率限制** | 429 | Fast mode 短延迟保持重试；长延迟切换标准模式；Enterprise 可重试 |
| **认证失败** | 401 | 刷新 OAuth token / 清除 API key 缓存，重新创建 client |
| **Token 吊销** | 403 + "revoked" | 同 401 处理 |
| **上下文溢出** | 400 | 解析错误消息中的 token 数，自动调整 max_tokens 重试 |
| **连接重置** | ECONNRESET/EPIPE | 禁用 keep-alive 并重建连接 |
| **Fast Mode 被拒** | 400 + "not enabled" | 永久禁用 fast mode 并以标准速度重试 |
| **Bedrock 认证** | 403/CredentialsProviderError | 清除 AWS 凭证缓存 |
| **Vertex 认证** | 401/"Could not refresh" | 清除 GCP 凭证缓存 |
| **服务器错误** | 5xx | 直接重试（ant 用户即使 x-should-retry:false 也重试 5xx）|
| **请求超时** | 408 | 重试 |
| **锁超时** | 409 | 重试 |

### 7.2 指数退避策略

- 基础延迟：`min(500ms * 2^(attempt-1), 32000ms)`
- 实际延迟：基础延迟 + 随机抖动（0~25% × 基础延迟），避免惊群效应
- 特殊情况：Retry-After header 存在时优先使用其值（秒 → 毫秒）
- 持久重试模式（CLAUDE_CODE_UNATTENDED_RETRY）：最大退避 5 分钟，总上限 6 小时

### 7.3 529 错误的特殊处理

**前台 vs 后台区分**：
- 前台（用户在等）：repl_main_thread, sdk, agent:*, compact, hook_agent 等 → 重试
- 后台（用户看不到）：标题生成、摘要、分类器等 → 立即放弃，避免容量雪崩放大

**连续 529 达到上限后**：
1. 如果有 fallbackModel → 抛出 FallbackTriggeredError，在 query.ts 中切换模型
2. 外部用户 → 抛出 CannotRetryError，显示友好的过载提示
3. ant 内部 + 持久重试 → 无限重试，每 30s yield 一个心跳消息

### 7.4 Fast Mode 重试策略

Fast mode 下的 429/529 有特殊处理：
1. 如果是因为 overage 被拒 → 永久禁用 fast mode，以标准速度重试
2. 短延迟（<20s）→ 保持 fast mode 重试，保留 prompt cache
3. 长延迟或未知 → 进入 cooldown，切换标准速度

### 7.5 上下文溢出自动调整

解析错误消息中的 token 数（格式: `"input length and max_tokens exceed context limit: 188059 + 20000 > 200000"`），然后：
- 计算 availableContext = contextLimit - inputTokens - safetyBuffer(1000)
- 如果 availableContext < 3000 → 太小无法恢复，抛出错误
- 否则调整 max_tokens = max(3000, availableContext, minRequired)
- minRequired 取决于是否启用 thinking（需要包含 budgetTokens）+ 1
- 继续重试，使用调整后的 max_tokens

### 7.6 持久重试（Unattended Retry）

适用于无人在场的自动化会话，特点：
- 429/529 无限重试
- 最大退避 5 分钟
- 窗口限制（5hr Max/Pro）使用 reset header 等到重置
- 每 30s yield 心跳消息，防止宿主环境判定会话空闲
- 总上限 6 小时

---

## 八、消息发送前的规范化 — `normalizeMessagesForAPI`

在发送消息给 API 之前，需要做反向规范化：

### 8.1 过滤与重排

1. **过滤虚拟消息**：`isVirtual` 标记的纯展示消息不发送到 API
2. **重排附件顺序**：tool_result 必须在附件前面（API 要求）
3. **过滤进度/系统消息**：`progress` 类型和大部分 `system` 类型消息不发送
4. **过滤合成错误消息**：`isSyntheticApiErrorMessage` 标记的消息不发送

### 8.2 媒体错误回溯剥离

如果之前的 API 调用返回了 PDF/图片过大的错误，需要回溯找到触发错误的用户消息，剥离其中的对应类型媒体块：

| 错误类型 | 剥离的媒体块类型 |
|---------|---------------|
| PDF 过大 | document |
| PDF 密码保护 | document |
| PDF 无效 | document |
| 图片过大 | image |
| 请求过大 | document, image |

### 8.3 消息合并

合并连续 user 消息 — Bedrock 不支持多个连续的 user 消息，如果上一条也是 user 消息，则合并为一条。

### 8.4 工具搜索字段处理

当 tool search 未启用时：
- 从 user 消息的 tool_result 中删除 `tool_reference` 块
- 从 assistant 消息的 tool_use 中删除 `caller` 字段
- 原因：API 不认识这些字段，会返回 400 错误

当 tool search 启用时：
- 仅删除不再存在的工具的 tool_reference（如 MCP 服务器断连）

### 8.5 工具配对修复

`ensureToolResultPairing`：修复远程/teleport 会话恢复时的配对问题：
- 孤立的 tool_use：插入合成的错误 tool_result
- 孤立的 tool_result：删除引用不存在的 tool_use 的结果

### 8.6 其他预处理

- **剥离 advisor 块**：没有 beta header 时 API 会拒绝
- **剥离超量媒体**：API 限制每次请求最多 100 个 media 项（`API_MAX_MEDIA_PER_REQUEST`），超出时从最旧的开始剥离
- **模型切换后的字段清理**：中途切换模型（如 Sonnet → Haiku）时，旧模型的 tool-search 字段会导致 400 错误

---

## 九、内部消息类型 — `AssistantMessage`

最终，所有 API 返回数据都被转换为统一的内部类型：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'assistant'` | 消息类型 |
| `uuid` | string | 本地 UUID |
| `timestamp` | string | ISO 时间戳 |
| `message.id` | string | API 消息 ID |
| `message.model` | string | 使用的模型 |
| `message.role` | `'assistant'` | 角色 |
| `message.content` | `BetaContentBlock[]` | 规范化后的内容块数组 |
| `message.usage` | `NonNullableUsage` | token 用量统计 |
| `message.stop_reason` | `BetaStopReason` | 停止原因 |
| `requestId` | string | API 请求 ID（用于追踪和缓存分析）|
| `isApiErrorMessage` | boolean | 是否为 API 错误消息 |
| `errorDetails` | string | 原始错误信息 |
| `advisorModel` | string | advisor 模型（如果有）|
| `research` | unknown | 研究数据（仅 ant 内部）|

### stop_reason 的可能值

| stop_reason | 含义 | 后续处理 |
|-------------|------|---------|
| `end_turn` | 正常结束 | 无特殊处理 |
| `max_tokens` | 达到输出 token 上限 | yield 错误消息，触发自动续写恢复 |
| `stop_sequence` | 遇到停止序列 | 无特殊处理 |
| `tool_use` | 模型调用了工具 | 执行工具，继续对话循环 |
| `model_context_window_exceeded` | 超出上下文窗口 | 复用 max_tokens 恢复路径 |

---

## 十、关键特判与兼容逻辑总览

| 特判/兼容逻辑 | 位置 | 原因 |
|--------------|------|------|
| `text` 块初始化为空字符串 | `content_block_start` | SDK bug：会在 start 和 delta 中重复返回文本 |
| `thinking.signature` 初始化为空 | `content_block_start` | 即使没有 `signature_delta` 也要保证字段存在 |
| `tool_use.input` 初始化为空字符串 | `content_block_start` | 流式推送 JSON 片段需逐步拼接 |
| 浅拷贝而非直接引用 content block | `content_block_start` | SDK 会就地突变对象，我们需要不可变性 |
| `signature_delta` 是赋值而非拼接 | `content_block_delta` | 签名是整体替换的 |
| input_tokens 仅在 >0 时更新 | `updateUsage` | `message_delta` 可能发 0 值覆盖 `message_start` 的真实值 |
| `cache_creation` 强制类型断言 | `updateUsage` | SDK 类型 `BetaMessageDeltaUsage` 缺失此字段 |
| `cache_deleted_input_tokens` feature flag | `updateUsage` | 仅内部构建包含，避免泄露字符串到外部 |
| usage/stop_reason 回写用直接突变 | `message_delta` | transcript 写队列持有旧引用，替换会断开 |
| 流式→非流式降级 | `queryModel` catch | 流式失败时用非流式兜底 |
| 404 触发降级 | `queryModel` 外层 catch | 部分网关不支持流式端点 |
| 空 JSON input 降级为 `{}` | `normalizeContentFromAPI` | 流式拼接的 JSON 可能不完整 |
| `connector_text_delta` feature flag | `content_block_delta` | 实验性功能 |
| `research` 字段仅 ant 用户 | `message_start`/`content_block_delta` | 内部功能不暴露给外部 |
| `stop_reason === 'model_context_window_exceeded'` | `message_delta` | 新版 API 返回此停止原因替代旧的 400 错误 |
| 空流检测排除 `stopReason` 存在的情况 | 流循环后 | structured output 合法空响应 |
| 连续 user 消息合并 | `normalizeMessagesForAPI` | Bedrock 不支持连续 user 消息 |
| tool_reference 块条件剥离 | `normalizeMessagesForAPI` + 后处理 | tool search 关闭时 API 不认识此类型 |
| 模型切换后清理旧字段 | 后处理 | Sonnet→Haiku 切换时旧字段导致 400 |
| APIUserAbortError 双重语义 | 流错误处理 | 区分用户中止 vs SDK 内部超时 |
| 非流式 max_tokens 调整 | `adjustParamsForNonStreaming` | 保证 `max_tokens > thinking.budget_tokens` |
| 流 idle 看门狗 | 流循环 | 90s 无事件主动中止，防止无限挂起 |
