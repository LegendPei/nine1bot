# GitLab Review 阶段冻结与设计 Review

## 结论

截至当前分支 `feat/gitlab-review-workflow`，GitLab 代码审查功能已经完成到约 **90%**。

目前剩余工作不全是“必须真实测试才能补全”，但真正影响可上线判断的部分确实集中在真实 Runtime / 真实 GitLab 环境：

- 必须真实测试才能确认：
  - GitLab Webhook 从公网进入本地/部署环境后的完整路径。
  - GitLab token 在真实项目上的 MR diff 读取、MR note 写入、discussion 写入权限。
  - `platform.gitlab.pm-coordinator` 在真实 Runtime session 中通过 `task` 并行派生子代理。
  - GitLab 对 inline discussion position 的真实 400 行为和 fallback 是否符合预期。
  - MR push 新 commit 后 `headSha` 幂等 key 是否按真实 payload 生成新 run。
- 仍可以继续本地补齐：
  - `blocked` runtime 结果的 run status 映射。
  - 非黑名单空 diff 的 blocked 策略。
  - 非法 JSON、缺字段 JSON、GitLab 400 fallback 的 fixture。
  - Web UI 展开 warnings / error / session 详情。
  - 真实 Runtime task 输出接入 `subagent-result-compiler` 的边界测试。

整体方向没有偏离最初“插件化、低耦合、多 agents、GitLab 包内聚”的设计，但有两个实现细节与设计文档存在偏差，建议下一轮先修。

## 当前冻结产出

### 平台包边界

GitLab 业务能力主要收口在 `packages/platform-gitlab`：

- `src/review/api-client.ts`
- `src/review/event-parser.ts`
- `src/review/diff-builder.ts`
- `src/review/inline-position.ts`
- `src/review/publisher.ts`
- `src/review/output-schema.ts`
- `src/review/subagent-result-compiler.ts`
- `agents/review/*.agent.md`
- `skills/review/**/SKILL.md`
- `scripts/review-dry-run.ts`

这符合 `docs/agent-runtime-developer-guide/09-platform-adapter-development-guide.md` 中的平台语义边界要求。

### Controller / Runtime 接入

产品层胶水在 `packages/nine1bot/src/review`：

- `gitlab-controller.ts` 负责 settings、secret、trigger、run store、runtime prompt、publish。
- `run-store.ts` 负责 review run JSON 持久化、幂等查找、limit prune、retry 信息。

Runtime 层只加了通用自动控制器能力：

- `opencode/packages/opencode/src/server/routes/webhooks.ts` 挂载 GitLab webhook route 并启动自动 Runtime session。
- `automated-controller.ts` 暴露通用 `onRuntimeOutput`，不引入 GitLab review 类型。

这基本符合“Runtime 不知道 GitLab 业务类型”的底座原则。

### 多 Agents / Skills

当前 GitLab 包下已经有两层资产：

- concrete runtime agents：
  - `platform.gitlab.pm-coordinator`
  - `platform.gitlab.tech-architect`
  - `platform.gitlab.frontend-designer`
  - `platform.gitlab.risk-qa`
  - `platform.gitlab.security-agent`
  - `platform.gitlab.spec-writer`
  - `platform.gitlab.developer`
- declared-only skills：
  - GitLab MR / commit workflow
  - PM risk routing
  - finding schema
  - security policy
  - verification matrix
  - comment rendering
  - subagent prompt skills

PM agent 已允许通过 runtime `task` 工具派生 `platform.gitlab.*` 子代理。skills 保持为角色知识库，不直接污染普通 session。

### 本地 Dry-Run 基建

当前 dry-run 已覆盖：

- MR changes fixture。
- overflow fixture。
- webhook note fixture。
- PM runtime output 文本注入。
- 多子代理 outputs 注入。
- mock GitLab publish。

命令：

```bash
bun run review:dry-run
bun run review:dry-run:webhook
bun run review:dry-run:runtime-output
bun run review:dry-run:subagents
```

这已经能在无真实 GitLab 和无真实 Runtime 多代理 session 的情况下验证大部分确定性逻辑。

## 设计对齐 Review

| 设计项 | 当前状态 | Review 结论 |
| --- | --- | --- |
| GitLab 功能插件化，不耦合 Runtime core | GitLab 业务类型在 `platform-gitlab` / `nine1bot/src/review`，Runtime 只处理通用 session/context/output | 符合 |
| Web 配置页显式启用，默认不开启 | `review.enabled` 默认 false，descriptor 暴露配置，Web 可保存 secret | 符合 |
| GitLab token 和 webhook secret 由用户配置 | 已有 secret 字段，`connection.test` 可测 token self endpoint 和 `api` scope | 符合 |
| MR / Commit 评论触发 | MR note、commit note、MR webhook 已解析 | 基本符合 |
| MR push 后重新审查 | MR idempotency key 包含 `headSha` | 符合 |
| Diff overflow 阻断 | response overflow / file overflow / too_large 会 blocked | 基本符合 |
| 噪声文件过滤 | lock、构建产物、多媒体、generated 已过滤 | 符合 |
| Inline 行号校验与 fallback | hunk validator + 400 fallback 已实现 | 符合 |
| Map-reduce 不依赖 LLM 去重 | `aggregateReviewFindings` + `subagent-result-compiler` 已实现 | 符合 |
| Runtime 输出不绑定 GitLab 类型 | Runtime 输出为文本/JSON，业务校验在 controller/platform 层 | 符合 |
| Subagent failureMode | 类型、compiler、dry-run fixture 已有 | 部分符合，真实 runtime task 尚无原生 timeout/failureMode 参数 |
| Dry-run 本地测试桩 | 已有 changes/webhook/runtime-output/subagents 模式 | 符合 |

