# GitLab Review 项目归属、CI/CD 与上下文管线实施计划

> 本文记录 2026-08-06 确认的下一轮改进方案。它是实施计划，不改变已经稳定的 webhook、MR review、回写和幂等行为。

## 目标

将 GitLab Review 从“按一次 webhook 创建的通用审查任务”升级为“隶属于明确 GitLab 项目的审查任务”。以 `root/uftest` 为第一个项目档案：该仓库的说明、架构知识、审查重点和上下文预算只用于该仓库触发的 review。

同时，将 GitLab CI/CD 作为可选的审查证据接入：存在与可读取的 pipeline 时注入状态、失败 job 和受控日志摘要；不存在、尚未完成、无权限读取或 API 失败时记录降级状态，但不得阻断 review 创建、运行、发布或重试。

## 已确认决策

- 项目配置采用“结构化表单字段 + 可选 Markdown 项目说明”。
- 项目说明是项目私有的系统上下文，不进入普通 Web 对话，不跨项目复用。
- 每个 `ReviewRun` 必须固化项目身份和项目配置快照，历史 run 不因后续编辑项目配置而改变归属或证据。
- CI/CD 仅是增强上下文，第一版不作为 review 发布门禁，也不触发、重跑、取消或修改 GitLab pipeline。
- 不让模型直接执行 GitLab CLI 或 API；读取 GitLab 仍经 `GitLabApiClient`，上下文组装仍由 platform-gitlab 的纯函数完成。
- 长上下文采用“冻结、分层、受预算控制的 context packet”，借鉴 `best-copilot` 的 bounded packet 与渐进加载原则，但不引入其多代理运行时和仓库记忆文件模型。[参考仓库](https://github.com/funky-eyes/best-copilot)

## 当前差距

| 领域 | 当前状态 | 本轮补齐 |
| --- | --- | --- |
| 项目归属 | webhook trigger 含 `projectId/projectPath`，`ReviewRun` 未有稳定项目实体 | 新增项目档案匹配、配置快照和对外展示字段 |
| 项目知识 | 仅有全局 scope 和 review 参数 | 项目专属 Markdown 说明、审查重点、路径规则与预算 |
| CI/CD | 未调用 pipeline/job API | 读取 MR HEAD 对应 pipeline，摘要失败 job 和受限日志 |
| 长 diff | `maxFiles/maxDiffBytes` 后按文件整体取舍 | 文件优先级、hunk 切片、摘要和裁剪清单 |
| 上下文边界 | trigger 和 diff manifest 为固定 context blocks | 增加项目、CI、diff slices 四层上下文包，并冻结到 run |
| Web 管理 | GitLab 设置偏全局 | 项目档案列表、编辑、校验和 run 项目筛选/展示 |

## 目标架构

```text
GitLab webhook / @Nine1bot
  -> event-parser 解析 GitLabReviewTrigger
  -> GitLabProjectProfileResolver 按 host + projectId 匹配项目档案
  -> ReviewRun 创建并持久化 projectSnapshot
  -> GitLabApiClient 读取 MR diff 与可选 CI/CD 证据
  -> ReviewContextPacketBuilder 受预算组装：项目 -> CI -> diff manifest -> diff slices
  -> Runtime 执行既有 GitLab review workflow
  -> ReviewRun 和 GitLab 回写都保留项目归属与证据摘要
```

上下文包固定为四层，优先级从高到低如下：

1. **项目层**：项目身份、Markdown 说明、审查重点、路径规则、非目标和项目级预算。
2. **CI 层**：MR HEAD SHA 对应 pipeline 摘要；仅包括状态、web URL、失败/取消 job 的名称、阶段、失败原因和脱敏截断日志。
3. **变更清单层**：全部变更文件、过滤原因、切片与裁剪统计。
4. **Diff 证据层**：按排序后的文件和 hunk 生成的可审查片段，带文件路径、old/new line 范围和被省略标记。

模型提示只能依据实际提供的 diff slice 形成代码 finding；CI 日志只作为失败症状和验证线索，不能替代代码证据。所有层的来源、字节数、截断原因和 API 读取错误都写入可展示的 `contextDiagnostics`，而不是被静默丢弃。

## 数据模型与配置

### 项目档案

在 `GitLabReviewSettings` 下新增 `review.projects`，项目的唯一匹配键为 `(host, projectId)`；`pathWithNamespace` 只用于显示、人工校验和项目搜索，不作为唯一键。

```ts
type GitLabReviewProjectProfile = {
  id: string
  host?: string
  projectId: string | number
  pathWithNamespace?: string
  displayName?: string
  enabled: boolean
  contextMarkdown?: string
  reviewFocus?: string[]
  includePathPrefixes?: string[]
  excludePathPatterns?: string[]
  maxContextBytes?: number
  maxFiles?: number
  ci: {
    enabled: boolean
    includeFailedJobLogs: boolean
    maxFailedJobs: number
    maxJobLogBytes: number
  }
}

type GitLabReviewProjectSnapshot = Omit<GitLabReviewProjectProfile, 'contextMarkdown'> & {
  contextMarkdown?: string
  matchedAt: number
}
```

规则：未配置项目档案但仍在现有 scope 中的项目保持可审查，使用一个由 trigger 派生的“无档案快照”，并附 `project_profile_missing` warning。这样升级不影响已接入项目；配置了项目档案且 `enabled=false` 时，明确拒绝并记录 `project_profile_disabled`。

`ReviewRunRecord` 新增 `project?: GitLabReviewProjectSnapshot`、`contextDiagnostics?: GitLabReviewContextDiagnostics` 和 `ci?: GitLabPipelineSummary`。webhook 路由的 public DTO 仅暴露安全字段，不能返回完整项目 Markdown、原始 job trace、token 或 GitLab API 错误正文。

## CI/CD 证据策略

`GitLabApiClient` 新增只读方法：

```ts
getMergeRequestPipelines(projectId, mrIid): Promise<GitLabPipelineSummary[]>
getPipelineJobs(projectId, pipelineId): Promise<GitLabPipelineJob[]>
getJobTrace(projectId, jobId): Promise<string>
```

选择规则：优先 `sha === trigger.headSha` 的最新 pipeline；若 GitLab API 未返回 sha 匹配项，则不猜测关联关系，标记 `pipeline_not_found_for_head_sha`。只读取失败、取消或手动阻塞的前 N 个 job；日志先清除 ANSI 控制符和可能的密钥形式，再截断到项目预算。`

所有以下情况均返回“CI 证据不可用/不完整”诊断并继续 review：无 MR、无 HEAD SHA、无 pipeline、pipeline running、token 缺失、403/404、超时、单个 job trace 读取失败。只有 diff 自身的既有硬阻断仍可阻断 review。

## 长上下文切片策略

在保留现有文件黑名单和 diff overflow 保护的前提下，引入 `GitLabReviewContextPacketBuilder`。它不读网络、不读本地仓库，只消费 webhook、项目快照、CI 摘要和 GitLab changes 响应，因而可用 fixture 做确定性测试。

### 文件排序

按以下顺序排序，排序结果和理由写入 manifest：

1. 匹配项目 `includePathPrefixes` 或 review focus 的文件。
2. 安全、鉴权、数据库、配置、依赖、CI 定义等高风险路径。
3. 改动行数与 hunk 数较少但可完整提供的业务文件。
4. 其他普通源码文件。

项目 `excludePathPatterns` 在全局黑名单之后执行；它仅排除模型上下文，不改变 GitLab 的真实 diff 或已有 inline 定位逻辑。

### 文件内 hunk 切片

- 先完整保留高优先级文件的 hunk，直到耗尽 diff 预算。
- 单文件过大时，按 hunk 而不是按字符串中间位置截断；每片带稳定 `sliceId`、路径、行范围和 byte 数。
- 当前实现对单个超过剩余预算的 hunk 整体省略并记录 `budget-exceeded`，不会截断在半行或伪造行号。首尾带行号窗口仍是后续增强项，不能在验收结论中声称已经支持。
- 被跳过的文件和 hunk 都进入 `omissions`，包括原因 `budget-exceeded`、`profile-excluded`、`large-hunk-truncated`。
- 预算分配先预留项目层和 CI 层，再将剩余预算用于 diff；任何可选层超预算均先缩减自身，不能挤掉项目身份或 diff manifest。

第一版不做向量检索、代码库全量索引或跨 MR 长期记忆；这些会引入索引一致性、权限和成本问题，且不满足当前 MR diff review 的最小闭环。

## 分批实施计划

### Batch 1：项目档案与 ReviewRun 归属

**状态：已完成（2026-08-06）**

已实现项目档案归一化与 `(host, projectId)` 匹配；`ReviewRun` 已持久化项目快照。未建档但在 scope 内的项目继续执行并记录 `project_profile_missing`，禁用项目档案会创建 rejected run；公开 run DTO 仅返回项目摘要，未暴露项目 Markdown 或策略字段。

**范围**

- 修改 `packages/platform-gitlab/src/review/types.ts`、`settings.ts`，定义、归一化并校验项目档案。
- 新增 `packages/platform-gitlab/src/review/project-profile.ts`：按 `(host, projectId)` 匹配档案、生成无档案快照、返回拒绝/告警结果。
- 修改 `packages/nine1bot/src/review/run-store.ts` 与 `gitlab-controller.ts`：创建 run 前解析项目档案，持久化 `project` 快照。
- 修改 `opencode/packages/opencode/src/server/routes/webhooks.ts`：列表和详情响应返回脱敏项目摘要。
- 增加 platform-gitlab 与 nine1bot controller/store 的单测与旧 run JSON 兼容测试。

**验收**

- `root/uftest`（project id 3）触发 review 后，run 记录和 API 响应都有稳定的项目名称、路径、项目 ID 与快照版本。
- 同项目的后续配置修改不改变历史 run 的项目快照。
- 未建档但在当前 allowlist 内的项目仍可审查且带 warning；禁用档案的项目被确定性拒绝。

### Batch 2：可降级 CI/CD 上下文

**状态：已完成（2026-08-06）**

已接入 MR pipeline、pipeline jobs 与 job trace 的只读 API；仅精确匹配当前 HEAD SHA。异常 job trace 会脱敏并截断后注入 context，`ReviewRun.ci` 仅持久化 pipeline 摘要和 diagnostics。无 pipeline、token 缺失或 API 读取失败不会阻断 review。

**范围**

- 扩展 `packages/platform-gitlab/src/review/api-client.ts`，加入 pipeline、job 与 trace 的只读 API 和类型。
- 新增 `packages/platform-gitlab/src/review/pipeline-context.ts`，负责 HEAD SHA 匹配、job 选择、trace 清理/截断、诊断输出。
- 扩展 `context-builder.ts` 与 `gitlab-controller.ts`，仅对 MR review 在 token 可用时加载 CI 证据；任何 CI 失败走降级路径。
- 扩展 review prompt 和发布摘要，显示 pipeline 状态及“未读取/不完整”原因，不把 CI 状态写成代码 finding。
- 使用 mock fetch 覆盖 success、failed、running、missing、403、trace 失败与超预算日志。

**验收**

- UFtest MR 的成功/失败 pipeline 出现在 context diagnostics 中；失败 job 的日志摘要有上限且不含 ANSI 控制序列。
- GitLab 无 pipeline、token 无效或 job trace 失败时，review 仍进入 runtime 并能够发布。
- 不产生 GitLab CI/CD 的任何写操作。

### Batch 3：冻结上下文包与 diff 切片

**状态：已完成（2026-08-06）**

已新增 hunk 边界切片器并接入 review context/runtime prompt；模型只消费 slices，裁剪的 hunk 会以 omission 形式显式呈现。既有 diff manifest、GitLab overflow 防护和 inline position 校验保持不变。

**范围**

- 新增 `packages/platform-gitlab/src/review/context-packet.ts` 和 `diff-slicer.ts`，将项目、CI、manifest 与 slice 组成确定性 packet。
- 让 `context-builder.ts` 从全量文件 diff 改为消费 packet，保持 `buildGitLabReviewContext` 的调用边界尽量稳定。
- 修改 `gitlab-controller.ts` 的 runtime prompt：渲染 slice 与 omissions，禁止模型声称审查了未提供的内容。
- 对已有 `diff-builder.ts` 的 global blacklist、overflow 和 inline position 依赖做回归保护；切片只影响模型输入，不破坏发布定位。
- 建立 large MR fixtures，覆盖多文件预算竞争、单 hunk 超限、项目 include/exclude、CI 预算预留和同输入确定性。

**验收**

- 相同输入在不同运行中得到相同 slice 顺序、内容和 diagnostics。
- 任意模型输入均不超过配置预算；切片不会截断在半行或伪造行号。
- prompt 中存在清晰 omissions，且 finding 只能引用实际提供文件/行范围。

### Batch 4：配置页、运行记录与 GitLab 联调

**状态：实现完成，真实 GitLab 联调待有效凭据（2026-08-06）**

已复用现有 PlatformManager 动态设置保存通道，而非新增硬编码配置页：项目搜索结果可直接创建审查档案；档案支持启用状态、显示名称、审查关注点、私有 Markdown 上下文和 CI 证据开关/失败任务上限。Review Runs 现展示项目归属与 pipeline 摘要、诊断信息。`publicGitLabReviewRun` 对 `ci` 使用字段白名单，防止未来实现误将 trace 等重型或敏感字段带到浏览器。真实联调仅缺少有效 GitLab token 与可访问的测试 MR；不应以过期 token 或本地伪造凭据绕过该验证。

**范围**

- 定位当前 GitLab 配置页的数据源，复用已完成的 Feishu 平台配置模式；提供项目档案列表、搜索项目、编辑表单和 Markdown 上下文编辑器。
- 表单字段包括项目、启用状态、显示名、审查重点、include/exclude 路径、总上下文预算、CI 开关、失败 job 数、日志预算与项目说明。
- 在 review runs 列表和详情中展示项目归属、pipeline 摘要、context diagnostics、切片/省略统计；默认不展示 Markdown 全文或原始日志。
- 为前端状态、配置 round-trip、路由 DTO 与空/错误态补测试。
- 使用有效 GitLab token 在 UFtest 完成真实 MR 联调：项目匹配、pipeline 可用与不可用、手动 mention、自动 webhook、结果回写、重试与幂等。

**验收**

- 用户可以在 GitLab 配置页创建并保存 UFtest 项目档案，无需手改配置文件。
- 一个 UFtest review 在页面、run API、runtime prompt 和 GitLab 回写中都可追溯到 UFtest。
- CI 不存在或读取失败的真实 MR 仍能完成 review；存在失败 pipeline 时审查结果可辨认其证据状态。

### Batch 5：合并前稳定性与安全加固

**状态：已完成（2026-08-08）**

分支基于最新 `origin/main` 重整后完成两轮代码审查，并修复最终审查发现的预算、实例身份、幂等、CI 降级和响应体边界问题。

**完成项**

- context builder 直接生成最终 `diffEvidence`；项目、CI、精简 manifest、实际渲染的 hunk、跳过项和 omission 摘要共享同一字节预算。跳过/省略详情有数量和路径长度上限，controller 不再从原始 manifest 二次展开。
- diff 文件名、代码行、项目 Markdown、用户 mention 和 CI/job trace 均以明确的 untrusted JSON evidence 注入；原始用户指令不再重复进入 system-required trigger block。
- GitLab authority 在后端与 Web 统一按小写 `host[:port]` 规范化；同主机不同端口保持隔离，旧的无 host 档案不会跨实例匹配。
- 幂等检查先于项目禁用策略执行；禁用档案产生的 rejected run 保存项目快照，配置变化不会让同一已接受事件生成第二条 run。
- CI token 读取和整个可选 CI 分支纳入独立降级边界；单 job trace 失败不丢失其他 pipeline 证据，CI 异常仍不阻断 review。
- GitLab API 请求覆盖连接与响应体读取超时；JSON、错误正文和 trace 均流式限量读取，到达上限时取消未消费流。`**/` 排除规则同时匹配仓库根目录和嵌套目录。

**验证结果**

- `bun run ci:test`：410 个测试通过，0 失败。
- `bun run ci:typecheck`：全部 package 及 Web 类型检查通过。
- `bun run build:web`：生产构建通过；仅保留既有的大 chunk 提示。

**仍保留的边界**

- GitLab 返回 `overflow` 或 `too_large` 且无法提供可信 diff 时继续硬阻断，不会依据不完整页面内容猜测审查结果。
- 单个 hunk 大于全部剩余预算时当前整体省略；尚未实现首尾窗口切片。
- 本轮不提供仓库级语义检索、向量索引或跨 MR 长期记忆；大 PR 优化仍以文件优先级、hunk 边界切片、确定性预算和显式 omission 为主。

## 稳定性与安全约束

- 项目档案匹配只信任 GitLab webhook 解析出的 host/project ID，不信任用户评论中的项目文字。
- 项目 Markdown、job trace 与用户 mention 都是非指令性数据；分别用显式标签包裹，继续沿用现有 prompt-injection 风险处理。
- 原始 trace、PAT、webhook secret、完整 API 错误正文不得存入 `ReviewRunStore`、对外路由响应、日志或 GitLab 评论。
- CI API 读取需有每次 review 的最大请求数和超时；一次失败不触发无限重试。
- run store 继续兼容 `version: 1` 的旧记录，新增字段均可选；读取旧 run 时以 `project: undefined` 表示历史无归属。
- 所有项目配置变更通过现有 config-store 原子写入；secret 继续只由 platform secret store 管理。

## 测试矩阵

| 层级 | 关键用例 |
| --- | --- |
| 纯函数 | 项目匹配、配置归一化、无档案降级、禁用拒绝、排序、hunk 切片、预算和 omission |
| GitLab API client | pipeline/job/trace 路径、分页/空响应、非 2xx、日志内容读取 |
| Controller | run 快照、CI 成功/失败/缺失、CI 降级不阻断、prompt 内容、幂等与 retry |
| Store/路由 | 旧 run 兼容、脱敏 DTO、项目和诊断展示 |
| Web | 表单保存/重载、项目编辑、空态、错误态、run 归属展示 |
| 真实联调 | UFtest MR 的有 CI、无 CI、失败 CI，以及真实 comment 回写 |

## 实施顺序与提交建议

1. `feat(gitlab): persist project review profiles and run snapshots`
2. `feat(gitlab): add optional pipeline evidence to reviews`
3. `feat(gitlab): slice review context within deterministic budgets`
4. `feat(web): manage gitlab project review profiles`
5. `test(gitlab): verify project and pipeline review integration`

每个 batch 完成后先运行其对应的 package test，再运行 GitLab review 全量测试；Batch 4 之前不改变真实 GitLab hook 配置。真实联调必须使用有效且最小权限的 GitLab token，完成后将项目名、MR IID、pipeline 状态和验收结论记录到联调清单，但不记录 token、webhook secret 或完整 job trace。

## 非目标

- 不把 GitLab 能力改造成 MCP，也不向模型暴露裸 GitLab CLI。
- 不引入向量数据库、全仓索引、跨仓库记忆或自动学习项目规则。
- 不将 CI 结果作为发布阻断条件，也不控制 GitLab CI/CD 生命周期。
- 不更改现有 MR/commit review 的触发、幂等、inline comment 降级与失败回写语义，除非本计划明确要求。
