# 平台 Release 静态资源打包与运行时定位设计

日期：2026-07-19

状态：已确认，待实施

适用范围：Nine1Bot 内置平台包随 release 发布的 skills、agents 以及平台运行时需要读取的其他静态文件

## 1. 背景与根因

平台包目前使用源码文件位置推导资源目录。例如 GitLab 通过 `new URL('../skills', import.meta.url)` 和 `new URL('../agents', import.meta.url)` 定位资源，Feishu 也曾使用相同方式定位 companion skill。这在源码模式下有效，但 Bun 将程序编译成单文件可执行文件后，`import.meta.url` 指向 Bun 虚拟文件系统。实际编译产物中，GitLab 路径被解析为 `B:\~BUN\skills` 和 `B:\~BUN\agents`，仓库中的外部目录没有自动成为可遍历的真实目录。

当前工作区的半成品为 Feishu 增加了专属复制逻辑、环境变量和 launcher 路径判断，但它存在三个结构性问题：

1. 只覆盖 `platform-feishu/skills`，GitLab 的 skills 和 agents 仍然缺失。
2. 通用 launcher、打包脚本和 Homebrew 公式开始了解具体平台名称及源码目录结构，新增平台时容易再次遗漏。
3. 平台管理器把资源写入 registry 后就显示 `registered`，没有确认目录真实存在，因此当前启动 smoke test 无法发现资源不可用。

本设计把“哪些文件进入 release”和“平台运行时如何找到自己的文件”拆成两个明确接口：平台包通过 `package.json` 声明发布资源，Nine1Bot 通过统一资源定位器把发布目录转换为普通绝对路径。

## 2. 目标与边界

完成后必须满足以下结果：

1. Feishu companion skill、GitLab review skills 和 GitLab review agents 都进入所有平台 release，并能被编译后的程序读取。
2. 新增内置平台时，开发者只修改新平台包及内置平台注册入口，不修改通用复制脚本、launcher 路径分支或 Homebrew 平台名单。
3. 平台增加 templates、schemas、prompts 等新静态资源时，使用同一声明和定位接口，不需要新增全局环境变量。
4. release 中的资源保持为可见、可检查的外部文件，目录结构稳定且与平台包隔离。
5. 构建阶段对声明错误、缺失目录、空资源和路径越界采用失败关闭策略；有缺陷的资源不能进入正式 release。
6. 运行时遇到被手工删除或损坏的资源时，服务继续启动，但平台详情明确显示错误和实际解析路径。
7. 源码开发、直接解压运行和 Homebrew 安装共享同一平台代码，不需要平台自行判断运行模式。

本轮明确不包含：

- 把 Web、浏览器扩展、ripgrep 或 core 内置 skills 一并迁入新的平台资源目录；
- 把用户安装的 Feishu 官方 `lark-*` skills 打入 release；它们继续从 `~/.agents/skills` 读取；
- 支持运行时下载安装新的平台包或远程资源；
- 将平台资源嵌入二进制并在启动时释放到临时目录；
- 为 release 文件增加签名或逐文件加密校验。

## 3. 方案决策

采用 `package.json` 显式声明、构建程序统一收集、运行时注入资源定位器的方案。

| 方案 | 优点 | 未采用原因 |
|---|---|---|
| 平台 `package.json` 显式声明 | 声明与平台包放在一起；支持任意资源目录；构建时可以严格校验 | 采用 |
| 自动扫描名为 `skills` 或 `agents` 的目录 | 配置较少 | 无法自然扩展新资源类型，也可能把仅用于测试的目录意外发布 |
| 在 `scripts/` 中维护中央平台资源清单 | 初始实现简单 | 每增加平台都要修改中央文件，平台所有权分散，仍会出现遗漏 |

显式声明只负责发布文件清单。平台运行时仍负责说明哪些目录要注册成 skills 或 agents，以及它们的 visibility、namespace 和 lifecycle。两个职责不会合并成一个隐含约定。

## 4. Release 目录结构

所有平台资源进入 release 根目录下的 `platform-resources/`：

