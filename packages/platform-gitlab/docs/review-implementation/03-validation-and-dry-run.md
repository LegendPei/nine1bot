# 03. 验证与 Dry-Run 施工手册

GitLab review 工作流涉及 webhook、API、diff、prompt、Runtime 和回写。首版必须先做本地 dry-run harness，避免每次调试都依赖真实 GitLab MR。

## 1. Dry-run 目标

脚本：

```text
packages/platform-gitlab/scripts/review-dry-run.ts
```

Fixtures：

```text
packages/platform-gitlab/fixtures/review/
  sample-mr-note-webhook.json
  sample-mr-event-webhook.json
  sample-mr-changes.json
  sample-discussions.json
  sample-overflow-changes.json
  sample-inline-diff.patch
```

脚本最小链路：

```text
load fixtures
  -> event-parser
  -> trigger
  -> idempotency
  -> diff-builder
  -> context-builder
  -> run-spec-compiler draft
  -> comment-renderer dry-run summary
```

dry-run 不调用真实 GitLab，不调用真实 Runtime。

## 2. Dry-run CLI 行为

建议命令：

```bash
bun run packages/platform-gitlab/scripts/review-dry-run.ts --fixture sample-mr-note-webhook
```

输出：

- parsed trigger。
- idempotency key。
- changed files manifest。
- filtered files。
- overflow / blocked 状态。
- generated context block ids。
- AgentRunSpec 摘要。
- rendered GitLab markdown。

错误情况要返回非 0：

- fixture 缺失。
- webhook 不可解析。
- diff overflow blocked。
- output schema 校验失败。

## 3. 单元测试清单

建议新增：

```text
packages/platform-gitlab/test/gitlab-review-event-parser.test.ts
packages/platform-gitlab/test/gitlab-review-trigger.test.ts
packages/platform-gitlab/test/gitlab-review-idempotency.test.ts
packages/platform-gitlab/test/gitlab-review-diff-builder.test.ts
packages/platform-gitlab/test/gitlab-review-inline-position.test.ts
packages/platform-gitlab/test/gitlab-review-output-schema.test.ts
packages/platform-gitlab/test/gitlab-review-finding-aggregator.test.ts
packages/platform-gitlab/test/gitlab-review-renderer.test.ts
```

覆盖重点：

- 非 mention 不触发。
- MR note mention 触发。
- Commit note mention 触发。
- MR push 新 `head_sha` 生成新 key。
- 同一 `head_sha + noteId` 重放不重复。
- lock/build/media 文件被过滤。
- diff overflow blocked。
- inline line 必须在 diff hunk 中。
- inline 400 fallback 到 summary。
- QA/Security duplicate findings 聚合。
- Runtime unknown JSON 经 Zod 校验。

## 4. Controller / Platform Manager 测试

建议新增或扩展：

```text
packages/nine1bot/src/platform/manager.test.ts
packages/nine1bot/src/review/run-spec-compiler.test.ts
packages/nine1bot/src/review/event-router.test.ts
```

覆盖：

- GitLab enabled 注册 agents / skills runtime sources。
- GitLab disabled 注销 sources。
- settings secret redaction。
- `profileSnapshot.resources.skills` 显式声明 declared-only skills。
- `AgentRunSpec.orchestration.mode = supervisor-workers`。
- `runtime.agent.unavailable` 转成 review run blocked。
- resource unavailable 转成 audit / warning。

## 5. Runtime 测试

建议新增或扩展：

```text
opencode/packages/opencode/test/platform/runtime-source-registry.test.ts
opencode/packages/opencode/test/agent/platform-agent-source.test.ts
opencode/packages/opencode/test/skill/platform-skill-source.test.ts
opencode/packages/opencode/test/runtime/subagent-task.test.ts
```

覆盖：

- recommendable platform agent 不进入 default agent。
- declared-only platform skill 不进入默认 session。
- 显式声明后可解析 declared-only skill。
- 平台禁用后 agent fail closed。
- subagent task 只能使用 allowed tools。
- subagent task 只能引用 snapshot context refs。
- Runtime 只按 JSON Schema 约束输出，不 import GitLab review schema。
- `failureMode` 三种行为。

## 6. 回归命令

最小验证：

```bash
bun run --cwd packages/platform-gitlab typecheck
bun test packages/platform-gitlab
bun run packages/platform-gitlab/scripts/review-dry-run.ts --fixture sample-mr-note-webhook
```

接入 Controller 后：

```bash
bun run --cwd packages/nine1bot typecheck
bun test packages/nine1bot/src/platform packages/nine1bot/src/review
```

接入 Runtime 后：

```bash
bun run --cwd opencode/packages/opencode typecheck
bun test opencode/packages/opencode/test/agent opencode/packages/opencode/test/skill opencode/packages/opencode/test/platform opencode/packages/opencode/test/runtime
```

Web 配置页后：

```bash
bun test web/test
bun run build:web
```

最终检查：

```bash
git diff --check
```

## 7. 必须保留的未覆盖说明

如果首版不接真实 GitLab，应在交付说明中明确：

- 未验证真实 GitLab webhook 签名。
- 未验证真实 GitLab inline discussion API。
- 未验证真实 project access token 权限边界。
- 已用 fixtures 覆盖 parser / diff / context / renderer。

