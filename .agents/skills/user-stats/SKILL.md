---
name: user-stats
description: Report user-level statistics across all sessions — per-model call counts, token usage, and success rates; per-tool call counts and success rates. Trigger on "user stats", "user statistics", "用户统计", "全局统计", "user-stats", "/user-stats".
allowed-tools: Bash
---

# User-Level Statistics

Scan all session JSONL files for the current user and output aggregated statistics by model and tool.

## Output Format

```
Usage by model:
    <ModelName>:  <calls> calls, <success_rate> success, <input> input, <output> output, <cache_read> cache read, <cache_write> cache write
Tool calls:
    <ToolName>:  <calls> calls, <errors> errors, <success_rate> success
```

- Token values: use `k` for thousands, `M` for millions (e.g. `11.8M`, `45.8k`, `0` if zero)
- Success rate: percentage with 1 decimal (e.g. `99.2%`, `100.0%`)
- Sort models by total calls descending; sort tools by total calls descending

## Data Source

Session JSONL files are located at:
```
~/.claude/projects/<project-hash>/<sessionId>.jsonl
```

**Claude Code 和 Trae 共用此目录**存储会话历史。脚本默认扫描 `~/.claude/projects/`。

也可以通过参数指定目录：`node user-stats.js --dir <custom-path>`

Each line is a JSON entry. Relevant entry types:

### assistant entries (model stats)

```json
{
  "type": "assistant",
  "message": {
    "model": "doubao-seed-code",
    "stop_reason": "tool_use",
    "usage": {
      "input_tokens": 31610,
      "output_tokens": 226,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0
    }
  }
}
```

- `message.model` → model name (use as-is for grouping)
- `message.usage.input_tokens` → input tokens
- `message.usage.output_tokens` → output tokens
- `message.usage.cache_creation_input_tokens` → cache write tokens
- `message.usage.cache_read_input_tokens` → cache read tokens
- `message.stop_reason` → `"error"` means failed call; any other value is success

### tool_use blocks (tool stats)

Inside `assistant` entries, `message.content` is an array. Each block with `type: "tool_use"` represents a tool invocation:

```json
{"type": "tool_use", "id": "call_xxx", "name": "Bash"}
```

- `name` → tool name. For Agent tool calls, the name may be a long string containing the full prompt — normalize it to just `"Agent"`.
- `id` → tool call ID for matching with tool_result

### tool_result blocks (tool success/failure)

Inside `user` entries, `message.content` is an array. Each block with `type: "tool_result"`:

```json
{"type": "tool_result", "tool_use_id": "call_xxx", "is_error": true}
```

- `tool_use_id` → matches the `id` from tool_use block
- `is_error` → `true` means the tool call failed

## Workflow

```
1. Find all JSONL files:
   find ~/.claude/projects -name '*.jsonl' -type f

2. Write the aggregation script to /tmp/user-stats.js and run it:
   - Parse every line of every JSONL file
   - For each assistant entry:
     a. Extract model name from message.model
     b. Accumulate: call count, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
     c. If message.stop_reason === "error", increment model failure count
     d. For each tool_use block in message.content:
        - Normalize tool name: if name contains newline or is longer than 30 chars, use "Agent"
        - Record tool name, increment call count
        - Store mapping: tool_use_id → {tool_name}
   - For each user entry:
     a. For each tool_result block in message.content:
        - Look up tool_use_id in the stored mapping
        - If is_error === true, increment tool error count

3. Calculate success rates:
   - Model success rate = (total_calls - failures) / total_calls * 100
   - Tool success rate = (total_calls - errors) / total_calls * 100

4. Format and print output using the format above
5. Clean up temp file
```

## Execution

Run the aggregation script directly:

```bash
node /Users/bytedance/code/ai-code/.agents/skills/user-stats/scripts/user-stats.js
```

## Edge Cases

- **No JSONL files found**: Print "No session data found." and stop.
- **Empty or corrupted JSONL lines**: Skip silently (the script uses try/catch).
- **Unknown model names**: Use as-is from `message.model`.
- **Long/multiline tool names** (e.g. Agent with inline prompt): Normalize to `"Agent"`.
- **Tool calls without matching tool_result**: Count the call but no error.
- **tool_result without matching tool_use**: Skip (orphaned result).
