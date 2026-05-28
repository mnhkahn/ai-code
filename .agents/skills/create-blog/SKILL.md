---
name: create-blog
description: Use when creating or converting a blog post for a Jekyll blog, or when the user mentions 博客、blog、写博客、发文章、迁移文章. Converts source content into Jekyll-formatted blog posts with proper frontmatter, TOC, and heading structure.
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion
---

# Create Blog Post

Convert source content (markdown files, notes, documents) into Jekyll-formatted blog posts.

## When to Use

- User wants to create a new blog post
- User wants to migrate/convert an existing article to their Jekyll blog
- User mentions "博客", "blog", "写博客", "发文章", "迁移文章"

## Blog Configuration

Detect blog settings from the target repository:

1. **Find the blog repo**: Look in sibling directories of the current project, or ask the user. Common patterns: `~/code/<username>.github.io/`, `~/code/<username>.github.com/`
2. **Posts directory**: `_posts/` inside the blog root
3. **Naming convention**: `YYYY-MM-DD-<slug>.md`
4. **Existing categories/tags**: Scan recent posts in `_posts/` to infer conventions

## Frontmatter Format

Every blog post must start with this frontmatter:

```yaml
---
layout: post
title: "<文章标题>"
description: "<一句话摘要，用于 SEO 和列表预览>"
category: "<分类>"
tags: ["<标签1>", "<标签2>", ...]
---
```

### Rules

- **title**: Chinese, enclosed in double quotes. Concise and descriptive.
- **description**: Chinese, one sentence summarizing the article. Used for SEO meta description.
- **category**: Infer from the article topic. Check existing posts for consistency. Common values: "AI", "编程", "工具", "架构", etc.
- **tags**: Array of 2-5 relevant tags. Include the category as a tag. Use Chinese tags when appropriate.

## TOC (Table of Contents)

Add after frontmatter, before the first heading:

```markdown
* 目录
{:toc}

---
```

This uses Jekyll/Kramdown's automatic TOC generation. The `---` adds a visual separator.

## Heading Structure

### Source → Target Mapping

| Source Style | Target Style | Reason |
|---|---|---|
| `## 1. 搜索工具` | `# 搜索工具` | Remove numbering, use flat `#` headings for top-level sections |
| `### 1.1 GlobTool` | `## GlobTool（文件搜索）` | Demote one level, keep parenthetical description |
| `#### 1.1.1 Detail` | `### Detail` | Demote one level accordingly |
| `## 结论` | `# 总结` | Use 总结 instead of 结论 for consistency |

### Heading Level Rules

1. `#` = top-level section (h1) — used for major sections
2. `##` = subsection (h2) — used for individual items/tools
3. `###` = sub-subsection (h3) — used for details under an item
4. Never use `####` or deeper unless the source absolutely requires it

### Numbering

- Remove section numbers from headings (e.g., "1.1 GlobTool" → "GlobTool")
- Numbers add no value in a blog TOC; the auto-generated TOC handles navigation

## Content Adjustments

### What to Keep As-Is

- Code blocks and their language annotations
- Tables
- Lists
- Bold/italic formatting
- Technical content and explanations

### What to Adjust

| Change | Example |
|---|---|
| Section heading numbering → remove | `## 1. 搜索工具` → `# 搜索工具` |
| `结论` → `总结` | More common in Chinese blog posts |
| Reference links → blockquote | `## 参考链接` → `> 参考文档：[Title](URL)` |
| Nested heading levels → demote | h2→h1, h3→h2, h4→h3 |

### Language

- Keep the original language of the source content (Chinese stays Chinese, English stays English)
- Frontmatter `title` and `description` should match the article's language

## Workflow

```
1. Read the source content
2. Detect or ask for the target blog repository path
3. Scan recent posts in _posts/ to learn:
   - Category and tag conventions
   - Frontmatter field order
   - Any custom fields
4. Generate the slug from the article title (lowercase, hyphens, Chinese pinyin or English)
5. Determine the filename: YYYY-MM-DD-<slug>.md
   - Use today's date unless user specifies otherwise
6. Transform the content:
   a. Add Jekyll frontmatter
   b. Add TOC marker
   c. Restructure headings (remove numbers, adjust levels)
   d. Adjust section names (结论→总结, etc.)
   e. Convert reference section to blockquote format
7. Write the file to _posts/
8. Report the file path to the user
```

## Slug Generation Rules

For the filename `<slug>.md`:

1. If the title is in English: use lowercase, spaces→hyphens, strip special chars
2. If the title is in Chinese: extract key terms and convert to pinyin, OR use a short English summary
3. Keep slugs under 60 characters
4. Use hyphens as separators, never underscores

Examples:
- "Claude Code 工具使用指南与实现原理" → `claude-code-tools-guide`
- "AI Agent 对比" → `claude-code-agents-comparison`
- "Token 估算方法" → `estimate-tokens`

## Decision UI

When the blog repository path is ambiguous, use AskUserQuestion to confirm:

- question: "博客文章要发布到哪个目录？"
- header: "博客路径"
- options: auto-detected paths + "Other"

When category/tags are unclear, propose based on content analysis and let the user confirm or adjust.

## Edge Cases

- **Source is not markdown**: Read the content anyway and convert to markdown format
- **Source has images**: Keep image references as-is; warn user if images may need to be copied to the blog's assets directory
- **Source already has frontmatter**: Merge/replace with Jekyll frontmatter, preserve any custom fields that match the blog's conventions
- **Duplicate slug**: Append a numeric suffix (e.g., `claude-code-tools-guide-2`)
