# GitLab Review 接近 Copilot 体验计划

## 目标

让 Nine1bot GitLab Review 从“顶层总结型机器人”逐步升级为接近 GitHub Copilot Code Review 的体验：

- 能基于 MR diff 给出文件级、行级的审查意见。
- 能在评论中引用对应 diff 片段，避免空泛结论。
- 能在 GitLab inline discussion 可用时落到具体变更行。
- 能在低风险场景给出可应用的 suggestion。
- 所有回写都要可降级，不能因为行号或 GitLab API 限制导致整次 review 失败。

## 当前状态

已经具备的底座：

- GitLab Note/Comments webhook 中 `@Nine1bot` 触发 review。
- 专用 GitLab webhook URL，不嵌入 Automations 通用 webhook。
- MR diff 拉取、黑名单过滤、空 diff / overflow 阻断。
- 以 `head_sha` 为核心的幂等 key。
- PM runtime agent + GitLab skills + 可派生子代理。
- 顶层 MR 评论回写。
- inline position 校验器和 GitLab 400 fallback 机制。
- 模型错误、runtime 错误、发布错误的失败回写。

当前主要差距：

- 顶层评论信息密度低，只列 finding 标题，缺少证据片段。
- inline comments 默认关闭，真实联调还没有稳定打开。
- suggestion 还没有 schema、校验和回写策略。
- PM prompt 对“不要读本地文件、只用 diff”的约束还需要继续收紧。

## 分阶段计划

### Phase 1：增强顶层评论证据展示

目标：即使不开启 inline comments，也能像 Copilot 一样让用户看到“这条意见来自哪段 diff”。

实施项：

- 顶层评论按文件分组展示 findings。
- 每条 finding 展示 severity、title、body、source。
- 如果 finding 带 `file + newLine/oldLine`，从原始 diff 中提取附近 hunk 片段。
- 如果找不到精确行，则展示该文件的首个变更 hunk 片段作为弱证据。
- 片段必须由代码从 diff 派生，不能依赖模型复制。

验收：

- `publishGitLabReviewResult(... inlineComments:false)` 生成的 summary note 包含文件分组和 fenced diff 片段。
- 没有 line 的 finding 不报错，仍能正常渲染。
- diff 片段长度有上限，避免打爆 GitLab 评论。

### Phase 2：稳定打开 inline discussion

目标：对校验通过的 changed lines 发送 GitLab inline discussion。

实施项：

- 配置页继续保留 `Inline comments` 开关，默认关闭。
- 开启后只对 `validateGitLabInlinePosition` 通过的 finding 发 inline。
- 不可定位、GitLab 400、缺少 diff refs 时全部降级到 summary。
- summary 中展示 inline/fallback 统计和 fallback 原因。

验收：

- MR 新增行、删除行能成功发 inline。
- context line 或模型幻觉 line 自动 fallback。
- GitLab API 400 不影响整次 review 成功回写。

### Phase 3：引入 suggestion 能力

目标：对小范围、可验证的修复给出 GitLab suggestion block。

实施项：

- 扩展 finding schema：`suggestion?: { replacement: string; confidence: 'low' | 'medium' | 'high' }`。
- 只允许单 hunk、小范围、目标行可验证的 suggestion。
- suggestion 由发布器生成 Markdown：

  ````
  ```suggestion
  replacement code
  ```
  ````

- 不满足条件时降级为普通建议文本。

验收：

- suggestion 只出现在有效 inline discussion 中。
- replacement 不包含无关文件、不跨 hunk、不包含 markdown fence 注入。
- 失败时转换为普通 comment，不中断 review。

### Phase 4：更像 Copilot 的审查策略

目标：让输出更少、更准、更适合 MR 页面消费。

实施项：

- PM prompt 限制 finding 数量，优先 blocker/critical/major。
- 对纯测试、文档、锁文件、生成产物使用不同审查强度。
- 对用户 mention 后的自然语言提示作为“审查重点”，不作为系统指令。
- QA/Security 并行结果先代码 groupBy，再交给 PM 润色。

验收：

- 小 MR 不制造大量 info 噪音。
- 安全重点请求会增加安全检查深度。
- 敏感请求、越权请求、无关问题仍会被拒绝或安全降级。

## 架构边界

- `packages/platform-gitlab` 负责 GitLab 业务：diff、inline position、publisher、schema、skills、agents。
- `packages/nine1bot` 负责产品层 controller、run store、平台配置读取、失败回写。
- `opencode` runtime 只负责执行通用 agent/session，不理解 GitLab finding 的业务语义。
- GitLab webhook 是平台专用入口，可以调用 Nine1bot controller，但不复用 Automations 通用 webhook。

## 当前优先级

本轮先完成 Phase 1：顶层评论证据展示。它不依赖 GitLab inline API，风险最低，但能显著接近 Copilot 的 review 观感。

## 2026-05-06 实施进展

已完成：

- Phase 1 顶层评论证据展示：summary note 按文件分组，展示 finding 正文，并从原始 diff 自动提取 evidence 片段。
- Phase 3 的最小 suggestion 契约：finding 支持可选 `suggestion.replacement/confidence`，inline discussion 校验通过时可渲染 GitLab suggestion block。
- suggestion 安全降级：replacement 含 markdown fence 或过长时不渲染 suggestion block，避免破坏评论格式。
- webhook 自触发防护：忽略 bot 自己发布的 note，避免说明评论中的 `@Nine1bot` 示例再次触发 review。
- runtime 发布竞态修复：一旦检测到可发布结果并开始 publish，`onFinished` 不再追加误报 failure note。

UFTest MR 联调结果：

- 新 run `review_mothjstp_m` 成功完成并回写 GitLab。
- 顶层评论已经包含文件分组和 fenced diff evidence。
- PM 输出了一个 suggestion，当前配置 `review.inlineComments=false`，因此 suggestion 先保留在结构化结果中；开启 inline 后才会以 GitLab suggestion block 形式发布。
