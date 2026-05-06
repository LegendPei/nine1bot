# GitLab Review Ignored Events Phase 3

## 目标

在 Project / Group / System Hook 接入后，用户经常会遇到“GitLab 已经发了 webhook，但 Nine1Bot 没有生成 review”的调试问题。Phase 3 固定一条排查链路：把最近收到但没有触发 review 的 GitLab events 记录下来，并在 GitLab 平台配置页单独展示。

## 范围

本阶段记录轻量级事件摘要，不保存原始 payload 和评论正文：

- `eventName`
- `mode`
- `reason`
- `host`
- `projectId`
- `projectPath`
- `objectType`
- `objectIid`
- `commitSha`
- `headSha`
- `noteId`

这能解释范围规则和触发规则，又避免把用户评论、token、secret 或 GitLab 原始 payload 长期落盘。

## 记录时机

`handleGitLabReviewWebhook` 在以下拒绝路径创建 `rejected` review run：

- GitLab review 未启用。
- webhook secret 或 `X-Gitlab-Token` 校验失败。
- `webhookAutoReview` 未开启。
- `manualMentionTrigger` 未开启。
- comment 没有命中 bot mention。
- comment 来自 bot 自身。
- comment 是越权或敏感信息请求。
- project 被 review scope 排除。
- payload 缺少必要 GitLab 标识。
- event 类型暂不支持。

其中 `project-not-allowed` 是 Phase 3 的核心场景，用于验证黑名单、`selected-only`、Group Hook 和 System Hook 组合是否按预期工作。

## UI 展示

GitLab 平台配置页新增 `Ignored GitLab Events` 区块：

- Review Runs 只显示真正进入 review 生命周期的运行记录。
- Ignored Events 显示最近被拒绝或忽略的 webhook。
- 每条记录展示项目、事件类型、MR/Commit 目标、拒绝原因、host、note id 和 head sha 摘要。

## 非目标

- 不保存完整 payload。
- 不做事件全文检索。
- 不把忽略事件重新触发为 review。
- 不在 GitLab MR 下为普通 `mention-not-found` 等噪声事件回写评论。

## 后续 Phase

- Phase 4 可以在此基础上做 group 级 include/exclude 规则。
- 后续可以增加按 reason/project 筛选、清空调试事件、导出诊断包。
