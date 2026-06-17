# WebFetch vs Curl：AI Coding Agent 的网页抓取工具对比

## 概述

在 AI Coding Agent 的工具体系里，"抓取网页内容"是个常见需求。但几乎所有 agent 都没有直接把 `curl` 丢给模型用，而是做了一个专门的 `WebFetch`（或叫 `webfetch`）工具。为什么？两家主流实现（Claude Code 和 OpenCode）又有什么区别？本文从源码层面梳理清楚。

---

## 一、Curl：通用 HTTP 瑞士军刀

curl 是给人用的通用 HTTP 客户端，特点就是"什么都能调、什么都能配"。

| 维度 | 说明 |
|------|------|
| **HTTP 方法** | 任意（GET/POST/PUT/DELETE/PATCH/HEAD...） |
| **URL 协议** | http/https/ftp/file/ftps/sftp/scp... 几十种 |
| **请求体** | 任意 data/form/json/二进制/文件上传 |
| **Headers** | 完全自定义（`-H`），想加多少加多少 |
| **认证** | Basic / Digest / OAuth / Bearer / NTLM / 客户端证书 / Cookie 罐 |
| **代理** | HTTP / HTTPS / SOCKS4 / SOCKS5，支持认证 |
| **Cookie** | `-b` 读、`-c` 写，完整 cookie 罐 |
| **超时** | 可分别设置 connect timeout、最大传输时间、dns 超时 |
| **重定向** | `-L` 跟随，可控制最大次数、跨域策略 |
| **断点续传** | `-r` / `-C`，分块请求 |
| **TLS** | 证书校验开关、客户端证书、TLS 版本、cipher 套件 |
| **输出格式** | 原始字节 / header / 写入文件 / `--write-out` 自定义格式化 |
| **重试** | `--retry` + 重试条件 + 退避策略 |
| **参数数量** | 上百个命令行参数和标志 |

curl 的哲学是"你说怎么发，我就怎么发"。它完全不关心你发的是什么内容、拿回来要干什么。

---

## 二、OpenCode 的 webfetch

源码位置：`packages/opencode/src/tool/webfetch.ts`

OpenCode 的 `webfetch` 是极简风格 —— 就 3 个参数，其他全帮你决定好了。

### 入参

```typescript
{
  url: string;           // 必填，必须 http/https 开头
  format?: "text" | "markdown" | "html";  // 可选，默认 markdown
  timeout?: number;      // 可选，秒，最大 120s，默认 30s
}
```

### 核心逻辑

1. **权限校验**：走 `webfetch` 权限规则，按域名匹配 allow/deny/ask
2. **浏览器伪装**：UA 设为 Chrome 143，带 Accept 和 Accept-Language header
3. **Cloudflare 重试**：如果遇到 `cf-mitigated: challenge` 的 403，自动把 UA 换成 `opencode` 再试一次（绕 TLS 指纹检测）
4. **大小限制**：5MB 硬上限，Content-Length 和实际 body 双重检查
5. **格式转换**：
   - `markdown`（默认）：HTML 用 `turndown` 转 Markdown，移除 script/style/meta/link
   - `text`：用 `htmlparser2` 提取纯文本，跳过 script/style/noscript/iframe 等
   - `html`：原样返回
6. **图片特殊处理**：如果 Content-Type 是图片，转 base64 data URL 当附件返回，文字就一句 "Image fetched successfully"
7. **Accept 协商**：请求时按 format 设带权重的 Accept header，服务端有对应格式就直接返回，省得转

### 特点

- **极简 API**：3 个参数，模型很容易用对
- **输出即清洗**：回来就是干净的 markdown/text，省 token
- **无状态**：不缓存、不存 cookie、不记会话
- **只读**：只有 GET，没有副作用

---

## 三、Claude Code 的 WebFetch

源码位置：`src/tools/WebFetchTool/WebFetchTool.ts`

Claude Code 的 WebFetch 是"重型"实现 —— 不只是抓页面，还带**二次模型处理**。

### 入参

