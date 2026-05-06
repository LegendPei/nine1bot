# GitLab Review Group Hook Phase 2 计划

## 目标

在 Phase 1 的 Review Scope 基础上，补齐 Group Hook 管理能力：

1. 支持搜索 GitLab groups。
2. 支持在配置页选择需要由 Nine1Bot 管理 hook 的 groups。
3. 支持一键同步这些 group hooks 到当前专用 webhook URL。
4. 支持测试这些 group hooks 的 Note event。
5. 保持 Project Hook 同步能力不变。

## 设计原则

GitLab Hook 接入级别与 Review Scope 继续解耦：

- Project Hook 管理：针对 included projects 创建或更新 project hook。
- Group Hook 管理：针对 hook groups 创建或更新 group hook。
- System Hook 管理：Phase 2 不自动实现，只提供 URL 和说明。System Hook 权限更高，后续需要单独的管理员确认、审计和回滚策略。

Group Hook 决定 Nine1Bot 能收到 group 下项目事件；Review Scope 决定收到后哪些项目实际会触发 review。

## 配置模型

新增：

- `review.hookGroups`: `GitLabGroupRef[]`

其中：

```ts
type GitLabGroupRef = {
  id: number | string
  fullPath?: string
  webUrl?: string
}
```

## UI 交互

GitLab 平台配置页新增 Group Hook 管理区：

- 搜索 group。
- 加入“Hook Groups”。
- 点击 chip 可移除。
- 提供“同步 Group Hooks”和“测试 Group Hooks”按钮。

## 非目标

- 不自动创建 System Hook。
- 不实现 group 级 include/exclude scope 规则。
- 不展示 group 下完整项目列表。
- 不分页管理大量 group。

## 验证

- API client 测试：group 搜索、group hook list/create/update/test。
- Runtime action 测试：sync/test group hooks。
- 前端构建通过。
