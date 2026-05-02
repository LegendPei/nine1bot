# GitLab Review 实施施工文档索引

本目录面向代码实施阶段，承接上层方案：

- `packages/platform-gitlab/GITLAB_CODE_REVIEW_PLUGIN_DESIGN.md`
- `docs/agent-runtime-developer-guide/09-platform-adapter-development-guide.md`

当前实现必须遵守最新平台架构：

- GitLab 专属能力放在 `packages/platform-gitlab`。
- GitLab review agents / skills 通过 `PlatformAdapterContribution.runtime.sources` 暴露给 Platform Adapter Manager。
- Controller 只生成 `AgentRunSpec`、持久化 `ReviewRun`、转译 Runtime events。
- Runtime 执行 PM 主代理，并允许主代理在 Runtime 内派生受控子代理。
- Runtime 不依赖 `ReviewFinding`、`ReviewStageResult` 等 GitLab review 业务类型，只处理传入的 JSON Schema。

## 文档顺序

1. [01-platform-package-construction.md](./01-platform-package-construction.md)
   - GitLab 包内目录、agents / skills、webhook、API client、diff、inline、renderer。
2. [02-controller-runtime-integration.md](./02-controller-runtime-integration.md)
   - Nine1Bot Controller、Platform Manager、Runtime source、AgentRunSpec、Runtime event 接入边界。
3. [03-validation-and-dry-run.md](./03-validation-and-dry-run.md)
   - dry-run harness、fixtures、单元测试、集成测试和回归命令。

## 第一阶段交付目标

Phase 0 / Phase 1 先交付可本地验证的最小闭环：

```text
fixture webhook / GitLab note
  -> trigger parser
  -> idempotency key with head_sha
  -> diff builder with overflow guard and file blacklist
  -> context blocks
  -> AgentRunSpec draft
  -> dry-run renderer summary
```

真实 GitLab webhook 和 Runtime 多代理执行接入放在后续阶段，不阻塞本地施工验证。