## 偏离点

### 1. Runtime 输出 `blocked` 会被记录为 `succeeded`

位置：

- `packages/nine1bot/src/review/gitlab-controller.ts`
- `publishGitLabReviewRunResult`

当前逻辑：

```ts
status: parsed.status === 'failed' ? 'failed' : 'succeeded'
```

影响：

- 如果 PM 最终输出 `status: "blocked"`，评论可以发布，但 run store 会显示 `succeeded`。
- 这和设计中的 `accepted / blocked / failed / closed` 状态语义不一致。
- Web UI、后续 retry 策略和运营排查会误判 blocked 为成功。

建议：

```ts
status: parsed.status === 'failed'
  ? 'failed'
  : parsed.status === 'blocked'
    ? 'blocked'
    : 'succeeded'
```

并补一个 controller 测试：PM 输出 `blocked` 时 run status 为 `blocked`，但 `publishedAt` 仍记录。

### 2. 非黑名单空 diff 当前被跳过，而施工文档要求 blocked

位置：

- `packages/platform-gitlab/src/review/diff-builder.ts`

当前逻辑：

```ts
if (!change.diff?.trim()) {
  skipped.push({ path, reason: 'empty-diff' })
  continue
}
```

影响：

- 如果 GitLab 因截断或异常返回非黑名单源码文件的空 diff，但未显式带 `overflow / too_large / collapsed`，系统会跳过该文件并继续审查剩余 diff。
- 设计文档要求：源码文件显示有变更但 diff 为空时应 blocked，避免代理在缺证据场景下审查不完整 MR。

建议：

- 黑名单、generated、too_large、collapsed 仍 skip。
- 非黑名单源码文件空 diff 时返回 blocked manifest。
- 补测试：`src/app.ts` 空 diff => `manifest.blocked === true`。

### 3. `failureMode / timeoutMs` 尚未成为 Runtime task 原生参数

位置：

- `packages/platform-gitlab/src/review/workflow.ts`
- `packages/platform-gitlab/src/review/subagent-result-compiler.ts`
- `opencode/packages/opencode/src/tool/task.ts`

当前状态：

- GitLab review 层已有 `SubagentTaskSpec.failureMode`。
- compiler 和 dry-run 可按 failureMode 聚合子代理输出。
- 但 runtime `task` 工具目前只支持 `description / prompt / subagent_type / session_id / command`。

影响：

- PM 可以通过 prompt 约定表达 failureMode，但 Runtime 不会原生按 `timeoutMs / failureMode` 管理子任务。
- 这不阻断 Phase 1，但和原设计中“Runtime 校验 SubagentTaskSpec”的形态还有距离。

建议：

- Phase 1 可以继续用 PM prompt + compiler 承接。
- Phase 2 再考虑扩展 Runtime task contract，或者新增 GitLab review 专用 workflow compiler，不把业务字段塞进通用 task tool。

## 是否需要真实测试才能继续

不是全部都需要。

### 建议先本地修完

这些可以不用真实 GitLab：

1. 修 `blocked` runtime result 的 run status 映射。
2. 修非黑名单空 diff blocked 策略。
3. 增加非法 JSON / 缺字段 JSON dry-run fixture。
4. Web UI 展开 run warnings / error 详情。
5. 用单元测试固定 retry 后 warnings 不无限重复的策略。

### 需要真实 GitLab / Runtime 验证

这些本地 mock 价值有限：

1. GitLab webhook 实际 payload 差异，尤其 MR push 后 last commit 字段。
2. GitLab.com 与自建 GitLab 对 `/changes`、`/diff`、`/discussions` 的响应差异。
3. token scope 和项目角色权限是否足以写 MR note / discussion。
4. PM 在真实模型输出中是否稳定调用多个 `task` 子代理。
5. 子代理 task 输出是否能稳定被 PM 汇总，或是否需要 controller 层直接接 task event。

## 下一步建议

优先级建议：

1. 先修两个本地可确认的偏离点：`blocked` status 映射、空 diff blocked。
2. 再补非法 JSON / 缺字段 JSON fixture。
3. 然后准备真实 GitLab 测试项目，按 dry-run -> live summary -> live inline 三步打开。
4. 最后评估 commit inline comment 是否进入 Phase 1，还是继续保守 summary。
