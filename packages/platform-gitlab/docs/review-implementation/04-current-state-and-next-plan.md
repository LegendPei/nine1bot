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
  - webhook note fixture
  - `review:dry-run:webhook` 可在无真实 GitLab/Runtime 的情况下跑通 webhook parse、context build、stage result 和 mock publish
  - `review:dry-run:runtime-output` 可注入 PM 最终文本，验证 `GITLAB_REVIEW_RESULT` 提取和 mock publish

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
- 当前 `ReviewRunStore` 已从纯内存实现升级为 JSON 文件持久化实现：
  - 默认路径：Nine1Bot data dir 下的 `review-runs.json`
  - 支持按 `idempotencyKey` 跨进程重启去重
  - 持久化 trigger、context、sessionId、turnSnapshotId、warnings、publishedAt 等发布/重试所需上下文
  - 默认最多保留最近 500 条记录，可通过 `NINE1BOT_REVIEW_RUN_STORE_LIMIT` 调整
  - `GET /webhooks/gitlab/runs` 支持 `limit` 查询参数，默认 UI 拉取最近 50 条
- webhook 当前链路：
  - 校验 GitLab webhook token
  - 解析 MR / note webhook
  - 应用 settings 和 allowlist
  - 计算 idempotency key
  - 对已 accepted 的 run 做幂等去重
  - 非 dry-run 时拉取真实 MR changes
  - commit mention 触发时拉取真实 commit diff
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
- session 成功结束但没有捕获到合法 `GITLAB_REVIEW_RESULT` 时，run 会标记为 `failed`，错误为 `gitlab_review_result_missing`，避免未发布结果被误判为成功。

### 结果发布

已实现：

- 产品层 `publishGitLabReviewRunResult`。
- 平台包 `publishGitLabReviewResult`。
- publisher 会发布：
  - 通过校验的 inline discussions
  - 最终 top-level summary note
  - inline fallback 详情
- commit review 采用保守发布策略：
  - 拉取 `/repository/commits/:sha/diff`
  - 向 `/repository/commits/:sha/comments` 写顶层 summary
  - 暂不使用 MR discussion position 生成 commit inline comment
- dry-run 下不会触碰 GitLab，会返回拒绝发布结果。

### Web UX

已实现：

- 通用平台配置页已经能展示 GitLab review descriptor 中的开关和密钥字段。
- GitLab 平台详情页会额外展示最近的 GitLab Review Runs：
  - run id
  - MR / Commit 对象
  - status
  - updatedAt
  - published 标记
  - sessionId、turnSnapshotId、warnings、error 等细节摘要
- GitLab 平台详情页展示最小配置指引：
  - webhook 路径 `/webhooks/gitlab`
  - 启用顺序
  - webhook secret 与 GitLab API token 权限提示
- Web API client 新增 `gitLabReviewApi.runs()`，读取 `/webhooks/gitlab/runs`。

## 已验证命令

已通过：

- `bun test` in `packages/platform-gitlab`
- `bun run typecheck` in `packages/platform-gitlab`
- `bun test packages/nine1bot/src/review/gitlab-controller.test.ts`
- `bun test packages/nine1bot/src/platform/manager.test.ts`
- `bun run review:dry-run fixtures/review/sample-mr-overflow.json`
- `bun run review:dry-run:webhook` in `packages/platform-gitlab`
- `bun run review:dry-run:runtime-output` in `packages/platform-gitlab`
- `bun run typecheck` in `opencode/packages/opencode` 已再次验证，仍只失败在 workspace 包 `@nine1bot/platform-protocol` 的 standalone 解析问题上。

已知验证 caveat：

- 在 `opencode/packages/opencode` 内单独运行 `bun run typecheck` 仍会失败，因为该包的 standalone typecheck 当前解析不到 workspace 包 `@nine1bot/platform-protocol`，并连带把外部包类型推成 implicit any。这是当前 monorepo 跨包 typecheck 边界问题，不是 GitLab route 自身新增类型错误。

## 设计对比

