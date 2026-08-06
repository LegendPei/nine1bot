# GitLab Review 实施文档索引

本目录保存 GitLab review 能力建设过程中的设计、阶段产出和后续计划。旧的顶层文档已经迁移到本目录：

- `GITLAB_CODE_REVIEW_PLUGIN_DESIGN.md`
- `GITLAB_REVIEW_ENGINEERING_SUMMARY.md`

后续不要再在 `packages/platform-gitlab/` 根目录新增阶段性设计文档，根目录只保留包入口、源码、测试和 README。这样可以避免实现文件和施工记录混在一起。

## 当前架构约束

- GitLab 专属能力放在 `packages/platform-gitlab`。
- GitLab review agents、skills、tools 通过 `PlatformAdapterContribution.runtime.sources` 暴露给 Platform Adapter Manager。
- Web 对话栏通过 page context 和 template/resource profile 激活 GitLab wrapper tools。
- GitLab CLI 只作为底层执行能力，模型不能裸跑 CLI；必须经过 wrapper tool、skill workflow 和 context pipeline。
- MCP 暂不作为本项目内部 GitLab 能力提供方式。

## 文档顺序

1. [01-platform-package-construction.md](./01-platform-package-construction.md)
   - GitLab 包内目录、agents、skills、webhook、API client、diff、inline、renderer。
2. [02-controller-runtime-integration.md](./02-controller-runtime-integration.md)
   - Nine1Bot Controller、Platform Manager、Runtime source、AgentRunSpec、Runtime event 接入边界。
3. [03-validation-and-dry-run.md](./03-validation-and-dry-run.md)
   - dry-run harness、fixtures、单元测试、集成测试和回归命令。
4. [04-current-state-and-next-plan.md](./04-current-state-and-next-plan.md)
   - 当前已完成实现、设计对比、剩余计划。
5. [05-progress-freeze-and-design-review.md](./05-progress-freeze-and-design-review.md)
   - 阶段冻结、真实测试要求、设计偏离 review。
6. [15-project-context-ci-and-context-pipeline-plan.md](./15-project-context-ci-and-context-pipeline-plan.md)
   - 项目档案、ReviewRun 项目归属、可降级 CI/CD 证据，以及受预算控制的长上下文切片计划。
6. [06-live-integration-progress-and-gap.md](./06-live-integration-progress-and-gap.md)
   - 真实集成进度、差距和风险。
7. [07-architecture-adjustment-2026-05-05.md](./07-architecture-adjustment-2026-05-05.md)
   - 当前平台架构调整记录。
8. [08-copilot-like-review-plan.md](./08-copilot-like-review-plan.md)
   - 类 Copilot review 体验方案。
9. [09-review-scope-phase1.md](./09-review-scope-phase1.md)
   - Review scope 第一阶段。
10. [10-group-hook-phase2.md](./10-group-hook-phase2.md)
   - Group hook 第二阶段。
11. [11-ignored-events-phase3.md](./11-ignored-events-phase3.md)
   - ignored events 第三阶段。
12. [12-gitlab-review-interview-guide.md](./12-gitlab-review-interview-guide.md)
   - GitLab review 项目讲解材料。
13. [13-ai-agent-intern-interview-notes.md](./13-ai-agent-intern-interview-notes.md)
   - AI agent 实习面试笔记。

## 当前交付目标

先稳定本项目内部使用的 GitLab CLI wrapper tool 路线：

```text
browser page context
  -> GitLab template/resource profile
  -> guided skill workflow
  -> wrapper tool boundary
  -> bounded context or explicit raw diff
  -> optional review publish
```

真实 GitLab CLI 交互必须保持可观测、可回退、可测试。大 diff 默认只返回摘要，只有 workflow 明确需要原始 diff 时才通过 `includeDiff: true` 注入。
