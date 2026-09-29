# 对话与配置的一致性

配置保存由 `JsonFile` 在进程内按规范化文件路径串行化。先解析和校验，再用临时文件替换；Nine1Bot 持久文件与运行文件一起更新，第二个文件写入失败时回滚第一个文件。该机制不提供多个独立服务进程之间的文件锁，也不构成跨文件的断电事务。

Web 保存配置会更新真正参与加载的 Nine1Bot 配置源。独立 OpenCode 使用项目 `opencode.jsonc` / `opencode.json`，项目配置被禁用时使用指定的 `OPENCODE_CONFIG`。自定义供应商只修改原始配置，不把某个项目的有效配置反写到全局。配置版本用于使 Agent 缓存失效；已有会话有意冻结的 profile snapshot 仍按其原有语义保留。

MCP 新增/删除会持久保存，连接/断开是运行状态操作。删除使用无 `type` 的 `{ "enabled": false }` 覆盖标记，防止继承配置在重启后恢复该服务器。热更新按 Instance 维护状态，使用 JSONC 解析和校验；解析失败保留当前连接。外部文件修改按原有 30 秒检查周期生效，管理接口保存后立即同步当前 Instance。

会话的运行锁按 session ID 唯一，不再随目录字符串分裂。目录先规范化；同项目其他目录发起的会话请求会进入会话自己的工作目录，统一执行、取消和事件流。空会话可在同项目内改目录；跨项目需要新建会话。运行中删除返回 409，用户先停止并等待任务结束后再删除。失败不会清除前端会话和草稿。

客户端提供 messageID 时，接受成功会记录请求摘要和原轮次 ID。相同有效输入的重试复用接受结果；不同内容或跨会话复用同一个 ID 返回 409。并发请求不会再次追加正文或执行；接受尚未完成时可能返回冲突，稍后重试可读取回执。没有回执但已存在同 ID 消息的旧记录也会拒绝覆盖。未提供 messageID 的请求仍是新消息。

从 `opencode/packages/opencode` 运行针对性回归：

```sh
bun test test/server/config-regressions.test.ts test/server/config-transaction.test.ts
bun test test/server/mcp-config-regressions.test.ts
bun test test/server/session-lifecycle-regressions.test.ts test/session/run-lease.test.ts test/session/busy.test.ts
bun test test/session/request-replay.test.ts
bun test test/server/nine1bot-agent.test.ts
```

既有 `config/config.test.ts` 会尝试安装插件依赖，离线或隔离验证时可设置 `OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL=true`。配置源、项目目录和运行文件需要使用不同路径，才能覆盖实际启动布局。