```text
nine1bot-<platform>-<arch>/
├── nine1bot[.exe]
├── skills/                         # 现有 Nine1Bot core 内置 skills
├── platform-resources/
│   ├── manifest.json
│   ├── platform-feishu/
│   │   └── skills/
│   │       └── feishu-current-page/
│   │           └── SKILL.md
│   └── platform-gitlab/
│       ├── agents/
│       │   └── review/
│       │       └── *.agent.md
│       └── skills/
│           └── review/
│               └── .../SKILL.md
├── web/
├── browser-extension/
├── bin/
├── scripts/
└── VERSION
```

输出平台目录取 npm 包名去掉 scope 后的部分。例如 `@nine1bot/platform-feishu` 对应 `platform-feishu`。每个平台拥有独立目录，因此不同平台可以安全使用相同的 `skills`、`agents` 或 `templates` 名称。

内置平台即使在用户配置中被关闭，其资源仍然进入 release。平台启用状态是运行时选择，不能改变同一版本发布包的内容。

## 5. 平台包的发布声明

平台包在自己的 `package.json` 中增加 `nine1bot.releaseResources`：

```json
{
  "name": "@nine1bot/platform-feishu",
  "nine1bot": {
    "releaseResources": [
      "skills"
    ]
  }
}
```

GitLab 声明为：

```json
{
  "name": "@nine1bot/platform-gitlab",
  "nine1bot": {
    "releaseResources": [
      "agents",
      "skills"
    ]
  }
}
```

每个条目表示相对于平台包根目录的一个目录，并遵守以下规则：

- 使用 `/` 分隔的相对路径，不接受 glob；
- 路径不能为空、不能是 `.`、不能是绝对路径，也不能包含 `..`；
- 源路径必须位于声明它的包目录内；
- 符号链接不进入 release，避免链接到包外文件或造成不同平台上的复制差异；
- 目录必须存在且至少包含一个普通文件；
- 重复条目和规范化后发生碰撞的条目会导致构建失败；
- 名为 `skills` 或以 `/skills` 结尾的资源必须递归包含 `SKILL.md`；
- 名为 `agents` 或以 `/agents` 结尾的资源必须递归包含 `*.agent.md`。

将来可以声明 `templates`、`schemas` 或 `prompts/review`。构建程序对未知类型执行通用的非空目录和安全路径校验，不需要理解资源的业务含义。

## 6. 资源收集与发布清单

新增 `scripts/package-platform-resources.ts`，由 `scripts/package.sh` 在创建压缩包前调用。该程序承担以下职责：

1. 扫描 `packages/*/package.json`，选择包含 `nine1bot.releaseResources` 的包。
2. 校验包名、声明路径、符号链接、目录内容和输出路径；声明发布资源的包名去掉 scope 后必须以 `platform-` 开头。
3. 在确认输出位于当前 `dist/nine1bot-<platform>-<arch>` 后，清理本次构建的旧 `platform-resources`，防止重复打包遗留已删除文件。
4. 按原始相对目录结构复制普通文件。
5. 以包名、资源路径和文件路径的字典序生成确定性的 `manifest.json`。

清单格式固定为 schema version 1：

```json
{
  "schemaVersion": 1,
  "packages": [
    {
      "name": "@nine1bot/platform-feishu",
      "directory": "platform-feishu",
      "resources": [
        {
          "source": "skills",
          "files": [
            "skills/feishu-current-page/SKILL.md"
          ]
        }
      ]
    }
  ]
}
```

`manifest.json` 是构建结果清单，由程序生成，不手工维护。它用于 CI 完整性检查、用户排查和后续安装器验证；运行时定位资源不依赖逐项读取清单，从而避免每次平台访问都引入额外 I/O 和清单缓存状态。

`scripts/package.sh` 只调用统一收集程序，不包含任何 `platform-feishu`、`platform-gitlab` 或具体资源类型的复制分支。

## 7. 运行时资源定位接口

`PlatformAdapterContext` 增加一个必需的 `packageResources` 字段：

```ts
export type PlatformPackageResources = {
  root: string
  resolve(...segments: string[]): string
}

export type PlatformAdapterContext = {
  // 现有字段保持不变
  packageResources: PlatformPackageResources
}
```

其中 `root` 是当前平台包的绝对资源根目录，`resolve()` 返回该根目录内的绝对路径。`resolve()` 拒绝绝对片段、空片段和任何解析后越过 `root` 的路径。

