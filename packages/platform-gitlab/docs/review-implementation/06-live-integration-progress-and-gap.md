# GitLab Review 实测进度与设计差距

## 本轮结论

截至当前分支 `feat/gitlab-review-workflow`，GitLab 代码审查已经从本地 dry-run 推进到真实自建 GitLab 联调闭环。

已经真实验证通过的链路是：

```text
GitLab MR 评论 @Nine1bot review
-> Project Webhook Comments
-> /webhooks/gitlab/{sourceId}/{secret}
-> Automations source secret 校验
-> GitLab note payload 解析
-> MR headSha + noteId 幂等 key
-> GitLab API 拉取 MR changes
-> diff guard / context blocks
-> Runtime 启动 platform.gitlab.pm-coordinator
-> 平台级模型 deepseek/deepseek-chat
-> 捕获 GITLAB_REVIEW_RESULT
-> GitLab MR summary note 回写
```

真实 GitLab 上已看到 Nine1bot 回写 MR 评论，说明 trigger、token、diff、runtime、模型切换、结果发布这条最小闭环已经跑通。

## 本轮优化

### 1. GitLab Review 支持平台级模型切换

新增平台设置：

- `review.modelProviderId`
- `review.modelId`

GitLab review runtime 启动时会优先使用这两个字段作为 `sessionChoice.model`。Web 配置页不要求用户手写模型 ID，而是复用 Chat 页已经配置和认证过的 provider/model 列表，让用户从下拉框中选择。当前实测配置为：

```text
deepseek / deepseek-chat
```

日志已确认真实 session 使用：

```text
providerID=deepseek
modelID=deepseek-chat
```

这避免了 GitLab review 被全局默认模型绑定。本轮遇到的 Kimi 402 也由此绕开。

### 2. GitLab 专用 webhook 桥接 Automations source

现在支持：

```text
POST /webhooks/gitlab/{sourceId}/{secret}
```

该路由复用 Automations source 的 secret，但不会走普通 Automations prompt，而是进入 GitLab review 专用 controller。

当前配置方式：

- Automations 创建 webhook source。
- Platforms -> GitLab 选择或填写 `review.webhookSourceId`。
- GitLab Project Webhook URL 使用 `/webhooks/gitlab/{sourceId}/{secret}`。
- GitLab `Secret token` 可留空。

这比单独维护 GitLab webhook secret 更贴合“Automations 管 webhook，Platforms 管平台能力”的方向。

### 3. 成功发布后清理旧错误

实测 retry 时发现历史 run 可能出现“已经 published/succeeded，但仍残留旧 error”的状态污染。

已修复：

- `publishGitLabReviewRunResult` 成功发布后会清理 `error`。
- 单测覆盖：先把 run 标记为 failed 并写入旧 error，再发布成功，最终 `error` 必须为空。

### 4. 平台详情 GET 同步配置

实测重启后发现平台详情页可能看到旧 manager snapshot，导致配置文件里已有模型字段但页面 GET 看不到。

已修复：

- `GET /nine1bot/platforms`
- `GET /nine1bot/platforms/:id`

都会先从配置文件同步 manager，再返回详情。平台页刷新后能看到当前 GitLab review 模型配置。

### 5. 模型配置成对校验

新增校验：

- 只填 `review.modelProviderId` 而没填 `review.modelId` 会报错。
- 只填 `review.modelId` 而没填 `review.modelProviderId` 会报错。

避免 runtime 创建 session 时拿到半截模型配置。

本轮补充优化：

- Platforms -> GitLab 的 Review model 改为组合下拉选择。
- 下拉选项来自同一份 Chat provider/model 配置。
- 只展示已认证 provider 下的模型，避免未配置模型造成选择噪声。
- 选择 “Use default chat model” 会清空 GitLab review 专用模型配置，回退到默认模型。

### 6. Runtime sources 状态污染修复

实测平台详情接口时发现 agents/skills 已经注册成功，但 `runtimeSources` 里仍残留 “declared but not registered” 的旧错误文案。

已修复：

- `PlatformAdapterManager.runtimeSourcesForRecord` 按每个 source 自己的最终状态决定是否输出 `error`。
- 已注册的 source 只展示 `status: registered`，不再携带误导性错误。
- 单测覆盖 registered source 的 `error` 必须为空。

### 7. GitLab 平台页配置引导增强

平台页现在直接面向真实 GitLab 联调流程展示配置重点：

- 显示 GitLab review 专用 Project Webhook URL：`/webhooks/gitlab/{sourceId}/{sourceSecret}`。
- 明确 GitLab 侧应使用 Project Webhook。
- 明确勾选 `Comments` / `Note events`，用于 `@Nine1bot review` 触发。
- 明确勾选 `Merge request events`，用于后续自动审查模式。
- 明确 GitLab 的 `Secret token` 字段留空，因为 Automations source secret 已经在 URL path 中校验。
- 支持刷新 linked Automations source secret，并生成新的完整 GitLab review URL。
- Review model 使用已认证 Chat providers 的模型下拉选择，不再要求用户手写 provider/model id。

