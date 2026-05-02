# GitLab Review 当前产出与下一步计划

## 目标

本文档用于固定当前 GitLab 代码审查功能的实现状态，并把它和最初的设计方案逐项对齐，避免后续继续施工时丢失上下文。

当前功能仍然保持插件化边界：

- GitLab 专属解析、API、diff 规则、agents、skills、评论发布逻辑放在 `packages/platform-gitlab`。
- Nine1Bot 产品层 controller 胶水放在 `packages/nine1bot/src/review`。
- Runtime 仍然保持通用，只接收 agent、session、context、resource 等输入，不导入 GitLab review 业务类型。

## 已完成内容

### GitLab 平台包基础

已在 `packages/platform-gitlab` 实现：

- GitLab review runtime source 声明：
  - agents：`platform.gitlab` namespace，`recommendable`，`platform-enabled`
  - skills：`platform.gitlab` namespace，`declared-only`，`platform-enabled`
- GitLab review 配置项已挂到 platform descriptor：
  - 默认关闭
  - bot mention
  - webhook 自动审查开关
  - inline comments 开关
  - dry-run 开关
  - allowed project ids
  - webhook secret
  - GitLab API token
  - base URL
- 已迁移 review 资产：
  - PM 主代理：`agents/review/pm-coordinator.agent.md`
  - 子代理 prompt skills：`skills/review/subagent-prompts/*/SKILL.md`
  - workflow/policy skills：`skills/review/*/SKILL.md`
- PM 与子代理 prompt 已适配为 GitLab review 专用模式：
  - 默认只读审查，不把任务扩展成通用实现。
  - PM 只负责编排、裁决和最终 ReviewStageResult 输出。
  - 子代理按架构、前端、QA、安全、上下文取证等角色输出统一 JSON findings。
  - developer / auto-fixer 默认 blocked，只有显式 `fixMode=true` 才允许写操作。
- 已提供本地 dry-run 基建：
  - `scripts/review-dry-run.ts`
  - 正常 MR changes fixture
  - overflow MR changes fixture

### 设计审查中提出的安全规则

已实现：

- MR 幂等 key 包含 `headSha`。
- 评论触发场景额外包含 `noteId`。
- diff builder 会过滤噪声文件：
  - lock 文件
  - 构建产物
  - 多媒体/静态大资源
  - generated files
- GitLab diff overflow / too-large 会阻断审查。
- inline comment 在调用 GitLab API 前会先校验目标行是否属于 changed diff hunk。
- inline 行号非法时会降级为 summary Markdown。
- GitLab inline API 返回 `400` 时会降级为 summary Markdown，不让整轮 review 失败。
- QA / Security 等 findings 可以先用代码按文件和行号做确定性聚合，再交给 PM 润色裁决。
- Runtime 面向的是 JSON-compatible schema/result，不拥有 `ReviewFinding` 等 GitLab review 业务类型。
- subagent task spec 已包含 `failureMode`。

### Webhook 与 Controller 入口

已实现：

- 公共 GitLab webhook 入口：
  - `POST /webhooks/gitlab`
- 已认证的 review run 查询和发布 API：
  - `GET /webhooks/gitlab/runs`
  - `GET /webhooks/gitlab/runs/:runId`
  - `POST /webhooks/gitlab/runs/:runId/publish`
- 产品层 controller：
  - `packages/nine1bot/src/review/gitlab-controller.ts`
  - `packages/nine1bot/src/review/run-store.ts`
- 当前 `ReviewRunStore` 是进程内存实现，作为第一版最小闭环。
- webhook 当前链路：
  - 校验 GitLab webhook token
  - 解析 MR / note webhook
  - 应用 settings 和 allowlist
  - 计算 idempotency key
  - 对已 accepted 的 run 做幂等去重
  - 非 dry-run 时拉取真实 MR changes
  - 构建 review context
  - overflow 时阻断并向 MR 写 blocked 评论
  - 非 dry-run、未阻断时启动 Runtime session

### Runtime 启动

已实现：

- 非 dry-run 且未阻断的 GitLab review run 会启动自动化 Runtime session。
- session 使用：
  - agent：`platform.gitlab.pm-coordinator`
  - GitLab review skills 作为 session resources
  - `GitLabReviewContext` 生成的 context blocks
- automated webhook controller 已支持传入 `context.blocks`。
- automated run monitor 已能监听 `message.updated` / `message.part.updated`，并通过通用 `onRuntimeOutput` 回调暴露文本输出；这个回调仍然不包含 GitLab 业务类型。

### Runtime 结果捕获

已实现：

- PM runtime prompt 要求最终输出一个带 `GITLAB_REVIEW_RESULT` 标记的 fenced JSON。
- 产品层提供 `extractGitLabReviewStageResultFromRuntimeText`，只在解析后通过 `parseReviewStageResult` 校验的 JSON 才会被接受。
- GitLab webhook runtime run 会在文本输出中捕获合法结果，并自动调用 `publishGitLabReviewRunResult`。
- `ReviewRunStore` 增加 `publishedAt`，防止同一 run 被 streaming 输出或手动 API 重复发布。
- session idle 时如果已经发布过结果，不再把 run 状态覆盖成普通 `succeeded`。

### 结果发布

已实现：

- 产品层 `publishGitLabReviewRunResult`。
- 平台包 `publishGitLabReviewResult`。
- publisher 会发布：
  - 通过校验的 inline discussions
  - 最终 top-level summary note
  - inline fallback 详情
- dry-run 下不会触碰 GitLab，会返回拒绝发布结果。