| 领域 | 原设计 | 当前状态 | 差距 |
| --- | --- | --- | --- |
| GitLab 包边界 | GitLab 专属代码放在 `platform-gitlab` | parsing、diff、API、publishing、skills、agents 已放入 | Phase 0/1 无明显差距 |
| Agents / skills | Runtime 执行 PM，PM 用 skills 创建自定义子代理 | 资产已注册，PM/子代理 prompt 已收紧为 GitLab review 只读模式 | 还需要真实 subagent task tool contract 的端到端验证 |
| Web 配置开关 | 默认关闭，通过平台设置启用 | descriptor 已暴露配置项，默认关闭；GitLab 平台详情页已展示 review runs、webhook 路径和基础配置指引 | 还需要更完整的 token scope 校验与可复制公网 webhook URL |
| Webhook 触发 | GitLab MR / note webhook 与 `@Nine1bot` | `/webhooks/gitlab` 已解析 MR 和 note payload，commit mention 已能拉 diff 并写 summary | commit inline comment 暂未实现 |
| 幂等性 | MR key 必须包含 `headSha` | 已实现并测试，run store 已持久化 | 后续可增加过期/清理策略 |
| Diff 安全 | 过滤噪声，overflow 阻断 | 已实现并测试 | 需要更多真实 GitLab 大 MR payload fixture |
| Inline 安全 | 校验 hunk，非法或 400 fallback | 已实现并测试 | 当前阶段无明显差距 |
| Map-reduce findings | 代码侧聚合后交给 PM | aggregator 已实现 | 尚未接真实多 agent stage outputs |
| Runtime 边界 | Runtime 只处理通用 schema/result | review 类型由 platform/controller 拥有，自动控制器只暴露通用 runtime output | 当前阶段无明显差距 |
| Runtime 结果捕获 | PM 最终结构化结果自动发布 | 已从 `message.part.updated` 捕获 fenced JSON 并发布 | 还需要真实端到端 fixture 覆盖 streaming 与异常输出 |
| Failure policy | subagent spec 包含 `failureMode` | 类型和初始 task specs 已有 | Runtime 内 PM 创建子代理的实际 tool contract 仍需确认/实现 |
| Dry-run harness | 初期必须有 | 已支持 changes fixture、webhook fixture、PM 输出文本注入，本地可跑通 mock publish | 后续可补非法 JSON、GitLab 400 fallback 等更多失败 fixture |

## 下一步计划

### 1. Runtime 结果捕获加固

目标：让结果捕获在真实 streaming、异常输出和重试场景下更稳。

任务：

- 为 `onRuntimeOutput` 增加更贴近真实 session event 的单元或集成测试。
- 补充 PM 输出不合法 JSON 时的 fixture 覆盖。
- 扩展 dry-run harness，使其能注入一段 PM 输出文本并验证自动发布链路。
- 验证 PM 通过 runtime subagent/task 能力创建自定义子代理时，promptRef、skills、timeout、failureMode 能被正确传入。

### 2. Commit Inline Comment 增强

目标：在保守 summary 发布之外，评估是否支持 GitLab commit 行级评论。

任务：

- 调研并验证 GitLab commit comments 的 `path`、`line`、`line_type` 参数在不同 GitLab 版本中的行为。
- 设计与 MR inline position 分离的 commit line validator。
- 仅在代码侧校验通过时启用 commit inline；否则继续 summary fallback。

### 3. ReviewRun 运维增强

目标：在已持久化的基础上补齐可运营能力。

任务：

- 增加 run 记录过期或最大数量清理策略，避免长期无限增长。
- 为手动重试设计状态流转：允许 failed/blocked run 复制上下文后重新执行。
- 在 Web UI 中进一步展示 sessionId、turnSnapshotId、warnings 和错误详情。

### 4. Web UX 增强

目标：在已有配置表单和 Review Runs 状态块基础上补齐引导体验。

任务：

- 如果 generic platform form 不够清晰，增加 GitLab 专属帮助文案或 custom component。
- 展示 webhook URL：`/webhooks/gitlab`。
- 展示 token 权限建议、GitLab webhook 配置步骤和 dry-run 调试入口。
- 为 blocked、duplicate、published、failed 状态增加更清晰的说明。

### 5. 端到端测试桩增强

目标：在当前本地桩基础上覆盖更多真实失败模式。

任务：

- 增加非法 JSON、缺字段 JSON、blocked diff、inline fallback、GitLab 400 fallback 的 fixture 模式。
- 如后续 Runtime subagent/task contract 固定，再把 dry-run 扩展到 prompt assembly 边界。

## 当前提交栈

当前分支：`feat/gitlab-review-workflow`

相关提交：

- `f6e439e feat(gitlab): add review workflow foundation`
- `ce7d02d feat(gitlab): add review webhook entry`
- `8043ed9 feat(gitlab): run review workflow from webhook`
- `7e4aa9d feat(gitlab): publish review results`
- `afda183 feat(gitlab): expose review run publish api`
- `37da37c docs(gitlab): record review implementation state`