### 8. PM 输出契约收紧

已重写 `platform.gitlab.pm-coordinator` agent prompt 和 `platform.gitlab.review-finding-schema` skill：

- 小型/低风险 diff 走 fast path，PM 可直接审查并在同一轮输出结果，减少不必要的多轮子代理调用。
- 高风险 diff 才按风险域派发架构、前端、QA、安全、规格子代理。
- 最终输出硬性要求为一个 fenced JSON block。
- fence 内第一行必须是 `GITLAB_REVIEW_RESULT:`。
- `stage` 固定为 `closed`。
- `status` 只能是 `ok`、`blocked`、`failed`。
- `findings` 和 `nextActions` 必须是数组。
- 行号不确定时必须省略，交给 publisher 做 summary fallback。

### 9. 真实失败路径 MR / Commit 回写

除了 run store 记录失败，现在以下失败路径会尽力向 GitLab 写一条短失败说明：

- GitLab changes 拉取失败。
- Runtime session 启动失败。
- Controller message 未被接受，例如 agent not found。
- Runtime 成功结束但缺失 `GITLAB_REVIEW_RESULT`。
- Runtime 失败，例如模型 402、模型服务错误、超时等。
- GitLab review result 发布失败。
- GitLab token 缺失时会记录失败；若没有 token 则无法回写 GitLab，这是预期限制。

失败回写会写入 `failureNotifiedAt`，避免同一个 run 重复刷失败评论。

## 已完成内容对照设计稿

| 设计项 | 当前状态 | 说明 |
| --- | --- | --- |
| GitLab 插件边界 | 已完成 | GitLab API、diff、event parser、publisher、agents、skills 都在 `packages/platform-gitlab`。 |
| Runtime 不绑定 GitLab 类型 | 基本完成 | Runtime route 启动通用 session；GitLab 类型校验和发布在 controller/platform 层。仍有 route import controller 的工程边界可后续再抽。 |
| Web UI 显式启用 | 已完成 | `review.enabled` 默认关闭，Platforms 页面可配置。 |
| Automations source 绑定 | 已完成 | GitLab review 可绑定 Automations webhook source，并使用专用桥接 URL。 |
| Bot mention 触发 | 已真实验证 | MR 评论 `@Nine1bot review` 已触发真实 review run。 |
| MR webhook 自动触发 | 代码已支持 | `review.webhookAutoReview` 控制；真实联调主要验证了 comment trigger。 |
| GitLab API token 检查 | 已完成 | 连接测试会检查 token self、active/revoked、`api` scope。 |
| MR diff 拉取 | 已真实验证 | 自建 GitLab 项目 MR changes 已被拉取并进入 context。 |
| 幂等 key 绑定 headSha | 已完成 | MR key 包含 `headSha`；comment trigger 额外包含 `noteId`。 |
| diff overflow / empty diff 阻断 | 已完成 | 单测覆盖 overflow、too large、非黑名单 source 空 diff。 |
| 噪声文件过滤 | 已完成 | lock、构建产物、多媒体、generated 等会过滤。 |
| inline position validator | 已完成 | hunk 校验和 GitLab 400 fallback 单测覆盖。 |
| summary note 发布 | 已真实验证 | Nine1bot 已向真实 MR 写入 summary note。 |
| commit summary review | 已完成 | commit mention 可拉 diff 并写 commit summary comment。 |
| commit inline review | 未完成 | 当前仍保守使用 commit summary。 |
| PM 主代理 runtime 启动 | 已真实验证 | `platform.gitlab.pm-coordinator` 已被真实 Runtime session 启动。 |
| 平台级模型切换 | 已完成并实测 | GitLab review 可配置 `deepseek/deepseek-chat`。 |
| skills 注入 | 已真实验证 | session spec 中包含 GitLab review skills。 |
| PM 派生多子代理 | 部分完成 | agents/skills 已注册，PM prompt 允许 task 派生；尚未验证真实并行子代理闭环。 |
| deterministic finding 聚合 | 已完成 | `subagent-result-compiler` 和 aggregator 单测覆盖。 |
| failureMode | 部分完成 | GitLab review 类型和 compiler 支持；Runtime task 工具尚未原生支持 timeout/failureMode 参数。 |
| dry-run harness | 已完成 | changes、webhook、runtime-output、subagents 多模式可跑。 |
| run store 持久化 | 已完成 | JSON store、limit、retryCount、lastRetryAt、publishedAt 已有。 |
| failed run retry | 已完成并实测 | Kimi 失败后切 DeepSeek 重试成功。 |
| Web run 详情 | 部分完成 | 已展示 run 列表、状态、warnings、error、retry；仍可继续优化可读性。 |
| Runtime sources 状态展示 | 已完成 | registered source 不再残留未注册错误，平台健康状态更可信。 |
| GitLab 配置引导 | 已完成 | 专用 URL、Comments/Note events、Secret token 留空、模型选择说明已落到平台页。 |
| PM 输出契约 | 已完成 | PM prompt 和 finding schema 已收紧，降低缺失 `GITLAB_REVIEW_RESULT` 的概率。 |
| 失败路径 GitLab 回写 | 已完成 | runtime/model/output/publish 等失败会尽力写 MR 或 commit failure note。 |

