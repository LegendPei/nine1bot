# 02. Controller 与 Runtime 接入施工手册

本手册描述 `packages/nine1bot` 与 `opencode` / Nine1Bot Runtime 的接入边界。

## 1. 边界原则

Controller 负责：

- 挂载 GitLab webhook route。
- 读取 Web 配置和 secrets。
- 调用 `platform-gitlab` 解析触发和构造上下文。
- 创建 / 恢复 `ReviewRun`。
- 编译 `AgentRunSpec`。
- 转译 Runtime events。
- 调用 GitLab renderer 回写评论。

Runtime 负责：

- 冻结 `TurnRuntimeSnapshot`。
- 启动 `platform.gitlab.pm-coordinator` 主代理。
- 为 PM 主代理提供受控 subagent task 能力。
- 校验子代理工具、skills、context refs、JSON Schema。
- 执行子代理并返回结构化 JSON。

Controller 不负责：

- 派生子代理。
- 并行调度 QA / Security。
- 执行 agent loop。
- 解释 Runtime 内部 tool call。

## 2. 建议 Controller 目录

```text
packages/nine1bot/src/review/
  controller.ts
  run-spec-compiler.ts
  run-store.ts
  event-router.ts
```

### controller.ts

职责：

- 接收平台触发。
- 做配置和 enabled hard gate。
- 做 webhook secret 校验结果处理。
- 写入 review run 初始状态。
- 调用 `run-spec-compiler.ts`。
- 调用 Runtime。
- 监听 Runtime events。
- 触发 GitLab 回写。

### run-spec-compiler.ts

职责：

- 将 `GitLabReviewRequest` 编译成 `AgentRunSpec`。
- 设置：
  - `entry.source = 'api'`
  - `entry.platform = 'gitlab'`
  - `entry.mode = 'mr-review' | 'commit-review'`
  - `agent.name = 'platform.gitlab.pm-coordinator'`
  - `orchestration.mode = 'supervisor-workers'`
  - GitLab review skills。
  - GitLab context blocks。
  - JSON Schema 输出契约。

### run-store.ts

职责：

- 存储 review run。
- 存储 idempotency key。
- 存储 head sha、note id、trace id、GitLab comment ids。
- 支持 dry-run 内存实现和正式持久化实现。

### event-router.ts

职责：

- 将 Runtime event 转成 review run event。
- 处理：
  - supervisor started / completed。
  - subagent task started / completed / timeout。
  - resource failure。
  - permission ask。
  - runtime agent unavailable。
  - blocked / failed / closed。

## 3. AgentRunSpec 编译要点

`AgentRunSpec` 中必须表达：

- 平台来源。
- MR / commit context blocks。
- GitLab review skills。
- PM 主代理。
- subagent task policy。
- output JSON Schema。
- permissions。
- audit trace。

示意：

```ts
const spec = {
  entry: {
    source: 'api',
    platform: 'gitlab',
    mode: 'mr-review',
    templateIds: ['gitlab-mr', 'gitlab-code-review'],
  },
  agent: {
    name: 'platform.gitlab.pm-coordinator',
    source: 'session-choice',
  },
  context: {
    blocks,
  },
  resources: {
    builtinTools: {
      enabledGroups: ['gitlab-context', 'gitlab-review-comment'],
    },
    mcp: {
      servers: [],
      lifecycle: 'session',
      mergeMode: 'additive-only',
    },
    skills: {
      skills: [
        'platform.gitlab.gitlab-mr-review-workflow',
        'platform.gitlab.spec-gate-review',
        'platform.gitlab.pm-risk-routing',
        'platform.gitlab.review-finding-schema',
        'platform.gitlab.verification-matrix',
        'platform.gitlab.security-review-policy',
        'platform.gitlab.gitlab-comment-rendering',
      ],
      lifecycle: 'session',
      mergeMode: 'additive-only',
    },
  },
  orchestration: {
    mode: 'supervisor-workers',
    supervisor: {
      agent: 'platform.gitlab.pm-coordinator',
    },
    subagentTask: {
      enabled: true,
      allowedTaskKinds: ['discovery', 'spec', 'architecture-review', 'frontend-review', 'implementation', 'qa', 'security', 'fix', 'closed'],
      allowedPromptSkillRefs: [
        'platform.gitlab.subagent-prompts.spec-writer',
        'platform.gitlab.subagent-prompts.tech-architect',
        'platform.gitlab.subagent-prompts.developer',
        'platform.gitlab.subagent-prompts.frontend-designer',
        'platform.gitlab.subagent-prompts.risk-qa',
        'platform.gitlab.subagent-prompts.security-agent',
        'platform.gitlab.subagent-prompts.auto-fixer',
      ],
      maxParallelTasks: 2,
      defaultTimeoutMs: 120_000,
    },
    output: {
      schema: reviewRunReportJsonSchema,
    },
  },
}
```

## 4. Runtime subagent task contract

Runtime 需要支持 PM 主代理提交：

```ts
type SubagentTaskSpec = {
  id: string
  stage: string
  kind: string
  prompt?: string
  promptRef?: string
  skills: string[]
  contextRefs: string[]
  allowedTools: string[]
  outputSchema: Record<string, unknown>
  timeoutMs?: number
  failureMode: 'abort-run' | 'ignore' | 'fallback'
  fallbackPrompt?: string
  parallelGroup?: string
  dependsOn?: string[]
  fileScope?: string[]
}
```

Runtime 校验：

- `promptRef` 必须来自 allowed prompt skill refs。
- `skills` 必须是当前 session 可用 skills 的子集。
- `contextRefs` 必须来自 `TurnRuntimeSnapshot`。
- `allowedTools` 必须是当前 resolved tools 的子集。
- `outputSchema` 只作为 JSON Schema 约束，不绑定业务类型。

## 5. Failure policy

必须实现：

- `abort-run`：中断 review run，回写失败。
- `ignore`：记录未完成，继续汇总已有结果。
- `fallback`：用更小上下文或 fallback prompt 重试一次。

建议默认：

- PM 主代理：`abort-run`。
- QA / Security：`ignore` 或 `fallback`。
- Fix：`abort-run` 或 `fallback`，按用户命令决定。

## 6. Runtime source live gate

必须复用最新平台 source 语义：

- GitLab 平台禁用后，不允许新 session 使用 GitLab review agent / skills。
- 旧 session 引用 GitLab PM agent：fail closed，事件 `runtime.agent.unavailable`。
- 旧 session 引用 GitLab skill：resource unavailable，进入 audit。
- Platform Manager detail 中展示 runtime sources 注册状态。

## 7. Web 配置页

Web 使用现有 `PlatformManager.vue` / `/nine1bot/platforms` API：

- GitLab code review 默认关闭。
- secret 字段 redacted。
- 展示 webhook URL。
- 展示 runtime sources 状态。
- 提供 connection test action。
- 提供 dry-run action 可选。

