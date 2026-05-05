# GitLab Review 架构调整记录

## 背景

`main` 分支已经把多平台能力放进用户设置弹窗的“多平台”页。GitLab review 不再需要左侧侧边栏的独立 `Platforms` 页面，也不再需要通过 Automations source 间接提供 webhook。

## 调整后的边界

GitLab 平台页负责：

- GitLab base URL、API token、Webhook secret、review 开关、模型选择等配置。
- 展示 GitLab review 专用 webhook URL。
- 展示最近 review runs、失败原因和 retry 入口。
- 只展示已认证 Chat provider 下的模型，避免用户选择未配置模型。

Automations 负责通用 webhook / schedule 自动化，不再承载 GitLab review 的 source secret 或 source 绑定。

## 新 webhook 形态

推荐使用 GitLab 平台自用的轻量 webhook：

```text
POST /webhooks/gitlab/{webhookSecret}
```

`{webhookSecret}` 来自 GitLab 平台配置里的 `review.webhookSecretRef`。使用该 URL 时，GitLab Project Webhook 的 `Secret token` 字段留空，因为 secret 已经在 path 中校验。

保留一个 header 形式作为兼容入口：

```text
POST /webhooks/gitlab
X-Gitlab-Token: <webhookSecret>
```

已废弃旧方案：

```text
POST /webhooks/gitlab/{sourceId}/{secret}
review.webhookSourceId
```

## UI 迁移

旧入口：

```text
左侧侧边栏 -> Platforms
```

新入口：

```text
用户设置弹窗 -> 多平台 -> GitLab
```

侧边栏只保留 Chat、Projects、Metrics、Automations 等顶层工作区入口。多平台配置属于设置项，不再作为主工作区页面。

## GitLab 配置引导

在 GitLab 项目中配置 Project Webhook：

- URL：使用“多平台 -> GitLab”页面展示的专用 URL。
- Secret token：使用 path secret 时留空；使用 `/webhooks/gitlab` header 模式时填同一个 webhook secret。
- Trigger：勾选 `Comments` / `Note events`，用于 `@Nine1bot review` 评论触发。
- Trigger：可选勾选 `Merge request events`，用于后续自动审查。

## 当前实现状态

- 已从平台设置中移除 `review.webhookSourceId`。
- 已新增 `/webhooks/gitlab/{secret}` 专用入口。
- 已保留 `/webhooks/gitlab` + `X-Gitlab-Token` 兼容入口。
- 已把 `PlatformManager` 嵌入设置弹窗“多平台”页。
- 已移除左侧侧边栏 `Platforms` 入口。

后续真实联调时，需要把 GitLab 项目里的 webhook URL 从旧的 Automations source URL 替换为新的专用 URL。
