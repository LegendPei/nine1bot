# PR #52 Review 跟进修复记录

日期：2026-08-22

## 1. 目标

本批次收敛 PR #52 最新 review 提出的五项问题，同时保持既定产品边界：

- 自动 Review 只使用 ReviewRun 绑定的专用 wrapper tool。
- 模型不获得 token、任意 GitLab API 地址、裸 `glab`、shell、通用文件读取或通用网络能力。
- CI 和仓库上下文均为按需补充证据，不能替代冻结 diff，也不能扩大审查范围。
- 旧 ReviewRun 不覆盖；恢复执行创建关联的新 attempt。

## 2. 已完成 Batch

### Batch 1：CLI host allowlist 非法配置 fail-closed

完成项：

- 区分 allowlist 未配置、配置有效、配置非法三种状态。
- `allowedHosts` 非法时，CLI wrapper 拒绝所有目标，不再因规范化为空数组而退化为允许任意 host。
- allowlist 校验从 `review.enabled` 中解耦；即使 webhook Review 关闭，交互式 CLI 能力仍会报告配置错误。

稳定诊断：`GitLab host allowlist configuration is invalid`。

### Batch 2：瞬时 `load_changes` 失败恢复

完成项：

- 仅将 408、425、429、5xx、网络 `TypeError` 和 `AbortError` 识别为可恢复瞬时失败。
- GitLab 重发同一 webhook 时，只有“未发布、无 publication 状态、明确标记 recoverable”的失败 run 才创建新 attempt。
- 新 attempt 使用 `rootRunId`、`retryOf` 和递增 `attempt` 关联原记录；原 run 的错误、时间和状态保持不变。
- 403、策略拒绝、已发布和部分发布记录不会自动恢复，避免重复评论。
- 自动恢复只接受带有 `transient` 标记的 `gitlab_api_load_changes_failed:*`；其他失败即使错误地带有 `recoverable` 也不能进入该路径。
- 可恢复的加载失败不发布失败评论；已有 `failureNotifiedAt` 或任意 publication 状态的 run 一律不允许重试，避免旧失败通知与新 review 竞争。
- GitLab API 超时使用专用 `GitLabApiTimeoutError`，可稳定进入瞬时失败恢复路径，不依赖错误消息匹配。

### Batch 3：冻结仓库上下文 wrapper

新增 `gitlab_repository_inspect`，支持：

- `search_text`：在冻结 review head 上做固定字符串搜索。
- `read_file`：读取冻结 review head 中的单个 Git blob，可指定起始行和最大行数。

边界与预算：

- 会话创建时只持久化项目目录 SHA-256 指纹，不向模型暴露本机绝对路径。
- ReviewRun 对外 DTO 会移除仓库指纹、查询计数等内部状态，浏览器端不可见。
- 每次调用校验当前 session、最新 attempt、generation、活动状态、目录指纹和 Git 仓库根目录。
- 只接受 GitLab 提供的 40 或 64 位十六进制 commit SHA，不接受分支名、tag 或模型提供的 ref。
- 底层仅执行固定参数、无 shell 的 `git rev-parse`、`git cat-file` 和 `git grep`，不 checkout、不 fetch、不访问网络。
- Git 子进程只继承启动所需的最小系统环境白名单，不传递 token、代理、HOME 或其他服务环境变量。
- 固定设置 `GIT_NO_LAZY_FETCH=1`、空 `GIT_ALLOW_PROTOCOL`、`GIT_NO_REPLACE_OBJECTS=1`、禁用 system/global Git config，防止 partial clone 隐式联网和 `refs/replace/*` 改写冻结 SHA 内容。
- 路径拒绝绝对路径、反斜杠、空段、`.`、`..`、`.git` 和控制字符；Git pathspec 强制 literal。
- Git 符号链接按 blob 文本读取，不跟随到工作区或仓库外部。
- 单 run 最多 12 次查询，单次内容最多 20 KiB，累计最多 128 KiB，单 blob 最大 256 KiB，搜索最多返回 50 条匹配。
- 最终工具输出严格小于 32 KiB，并使用 `untrusted-gitlab-repository` fence 隔离提示词注入。

PM coordinator 和 MR/commit review skill 只允许在 diff 中的符号缺少必要上下文时调用该工具。仓库证据只能佐证 diff finding，不能产生仓库级扩展 finding。

### Batch 4：MR URL 单一来源

完成项：

- 初始 Review prompt 不再用 `https://${host}` 手工拼接 MR URL。
- `gitlab_ci_inspect` 的 `list` 结果基于 `resolveGitLabApiBaseUrl` 返回 canonical MR URL。
- 保留 self-managed GitLab 的 `http` 协议和子路径部署，例如 `http://host/gitlab/...`。

### Batch 5：CI 调用顺序与诊断一致性

完成项：

- inspector 层强制 `list -> read_job_log`。
- 只有 `list` 成功完成并写入 `listCompletedAt` 后才允许读取日志；并发中尚未完成的 list 预留不会提前解锁 read。
- `listCompletedAt` 只在最终 `< 32 KiB` DTO 成功生成后写入；输出超限返回失败时仍保持 `ci_list_required`。
- 未执行 `list` 时返回 `ci_list_required`，且不解析 token、不占用日志配额、不访问 GitLab。
- `ci_not_queried` 继续以 list 为正常协议依据，同时兼容历史上已存在 `jobLogReadCount` 的持久化记录，避免错误补记诊断。
- CI 缺失、读取失败或任意 job 状态仍不阻断 Review 发布。

## 3. 测试覆盖

已完成聚焦红绿测试：

- allowlist 非法配置在 webhook Review 关闭时仍拒绝 CLI 目标。
- 502 首次失败后 webhook 重发创建关联 attempt，旧 run 不变。
- 仓库读取固定在旧 head，即使当前 checkout 已前进。
- 目录越界、`..`、`.git` 和 pathspec magic 均不能突破边界。
- Git symlink 只返回链接 blob，不读取仓库外文件。
- 本地 replacement ref 不能替换冻结 commit 的内容，Git 子进程不继承代理、token 或可重定向仓库的环境变量。
- 仓库查询次数、内容、累计输出和最终 tool DTO 均受限。
- CI 日志读取前置 list、token 零读取和 GitLab 零请求。
- self-managed GitLab 的协议与 base path 在 canonical MR URL 中保持不变。
- CI inspector：25 pass / 0 fail。
- 根仓库全量测试：712 pass / 0 fail。
- OpenCode 相关工具、registry、webhook DTO 和 agent source 测试：53 pass / 0 fail。
- 根仓库全部 package typecheck：通过。
- OpenCode `tsgo --noEmit`：通过。

全量测试曾在 Windows 上暴露仓库预算用例接近 Bun 默认 5 秒时限的问题。测试改为直接预置到查询额度临界值，只运行最后一次允许查询和一次拒绝查询；行为覆盖不变，预算用例耗时由约 3.9 秒降至约 1.3 秒。

## 4. 尚未执行

- 未在真实 self-managed GitLab 上执行本批次新增仓库 wrapper 的联调。
- 未替用户回复或 resolve GitHub review thread。
- 未提交、未推送本批次本地修改。

上述远端动作需要单独确认；自动化通过不等于真实 GitLab 联调完成。