`PlatformAdapterManager` 根据平台 descriptor 的 `packageName` 创建 locator。它从包名得到 `platform-feishu` 或 `platform-gitlab`，再与 manager 的 `packageResourcesRoot` 合并。平台包不读取安装目录环境变量，也不自行使用 `import.meta.url` 判断 release 模式。

Feishu runtime sources 调整为：

```ts
export function feishuRuntimeSources(ctx: PlatformAdapterContext) {
  return {
    skills: [
      {
        id: 'feishu-companion-skills',
        directory: ctx.packageResources.resolve('skills'),
        visibility: 'declared-only',
        lifecycle: 'platform-enabled',
      },
      {
        id: 'feishu-official-skills',
        directory: resolveOfficialSkillsDirectory(ctx.settings),
        includeNamePrefix: 'lark-',
        visibility: 'default',
        lifecycle: 'platform-enabled',
      },
    ],
  }
}
```

GitLab 的静态 `runtime.sources` 改为接收 context 的 provider，并分别解析 `agents` 与 `skills`。OpenCode 的 `RuntimeSourceRegistry` 继续只接收普通绝对目录，因此不需要理解 package manifest 或 release 布局。

平台内部将来读取普通文件时使用同一个接口：

```ts
const templatePath = ctx.packageResources.resolve('templates', 'review-summary.md')
```

## 8. 开发、Release 与 Homebrew 路径

资源 locator 接收的 `packageResourcesRoot` 在不同环境下取值如下：

| 环境 | `packageResourcesRoot` | 平台包根目录示例 |
|---|---|---|
| 源码开发 | `<repo>/packages` | `<repo>/packages/platform-feishu` |
| 解压 release | `<install>/platform-resources` | `<install>/platform-resources/platform-feishu` |
| Homebrew | `<libexec>/platform-resources` | `<libexec>/platform-resources/platform-feishu` |

安装根目录判断同时改为以下固定顺序：

1. `NINE1BOT_INSTALL_DIR` 存在时使用其规范化绝对路径。该变量供 Homebrew 等外部安装器显式声明 Nine1Bot 安装根目录。
2. `NINE1BOT_PROVENANCE.build.compiled` 为 `true` 时，直接使用 `dirname(process.execPath)`。
3. 只有源码运行时才通过源码文件位置回溯仓库根目录。

由此删除根据父目录名称是否以 `nine1bot-` 开头判断 release 模式的逻辑。压缩包解压后的二进制可以直接使用相邻资源；二进制被重命名或移动到其他普通目录时也不会被误判为源码模式。

Homebrew 公式把完整 release 目录内容安装到 `libexec`，再为 `libexec/nine1bot` 生成 `bin/nine1bot` 环境包装脚本，并设置 `NINE1BOT_INSTALL_DIR` 为 `libexec`。这样 binary、Web、core skills、platform resources、browser extension 和 ripgrep 共享一个明确的安装根目录。

## 9. 运行时状态与失败行为

构建阶段采用严格失败：

- package metadata 结构无效时失败；
- 声明的目录缺失、为空、包含被拒绝的符号链接或越过包根目录时失败；
- skills/agents 目录缺少对应入口文件时失败；
- 复制结果与生成清单不一致时失败；
- release verifier 发现清单中的文件缺失时失败。

运行时采用可诊断降级：

- source 已写入 registry 且目录真实存在时显示 `registered`；
- 平台关闭时显示 `disabled`；
- source 未进入 registry、目录不存在或目录不是可读目录时显示 `error`，并返回明确原因与解析后的绝对路径；
- 单个平台的静态资源错误不会阻止服务器启动，也不会影响其他平台和 core skills；
- OpenCode 扫描器继续忽略不可用目录，但平台详情不再把不可用目录误报为成功注册。

正式发布应在 CI 阶段拦截所有内置资源错误。运行时降级主要用于用户手工移动、删除或修改 release 内容后的诊断。

## 10. 新平台与新资源的维护流程

### 10.1 新增平台

以 `platform-slack` 为例：

1. 创建 `packages/platform-slack`，并在该包中放置需要的 skills、agents 或其他资源。
2. 在该包的 `package.json` 中声明 `nine1bot.releaseResources`。
3. 在平台 contribution 中使用 `ctx.packageResources.resolve()` 取得目录或文件路径。
4. 将 contribution 加入 Nine1Bot 的内置平台注册入口。
5. 增加平台自身的资源定位和 runtime source 测试。

