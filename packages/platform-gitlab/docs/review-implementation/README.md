# GitLab Review 实施文档索引

本目录保存 GitLab review 能力建设过程中的设计、阶段产出和后续计划。旧的顶层文档已经迁移到本目录：

- `GITLAB_CODE_REVIEW_PLUGIN_DESIGN.md`
- `GITLAB_REVIEW_ENGINEERING_SUMMARY.md`

后续不要再在 `packages/platform-gitlab/` 根目录新增阶段性设计文档，根目录只保留包入口、源码、测试和 README。这样可以避免实现文件和施工记录混在一起。

## 当前架构约束

- GitLab 专属能力放在 `packages/platform-gitlab`。
- GitLab review agents、skills、tools 通过 `PlatformAdapterContribution.runtime.sources` 暴露给 Platform Adapter Manager。
- Web 对话栏通过 page context 和 project profile 选择仓库；自动 Review 通过冻结的 ReviewRun/attempt 关联项目、MR、源码版本和上下文。
- 模型只能调用显式白名单中的 wrapper tool。当前 CI 按需查询由 `gitlab_ci_inspect` 通过受限 GitLab REST API v4 完成，不向模型暴露 token、CLI、`curl`、`webfetch`、shell 或通用网络能力。
- GitLab CLI 仅供管理员配置、诊断和手工联调，不是自动 Review 的模型工具，也不进入提示词。
- skill 固定审查步骤，wrapper tool 固定能力边界，context pipeline 负责冻结、切片和按预算注入上下文。
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
14. [14-live-integration-test-checklist.md](./14-live-integration-test-checklist.md)
   - 无凭证的真实 GitLab 联调清单，覆盖 webhook、可信 CI、非阻断诊断和显式 retry。
15. [15-project-context-ci-and-context-pipeline-plan.md](./15-project-context-ci-and-context-pipeline-plan.md)
   - 项目档案、ReviewRun 项目归属、可降级 CI/CD 证据，以及受预算控制的长上下文切片计划。
16. [16-runtime-ci-on-demand-tool-design.md](./16-runtime-ci-on-demand-tool-design.md)
   - 自动 Review 会话按需查询 CI 的 wrapper tool 设计与上下文边界。
17. [17-runtime-ci-on-demand-tool-implementation-plan.md](./17-runtime-ci-on-demand-tool-implementation-plan.md)
   - 按需 CI 工具的实施批次、验证方式与提交记录。
18. [18-review-hardening-and-recovery-design.md](./18-review-hardening-and-recovery-design.md)
   - 安全重定向、工具白名单、可信流水线、attempt 恢复、竞态隔离和无损配置设计。
19. [19-review-hardening-and-recovery-implementation-plan.md](./19-review-hardening-and-recovery-implementation-plan.md)
   - 本轮安全与稳定性改进的任务清单、提交记录和验收结果。
20. [20-review-follow-up-hardening-design.md](./20-review-follow-up-hardening-design.md)
   - 分支二次审查后的权限、脱敏、HEAD 一致性、绑定恢复、发布幂等、资源限制和 attempt 链完整性设计。
21. [21-review-follow-up-hardening-implementation-plan.md](./21-review-follow-up-hardening-implementation-plan.md)
   - 二次审查加固的 TDD 实施任务、接口、回归命令和提交边界。

## 当前交付目标

当前交付收敛为本项目内部的受限 REST wrapper 路线：

```text
webhook / browser page context
  -> GitLab project profile
  -> frozen ReviewRun attempt + context pipeline
  -> allowlisted review agents and skill workflow
  -> bounded gitlab_ci_inspect REST wrapper (on demand)
  -> optional review publish
```

大 diff 由 context pipeline 按文件、风险和预算切片，Review finding 只能引用冻结 diff。CI 只作为补充上下文：仅接受与当前 MR/source HEAD 可证明关联的 source、detached、merged-result、merge-train 或 integrated pipeline；找不到可信 CI 时返回稳定诊断并继续 Review，绝不退化到项目最新流水线。

配置型拒绝修复后必须调用显式 retry 接口创建新 attempt。原 run、错误、时间和审计信息保持不变，旧异步请求不能覆盖新 attempt。