## 当前差距

### 1. 真正的多 agent 并行还没有端到端证明

当前已经证明 PM 主代理能启动，skills 能注入，DeepSeek 能完成最小 review 并回写评论。

还没有证明：

- PM 会稳定调用 `task` 创建 QA / Security / Architect 等子代理。
- 子代理输出能稳定回到 PM 并被 PM 按 schema 汇总。
- 大型 MR 下 PM 的任务拆分、文件隔离、最小验证集策略能稳定执行。

下一步应设计一个更复杂的测试 MR，包含：

- 一个前端或 TypeScript 文件。
- 一个潜在安全风险。
- 一个测试缺口。

用它验证 PM 是否会派发 QA 和 Security。

### 2. runtime task 的 failureMode 仍是 workflow 约定，不是底座能力

设计稿希望 `SubagentTaskSpec` 有：

```ts
failureMode: 'abort-run' | 'ignore' | 'fallback'
timeoutMs: number
```

当前 GitLab review 层和 dry-run compiler 已支持这些语义，但 opencode runtime 的通用 `task` 工具还没有把这两个字段作为原生参数。

短期可以接受：

- PM prompt 和 workflow skill 约束行为。
- controller/compiler 负责 deterministic 聚合。
- 最终报告把失败子任务作为 warning。

中期需要决定：

- 扩展通用 `task` 工具。
- 或新增 review workflow compiler，把 failure policy 留在产品层。

### 3. 输出契约还依赖 PM 自觉产出 fenced JSON

当前做法是从 runtime 文本流中提取 `GITLAB_REVIEW_RESULT` fenced JSON。

优点：

- 不改 runtime core。
- 已经能真实发布。

问题：

- 模型可能多轮工具调用后才输出结果。
- 输出格式不稳定时只能失败并 retry。

下一步可以增强：

- 在 prompt 中提供更短、更硬的最终输出模板。
- 对缺失 JSON 的 run 在 MR 中写一个失败提示，而不只是 run store failed。
- 后续接入 runtime 原生 structured output 时，把 JSON Schema 传给 runtime，而不是只靠 prompt。

### 4. Webhook 配置体验还可以更顺

当前真实配置里踩过这些坑：

- GitLab 默认可能禁止内网 webhook，需要开启 outbound local network。
- Project Webhook 和 System Hook 容易混淆。
- GitLab `Secret token` 字段容易和 URL path secret 混淆。
- Automations source secret 刷新后，GitLab webhook URL 必须同步替换。

建议在 GitLab 平台页继续优化：

- 显示当前专用 GitLab review webhook URL。
- 明确提示 GitLab `Secret token` 可留空。
- 显示需要勾选 `Comments` / `Note events` 和 `Merge request events`。
- 提供“刷新 source secret 并复制新 URL”的操作。

### 5. commit inline comment 还未实现

当前 commit review 使用 summary comment，比较稳。

如果要支持 commit inline，需要单独验证 GitLab commit comments 的：

- `path`
- `line`
- `line_type`

不能直接复用 MR discussion position。

## 建议下一步

1. 先完善 GitLab 平台页的配置引导。
   重点是专用 webhook URL、Comments/Note events、Secret token 留空、模型配置说明。

2. 做一个复杂一点的真实测试 MR。
   用它验证 PM 是否会派生 QA/Security/Architect 子代理，以及 findings 是否能稳定汇总。

3. 收紧 PM 输出契约。
   优化 PM prompt 和 review-finding-schema skill，减少多轮循环和缺失 `GITLAB_REVIEW_RESULT` 的概率。

4. 给真实失败路径补 MR 回写。
   例如模型 402、Agent not found、缺失 JSON、GitLab API publish 失败时，run store 之外也可以向 MR 写一条简短失败说明，方便用户从 GitLab 页面知道发生了什么。

5. 评估是否扩展 runtime task。
   如果真实多 agent review 频繁需要 timeout/failureMode，就进入底座能力设计；否则先保持 workflow 层约定。