```typescript
{
  url: string;      // 必填，URL 格式校验
  prompt: string;   // 必填，对抓取内容的处理指令
}
```

对，**没有 format 参数**。因为它默认就转 markdown，然后用另一个模型来处理内容。

### 核心逻辑

1. **URL 校验**：长度 ≤ 2000，不能有 username/password，hostname 至少两段
2. **域名黑名单预检**：调用 `api.anthropic.com/api/web/domain_info` 检查域名能不能抓，有 5 分钟缓存。这是 PSR（产品安全评审）要求的安全措施
3. **HTTP 抓取**：
   - 用 axios，最大 10MB 响应
   - 60 秒超时
   - 最多 10 次重定向
   - 自动把 http 升级成 https
4. **HTML → Markdown**：turndown 转换，延迟加载（首次抓取才 import turndown，省启动内存）
5. **跨主机重定向拦截**：如果重定向跳到了不同主机（只允许加减 www.），不自动跟随，而是把重定向地址返回给模型，让模型决定要不要再抓一次
6. **二次模型处理**（关键差异）：
   - 把转好的 markdown 连同用户的 `prompt` 一起喂给 **Haiku**（轻量模型）
   - Haiku 根据 prompt 对内容做摘要、提取、回答
   - 非预批准域名还有额外限制：引用不超过 125 字、不逐字复制、不 reproduce 歌词
   - 预批准域名（比如 MDN、GitHub 等）内容更长、限制更少
7. **结果大小限制**：markdown 原文最多 100,000 字符
8. **缓存**：15 分钟 LRU 缓存，最大 50MB
9. **二进制内容**：PDF 等二进制存到磁盘，提示模型去看文件

### 输出

```typescript
{
  bytes: number;       // 内容字节数
  code: number;        // HTTP 状态码
  codeText: string;    // 状态码文本
  result: string;      // Haiku 处理后的结果
  durationMs: number;  // 总耗时
  url: string;         // 实际抓取的 URL
}
```

注意：模型拿到的 `result` 不是原始页面内容，是 **Haiku 加工过的回答**。

---

## 四、三家对比总览

| 维度 | curl | OpenCode webfetch | Claude Code WebFetch |
|------|------|-------------------|----------------------|
| **定位** | 通用 HTTP 客户端 | 网页转可读内容工具 | 网页研究助理（带二次模型） |
| **入参数量** | 上百个 | 3 个 | 2 个 |
| **HTTP 方法** | 任意 | 只有 GET | 只有 GET |
| **请求体** | 任意 | 无 | 无 |
| **Headers** | 完全自定义 | 预设 UA/Accept/Accept-Language | 预设 UA 等 |
| **认证** | 全套支持 | 无，匿名请求 | 无，匿名请求 |
| **Cookie** | 完整 cookie 罐 | 不带 | 不带 |
| **代理** | 支持 | 不支持 | 不支持 |
| **大小限制** | 无 | 5MB | 10MB + 10 万字符 markdown 上限 |
| **超时** | 多种超时可配 | 默认 30s，最大 120s | 60s 固定 |
| **重定向** | 可配 | 自动跟随 | 同域名跟随，跨域名交给模型决定 |
| **HTML 处理** | 原样返回 | 自动转 markdown / text | 自动转 markdown |
| **内容理解** | 无 | 无，就是原始清洗后的内容 | 用 Haiku 做二次处理（摘要/提取/回答） |
| **缓存** | 无（手动配合） | 无 | 15 分钟 LRU，50MB |
| **安全检查** | 无 | 域名级权限规则 | 域名黑名单预检 + 权限规则 + 引用长度限制 |
| **二进制处理** | 原始字节 | 图片转 base64 附件 | 存磁盘，提示路径 |
| **图片** | 原始字节 | 转 base64 data URL | （归到二进制处理） |
| **重试** | 可配退避策略 | Cloudflare 403 自动换 UA 重试 | ？ |
| **副作用** | 可能有（POST/PUT/DELETE） | 无，只读 | 无，只读 |
| **Token 效率** | 不关心 | 高（清洗后的纯内容） | 最高（Haiku 浓缩过的结果） |