通用资源收集程序、launcher、release workflow 和 Homebrew 公式不增加 Slack 专属分支。

### 10.2 为现有平台增加资源

以 GitLab 增加 `templates/review-summary.md` 为例：

1. 创建 `packages/platform-gitlab/templates/review-summary.md`。
2. 在 GitLab 的 `releaseResources` 中增加 `templates`。
3. 在平台代码中调用 `ctx.packageResources.resolve('templates', 'review-summary.md')`。
4. 增加读取该文件的测试。

打包程序会自动复制新目录并更新 `manifest.json`，无需修改任何平台无关代码。

## 11. 测试与验证设计

所有行为修改必须先增加旧代码上会失败的测试，再实现最小修复。

### 11.1 资源收集器

- 从临时 workspace 中发现多个声明平台，并生成稳定排序的输出与清单；
- 拒绝绝对路径、`..`、空目录、重复声明、输出碰撞和符号链接；
- skills 缺少 `SKILL.md` 或 agents 缺少 `*.agent.md` 时失败；
- 重复执行时删除上一次构建遗留、但本次不再声明的文件；
- 二进制或非 UTF-8 普通文件按字节复制，不经过文本转换。

### 11.2 资源 locator

- 对源码 root 和 release root 生成正确绝对路径；
- scoped package name 正确映射为不带 scope 的目录；
- 拒绝绝对 segment 和越过 package root 的路径；
- context 在 adapter、status、action 和 background service 中使用同一个 package root。

### 11.3 平台集成

- Feishu companion source 指向 locator 下的 `skills`，official source 仍指向用户配置目录；
- GitLab agents 和 skills 都指向 locator 下的对应目录；
- 编译后的程序不再返回 `B:\~BUN\skills`、`B:\~BUN\agents` 或源码包路径；
- 实际目录被删除时，平台详情返回 `error`，不能继续显示 `registered`。

### 11.4 Release 集成

- `package.sh` 生成包含 Feishu 和 GitLab 全部声明资源的 `platform-resources`；
- `manifest.json` 中记录的每个文件都存在，目录中没有未记录的陈旧文件；
- 可运行架构上的编译二进制启动后，平台详情返回的 bundled source 目录全部存在；
- Linux x64、macOS arm64 和 Windows x64 执行运行时 smoke test；Linux arm64 至少执行静态目录与清单校验；
- release 压缩包解压后保持相同目录结构；
- 生成的 Homebrew 公式安装完整 `platform-resources`，并设置正确的安装根目录。

## 12. 迁移边界

实现时删除当前 Feishu 专属半成品：

- `NINE1BOT_FEISHU_COMPANION_SKILLS_DIR`；
- launcher 中的 `getFeishuCompanionSkillsDir()`；
- `package.sh` 中直接复制 `packages/platform-feishu/skills` 的分支；
- Homebrew 公式对源码 `packages/` 目录的安装依赖；
- Feishu skill source 对专属环境变量的读取。

以下现有行为保持：

- core 内置 skills 仍从 release 根目录的 `skills/` 加载；
- Feishu official skills directory 仍可由用户配置，默认值仍为 `~/.agents/skills`；
- skill visibility、agent visibility、namespace、lifecycle 和 name-prefix 过滤语义不变；
- 平台启用或关闭时的 registry 生命周期不变；
- release 仍是每个平台和架构一个压缩包。

## 13. 验收标准

- [ ] release 中存在 `platform-resources/manifest.json`，且清单与真实文件完全一致。
- [ ] Feishu companion skill、GitLab review skills 和 GitLab review agents 都存在于 release 外部目录。
- [ ] 编译后的程序通过普通文件系统绝对路径加载这些资源，不再依赖 Bun 虚拟路径。
- [ ] 新平台只需维护自身 package metadata、资源文件、runtime contribution 和测试。
- [ ] 新资源类型只需增加 package 声明、平台读取代码和测试。
- [ ] 通用打包脚本、launcher 和 Homebrew 公式不包含具体平台名称的资源复制逻辑。
- [ ] 缺失或非法资源在构建阶段阻止 release；运行时资源被破坏时平台详情明确降级。
- [ ] 源码开发、直接解压和 Homebrew 三种布局均通过对应验证。
- [ ] 当前用户工作区中的其他文档、`tmp/` 和无关修改不被暂存或提交。