## 已验证命令

已通过：

- `bun test` in `packages/platform-gitlab`
- `bun run typecheck` in `packages/platform-gitlab`
- `bun test packages/nine1bot/src/review/gitlab-controller.test.ts`
- `bun test packages/nine1bot/src/platform/manager.test.ts`
- `bun run review:dry-run fixtures/review/sample-mr-overflow.json`
- `bun run typecheck` in `opencode/packages/opencode` 已再次验证，仍只失败在 workspace 包 `@nine1bot/platform-protocol` 的 standalone 解析问题上。

已知验证 caveat：

- 在 `opencode/packages/opencode` 内单独运行 `bun run typecheck` 仍会失败，因为该包的 standalone typecheck 当前解析不到 workspace 包 `@nine1bot/platform-protocol`，并连带把外部包类型推成 implicit any。这是当前 monorepo 跨包 typecheck 边界问题，不是 GitLab route 自身新增类型错误。

## 设计对比

| 领域 | 原设计 | 当前状态 | 差距 |
| --- | --- | --- | --- |
| GitLab 包边界 | GitLab 专属代码放在 `platform-gitlab` | parsing、diff、API、publishing、skills、agents 已放入 | Phase 0/1 无明显差距 |
| Agents / skills | Runtime 执行 PM，PM 用 skills 创建自定义子代理 | 资产已注册，PM/子代理 prompt 已收紧为 GitLab review 只读模式 | 还需要真实 subagent task tool contract 的端到端验证 |
| Web 配置开关 | 默认关闭，通过平台设置启用 | descriptor 已暴露配置项，默认关闭 | 还没有 GitLab 专属引导 UI |
| Webhook 触发 | GitLab MR / note webhook 与 `@Nine1bot` | `/webhooks/gitlab` 已解析 MR 和 note payload | commit diff live fetch 还没接 |
| 幂等性 | MR key 必须包含 `headSha` | 已实现并测试 | store 仍是内存实现 |
| Diff 安全 | 过滤噪声，overflow 阻断 | 已实现并测试 | 需要更多真实 GitLab 大 MR payload fixture |
| Inline 安全 | 校验 hunk，非法或 400 fallback | 已实现并测试 | 当前阶段无明显差距 |
| Map-reduce findings | 代码侧聚合后交给 PM | aggregator 已实现 | 尚未接真实多 agent stage outputs |
| Runtime 边界 | Runtime 只处理通用 schema/result | review 类型由 platform/controller 拥有，自动控制器只暴露通用 runtime output | 当前阶段无明显差距 |
| Runtime 结果捕获 | PM 最终结构化结果自动发布 | 已从 `message.part.updated` 捕获 fenced JSON 并发布 | 还需要真实端到端 fixture 覆盖 streaming 与异常输出 |
| Failure policy | subagent spec 包含 `failureMode` | 类型和初始 task specs 已有 | Runtime 内 PM 创建子代理的实际 tool contract 仍需确认/实现 |
| Dry-run harness | 初期必须有 | 已实现 | 可继续扩展 webhook payload fixture 模式 |

## 下一步计划

### 1. Runtime 结果捕获加固

目标：让结果捕获在真实 streaming、异常输出和重试场景下更稳。

任务：

- 为 `onRuntimeOutput` 增加更贴近真实 session event 的单元或集成测试。
- 补充 PM 输出不合法 JSON 时的 run warning / failed policy。
- 扩展 dry-run harness，使其能注入一段 PM 输出文本并验证自动发布链路。
- 验证 PM 通过 runtime subagent/task 能力创建自定义子代理时，promptRef、skills、timeout、failureMode 能被正确传入。

### 2. GitLab Commit Review

目标：支持 commit 评论触发场景。

任务：

- 在 `GitLabApiClient` 增加 commit diff 拉取方法。
- commit diff 复用当前 filter / overflow guard。
- 通过 `repository/commits/:sha/notes` 发布 commit review note。
- 增加 commit note webhook fixture 和测试。

### 3. ReviewRun 持久化

目标：替换当前内存版 `ReviewRunStore`。

任务：

- 复用项目已有存储模式。
- 按 `idempotencyKey` 持久化 run record。
- 保留发布/重试所需上下文：
  - trigger
  - diff refs
  - manifest
  - warnings
  - sessionId
  - turnSnapshotId
  - publish status

### 4. Web UX

目标：让用户能清楚配置 GitLab review。

任务：

- 如果 generic platform form 不够清晰，增加 GitLab 专属帮助文案或 custom component。
- 展示 webhook URL：`/webhooks/gitlab`。
- 展示 review run 状态：`GET /webhooks/gitlab/runs`。
- 展示 dry-run、blocked、duplicate、published 等状态。

### 5. 端到端测试桩

目标：不用真实 GitLab 项目也能跑通完整链路。

任务：

- 扩展 dry-run CLI，支持 webhook payload fixtures。
- mock GitLab API 的 changes、notes、discussions。
- 增加一条脚本串起：
  - webhook parse
  - live changes fetch mock
  - Runtime prompt/context compile boundary
  - publish fallback paths

## 当前提交栈

当前分支：`feat/gitlab-review-workflow`

相关提交：

- `f6e439e feat(gitlab): add review workflow foundation`
- `ce7d02d feat(gitlab): add review webhook entry`
- `8043ed9 feat(gitlab): run review workflow from webhook`
- `7e4aa9d feat(gitlab): publish review results`
- `afda183 feat(gitlab): expose review run publish api`
- `37da37c docs(gitlab): record review implementation state`