---

## 五、设计哲学的三层差异

为什么三个工具差别这么大？因为面向的用户和场景完全不同。

### 第一层：人用 vs 模型用

curl 是给人设计的。人知道自己要发什么请求、需要控制哪些参数。而模型很容易在"参数太多"时用错 —— 忘了设 Content-Type、header 拼错、方法选不对。所以 agent 工具的第一原则就是**减少选择**：默认 GET、默认浏览器 UA、默认转 markdown，模型只要说"抓这个 URL"就行。

### 第二层：原始内容 vs 清洗内容

OpenCode 的 webfetch 做了 HTML → markdown/text 的转换。这不是小事 —— 一个网页可能 80% 都是导航、广告、页脚、SEO 标签，真正的正文可能只有 20%。转成 markdown 直接砍掉一大半 token，模型读得更快、更聚焦。

### 第三层：原文 vs AI 摘要

这是 Claude Code 和 OpenCode 最大的分歧。

- **OpenCode**：我把内容清洗好给你，你（主模型）自己看
- **Claude Code**：我先用 Haiku（便宜的小模型）把内容读了、提炼了，把答案给你（主模型）

Claude Code 的做法省了主模型的 token（长页面可能几万 token，Haiku 处理完只剩几百字），但代价是**信息有损** —— Haiku 可能漏过重要细节、可能理解错 prompt。而且多了一次模型调用，增加了延迟。

这本质上是"成本 vs 保真度"的权衡。Claude Code 偏向省成本（以及省用户的阅读时间），OpenCode 偏向保真。

---

## 六、为什么 AI Agent 都不直接用 curl

整理一下核心原因：

1. **参数爆炸**：curl 上百个参数，模型很容易用错，而且错误形式多样（header 拼错、方法选错、编码问题），排错成本高
2. **Token 浪费**：原始 HTML 里大量噪音，模型读 10KB 的标签可能只得到 1KB 的有效信息
3. **安全风险**：
   - 内网探测：模型可能被诱导去抓 `http://169.254.169.254/`（云元数据）或内部服务
   - 数据外泄：通过 URL 参数、cookie、请求体把数据发到外部
   - SSRF 攻击：用户的 prompt 注入让 agent 去抓内部网络
4. **权限粒度**：curl 能干的事情太多了，简单的 allow/deny 不够。WebFetch 因为只有 GET、只能抓公网网页，权限模型简单得多
5. **结果可预期**：WebFetch 返回的一定是文本/markdown，模型知道怎么接。curl 可能返回图片、PDF、gzip 压缩的二进制，处理起来很复杂

---

## 七、延伸对比：websearch 呢？

顺便提一下，两家的搜索工具也遵循同样的哲学分歧：

- **OpenCode**：`websearch` 工具，背后接 Exa 或 Parallel MCP，返回搜索结果的上下文摘要，模型自己读
- **Claude Code**：`WebSearchTool`（同样是带 prompt 的模式，搜索 + 二次模型处理）

但 OpenCode 还有个 `webfetch` 做深入阅读，Claude Code 则是把"深入"也交给 WebFetch + Haiku 了。

---

## 八、总结

| | curl | OpenCode webfetch | Claude Code WebFetch |
|---|------|-------------------|----------------------|
| **使用者** | 人 | AI 模型 | AI 模型 |
| **返回的是** | 原始字节 | 清洗后的网页文本 | 小模型读过之后的回答 |
| **控制权** | 完全可控 | 少量可配 | 几乎不用配 |
| **Token 效率** | 最低 | 中 | 最高 |
| **信息保真度** | 最高 | 高 | 中（有损） |
| **安全性** | 全靠人 | 权限规则 + 大小限制 | 域名预检 + 权限规则 + 内容限制 |

选择哪个，取决于你在"控制 vs 易用"、"保真 vs 省 token"、"简单 vs 智能"这几轴上站哪边。对 AI agent 来说，curl 几乎从来不是正确答案 —— 但 webfetch 做到什么程度，每个产品有自己的答案。
