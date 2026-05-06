# GitLab Review 范围配置 Phase 1 计划

## 背景

当前 GitLab Review 使用 `review.allowedProjectIds` 作为项目白名单。这个设计适合早期调试，但产品化体验不理想：

- 用户通常知道 `group/project`，不一定知道 GitLab project id。
- Project Hook、Group Hook、System Hook 三种入口天然覆盖范围不同，强制手填 id 会让配置成本变高。
- 对于 Group/System Hook，更自然的模式是“处理 Hook 收到的项目，再排除不想处理的项目”。
- 自动 review 与手动 `@Nine1bot review` 应该共享同一套项目范围判断，但触发开关仍需分开。

## Phase 1 目标

先完成可用的范围模型替换，不扩展到完整 Group/System Hook API 管理：

1. 新增 Review Scope 配置模型：
   - `review.scopeMode`: `all-received` | `selected-only`
   - `review.includedProjects`: 选中项目列表
   - `review.excludedProjects`: 排除项目列表
2. 默认使用 `all-received`：
   - 处理 GitLab Hook 能收到的所有项目。
   - 通过 `excludedProjects` 做黑名单。
3. 保留高级白名单模式 `selected-only`：
   - 只处理 `includedProjects` 中的项目。
   - 适合 System Hook 试点少量项目。
4. 兼容旧配置：
   - 如果存在旧的 `review.allowedProjectIds`，归一化为 `selected-only + includedProjects`。
5. UI 不再要求用户手输 id：
   - GitLab 配置页提供项目搜索。
   - 搜索结果显示 `path_with_namespace` 和 id。
   - 用户点击加入“包含项目”或“排除项目”。
6. 触发判断改为：
   - host scope 仍由 `allowedHosts` 控制。
   - project scope 先判断 `excludedProjects`。
   - `selected-only` 模式再判断 `includedProjects`。
   - `all-received` 模式默认允许未排除项目。
7. 自动 review 仍由 `review.webhookAutoReview` 显式开启。
8. 手动 mention 仍由 `review.manualMentionTrigger` 控制。

## Hook 级别语义

GitLab Hook 决定 Nine1Bot 能收到哪些事件；Nine1Bot Review Scope 决定收到后哪些项目会被处理。

- Project Hook + `all-received`：处理该项目。
- Group Hook + `all-received`：处理 group 下未排除项目。
- System Hook + `all-received`：处理实例内未排除项目，风险较高。
- System Hook + `selected-only`：只处理选中项目，适合试点。

## Phase 1 非目标

- 不自动创建 Group Hook。
- 不自动创建 System Hook。
- 不做完整项目分页管理页。
- 不移除旧 `review.allowedProjectIds`，仅隐藏并兼容。

## 后续 Phase

- Phase 2：支持 Group Hook 管理与批量 hook 同步。
- Phase 3：展示最近收到但被排除的 webhook events，辅助调试范围规则。
- Phase 4：支持 group 级排除 / 包含规则。
