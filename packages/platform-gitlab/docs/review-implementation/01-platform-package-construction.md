# 01. Platform GitLab 包施工手册

本手册只覆盖 `packages/platform-gitlab` 内部实现。这里可以处理 GitLab 平台语义，但不能把 Runtime agent loop 或通用 workflow 状态机写进来。

## 1. 目标目录

```text
packages/platform-gitlab/
  agents/
    review/
      pm-coordinator.agent.md
  skills/
    review/
      gitlab-mr-review-workflow/SKILL.md
      gitlab-commit-review-workflow/SKILL.md
      spec-gate-review/SKILL.md
      pm-risk-routing/SKILL.md
      review-finding-schema/SKILL.md
      verification-matrix/SKILL.md
      security-review-policy/SKILL.md
      gitlab-comment-rendering/SKILL.md
      subagent-prompts/
        spec-writer/SKILL.md
        tech-architect/SKILL.md
        developer/SKILL.md
        frontend-designer/SKILL.md
        risk-qa/SKILL.md
        security-agent/SKILL.md
        auto-fixer/SKILL.md
  src/
    review/
      api-client.ts
      comment-renderer.ts
      context-builder.ts
      diff-builder.ts
      event-parser.ts
      finding-aggregator.ts
      idempotency.ts
      inline-position.ts
      output-schema.ts
      settings.ts
      trigger.ts
      types.ts
      webhook.ts
      workflow.ts
```

## 2. Runtime sources

在 `packages/platform-gitlab/src/runtime.ts` 的 `gitlabPlatformContribution.runtime` 中补充 sources：

```ts
runtime: {
  createAdapter: createGitLabPlatformAdapter,
  sources: {
    agents: [
      {
        id: 'gitlab-review-agents',
        directory: new URL('../agents', import.meta.url).pathname,
        namespace: 'platform.gitlab',
        visibility: 'recommendable',
        lifecycle: 'platform-enabled',
      },
    ],
    skills: [
      {
        id: 'gitlab-review-skills',
        directory: new URL('../skills', import.meta.url).pathname,
        namespace: 'platform.gitlab',
        visibility: 'declared-only',
        lifecycle: 'platform-enabled',
      },
    ],
  },
}
```

要求：

- PM 主代理名使用 `platform.gitlab.pm-coordinator`。
- skills 使用 `platform.gitlab.*` 命名。
- review skills 必须是 `declared-only`，避免普通 Web session 默认继承。
- GitLab 平台禁用后，Platform Adapter Manager 会注销 sources，不需要平台包自行管理。

## 3. Webhook 与触发

实现文件：

- `event-parser.ts`
- `trigger.ts`
- `webhook.ts`
- `types.ts`

必须支持：

- MR note：`object_kind = note` 且 `noteable_type = MergeRequest`。
- Commit note：`object_kind = note` 且 `noteable_type = Commit`。
- MR event 自动触发：后续通过 settings 显式开启。

触发规则：

- 默认只启用手动 `@Nine1bot`。
- 命令包括 `review`、`security`、`qa`、`fix`、`recheck`。
- 未命中 mention 时必须返回 no-op，不写状态，不调用 Runtime。
- webhook secret 校验失败必须返回明确错误，不进入 review run。

## 4. 幂等性

实现文件：

- `idempotency.ts`

MR review 的 key 必须绑定代码状态：

```text
manual note:
gitlab:{host}:{projectId}:mr:{mrIid}:head_sha:{headSha}:note:{noteId}

auto webhook:
gitlab:{host}:{projectId}:mr:{mrIid}:head_sha:{headSha}:auto:{eventName}
```

禁止只用 `mrIid`。MR push 新 commit 后 `headSha` 变化，必须允许生成新的 review run。

Commit review key：

```text
gitlab:{host}:{projectId}:commit:{sha}:note:{noteId}
```

## 5. Diff builder

实现文件：

- `api-client.ts`
- `diff-builder.ts`

必须处理：

- MR metadata。
- MR changes / diffs。
- discussions。
- GitLab API diff overflow / truncation。
- 黑名单文件过滤。

首版硬编码过滤：

```ts
const excludedDiffFilePatterns = [
  /(^|\/)(package-lock|yarn\.lock|pnpm-lock|bun\.lockb?|composer\.lock|Gemfile\.lock)$/i,
  /(^|\/)dist\//i,
  /(^|\/)build\//i,
  /(^|\/)coverage\//i,
  /(^|\/)\.next\//i,
  /(^|\/)\.nuxt\//i,
  /\.min\.(js|css)$/i,
  /\.(map|png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp4|mov|mp3|woff2?|ttf|eot)$/i,
]
```

Overflow 策略：

- 如果 GitLab 返回 `overflow = true`，review run 必须 blocked。
- 如果文件显示有变更但 diff 为空，且不是二进制/黑名单文件，review run 必须 blocked。
- blocked 时回写 MR 顶层评论，提示 MR 差异过大或被 GitLab 截断。

## 6. Inline validator

实现文件：

- `inline-position.ts`

要求：

- 不信任 LLM 输出的行号。
- 从原始 diff hunk 解析可评论行集合。
- `newLine` / `oldLine` 必须存在于本次 diff hunk 中才允许创建 inline discussion。
- GitLab API 返回 400 时，单条 finding 降级为 summary note。
- inline 失败不能使整个 review run 失败。

## 7. Output schema 与聚合

实现文件：

- `output-schema.ts`
- `finding-aggregator.ts`

规则：

- 用 Zod 定义 review 业务 schema，并导出 JSON Schema 给 Runtime。
- Runtime 只返回 `Record<string, unknown>`。
- Controller / GitLab review 层负责 Zod 校验。
- QA / Security / Frontend 等子代理 findings 先由 `finding-aggregator.ts` 按 `file + oldLine + newLine + category` 聚合。
- 聚合后再交给 PM 主代理润色和裁决。

## 8. Renderer

实现文件：

- `comment-renderer.ts`

首版只要求 summary note：

- 总状态：passed / failed / blocked。
- blocker / major findings。
- 超时或跳过的子代理任务。
- 未覆盖项。
- trace id。
- idempotency key。

inline comment 在 validator 完成后再开启，且必须支持 fallback。

