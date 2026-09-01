# DeepSeek Studio — 向 AI IDE 演进的可行性分析

日期：2026-09-01
范围：`shell/`（独立仓库 `nixiaohao/DeepSeek-Desktop-Studio`）
分析基准：`D:\Program Files\DeepseekHarness\deepseek-harness`（dsh rc.2 运行副本，48 包组完整）
状态：**分析文档，不改代码**

---

## 0. 结论先行

**可行，而且切入点比想象中好——但路线必须选对。**

一句话分工：**dsh 负责智能体，Electron 负责 IDE 基建。**

dsh 后端已经把「AI 侧」最难的部分做好了：工具调用的结构化渲染意图（含执行前的 diff）、
审批流、终端卡片、全会话实时事件流。缺的全是「IDE 侧」的东西——文件树、编辑器、git、
LSP——而这些恰恰是 Electron 主进程凭 Node 全能力**自己就能做、且不该依赖 dsh** 的部分。

三个必须现在就认清的硬事实：

| # | 事实 | 对路线的影响 |
| --- | --- | --- |
| 1 | dsh 的 ACP 实现是 **automation-only 的 agent 端**，明确不 advertise session/editor/terminal/filesystem capability | ❌ **放弃「把 dsh 当 ACP agent 接进标准 IDE 前端」这条路** |
| 2 | shell 自动更新会对 workspace 执行 `git reset --hard` | ❌ **放弃「改 dsh 源码 / fork 前端 / 往 dsh workspace 塞包」**，一切改动必须在 shell 仓 |
| 3 | dsh 全库**零 git 集成**、前端**零文件树**、**零编辑器组件**（只有 shiki 只读高亮） | ✅ 这三项只能自建，但 Electron 侧自建是天然主场 |

**推荐路线：双轨渐进（外壳增强起步 → 自建 IDE 面收尾）**，详见第 5 节。

---

## 1. 先定目标：你想做的是哪一种 IDE？

三种形态的差异不在 UI，而在**「人如何管控 AI 对代码的改动」**。

| 维度 | A. Codex 式 | B. WorkBuddy 式 | C. Cursor / VS Code 式 |
| --- | --- | --- | --- |
| 核心隐喻 | 任务 = 一个变更集 | 对话流里嵌工具卡片 | 编辑器为主，AI 是副驾 |
| 变更呈现 | **集中式 diff 审阅区**：这次任务改了哪些文件，逐文件展开 | 内联在对话里：每条工具调用一张卡片 | 编辑器里 inline diff，逐块接受 |
| 人的管控点 | 批准/拒绝整个变更集或单文件 | 逐次工具调用审批 | 逐块 accept / reject |
| 代码编辑器 | **不需要**（只读 diff） | 不需要 | **必需**（编辑 + 补全 + 跳转） |
| git 集成 | 需要（基线 diff、回滚） | 弱需要 | 强需要（面板、暂存、提交） |
| 终端 | 可选 | 可选 | 需要 |
| 实现成本 | **中** | **低** | **高** |
| dsh 现有支撑度 | **高**（diff 意图 + 审批流已就绪） | **极高**（就是现在 web UI 的形态） | 低（编辑器/git/LSP 全缺） |

你提到「倾向 Codex 那种，或者 WorkBuddy 这种，特别是对代码的管控、git 这些」——
**这两者的交集正是「变更审阅 + 审批 + git 基线」，而这恰好是 dsh 支撑度最高的地方。**

> 我的判断：**先做 A（Codex 式变更审阅），不要一上来做 C。**
> C 的真实成本不在编辑器组件（CodeMirror/Monaco 都是现成的），而在 LSP 接入、
> 多语言、大文件性能、与 AI diff 的协同——这些是没有尽头的工程。而 A 用 dsh
> 现成的 `DiffCallView` + 审批流就能做出 80% 的体验，且**每一行代码都在自己仓里**。

---

## 2. 能力盘点：dsh 已经给了什么

以下全部经过源码核对（路径基于 rc.2 运行副本）。

### 2.1 ✅ 实时事件流（IDE 的神经中枢，已就绪）

`packages/host/apiproxy/src/fetch/handler.ts:234` 确认是 **SSE**
（`content-type: text/event-stream`，`\n\n` framing，用 streaming fetch 而非 EventSource）。

`packages/host/apiproxy/src/api/events.ts` 定义两个流：

- **`events.mux`** — 全会话聚合流，这是 IDE 面板唯一需要订阅的东西。帧类型：
  - `session/event` —— 携带 `view?: ToolEventView`（**工具调用渲染意图，见 2.2**）
  - `session/subscribed`
  - `approval/requested` —— `{ sessionId, approvalId, toolName, callId?, reason? }`（events.ts:72）
  - `approval/resolved` —— `{ ..., outcome }`（events.ts:73）
  - `question/requested` / `question/resolved`
  - `session/queue` —— inbox 快照（排队中/引导中/上下文三类）
- **`events.host`** — 会话创建/销毁、running 状态翻转、agent 失败

**意义**：一个 SSE 连接就能驱动「变更面板 + 审批中心 + 状态指示」，不需要轮询，
不需要注入 dsh 前端页面。这是**零侵入**的技术基础。

### 2.2 ✅ 工具调用的结构化渲染意图（最关键的一块拼图）

`packages/core/tools/src/presentation.ts` 定义了一套与工具名解耦的渲染词汇表：

| 视图 | 位置 | 结构 | 用途 |
| --- | --- | --- | --- |
| `DiffCallView` | :110 | `{ card:'diff', title, diffs: FileDiff[], locations? }` | **AI 改了什么** |
| `FileDiff` | :34 | `{ path, oldText: string\|null, newText: string }` | 单文件前后内容 |
| `TerminalCallView` | :84 | `{ card:'terminal', title, description?, cwd? }` | **AI 跑了什么命令** |
| `ReadResultView` | :281 | 带 1-based 行号的 `ReadFileLine[]` | 代码查看（带行号） |
| `SearchResultView` | :267 | 匹配行 / 路径两种形态 | 搜索结果 |
| `GenericCallView` | :53 | `{ title, kind, rawInput?, locations? }` | 兜底卡片 |

**这里有个极其重要的设计**：`DiffCallView` 是在工具**执行前**（call 时）就产出的，
`oldText` 是文件改前的内容。也就是说——

> **「先看 diff → 再批准 → 才执行」的 Codex 式体验，dsh 后端已经把数据喂到嘴边了。**
> 执行后还会补一个 `DiffResultView`，带真实应用的 hunk（含上下文）。

`ToolCallKind` = `'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'`
—— 图标/分组可以直接按这个分类。

### 2.3 ✅ 审批流（Codex 式管控的执行机构，已就绪）

- 请求：`events.mux` 推 `approval/requested` 帧（含 `toolName`、`callId`、`reason`）
- 应答：`POST /api/respond` 回 `{ sessionId, approvalId, outcome: 'allowed-once' | 'rejected' }`
  （`packages/host/apiproxy/src/api/approvals.ts:4`）
- 结果：`approval/resolved` 帧回推

**意义**：不用自己发明权限系统。IDE 只需要在 UI 上做「允许一次 / 拒绝」两个按钮，
把应答打到 `/api/respond`。

### 2.4 ✅ 目录浏览（文件树的可用数据源）

`packages/host/apiproxy/src/api/host.ts:73` 的 `host.listDirectory` 返回
`DirectoryListing`（host.ts:19）：

```ts
{ path, home, crumbs: DirectoryEntry[], entries: DirectoryEntry[], truncated: boolean }
```

- `crumbs`：从根到当前目录的完整祖先链，每个都是跳转目标 → **天然面包屑**
- `entries`：直接子目录，name-sorted，含指向目录的 symlink
- `truncated`：超过完整结果上限时为 true

局限：只列**一层**，且只列目录（不列文件）。做文件树需要递归 + 自己补文件列表。
9000+ 文件的仓库要注意懒加载。

### 2.5 ✅ 前端已有 diff 渲染组件（可作为视觉参考 / 交互范式）

- `packages/client/ui-tool/src/client/tool/models/diff-card-model.ts`
  —— 把 wire 上的 `card:'diff'` 收敛成 `DiffBlock` 的 props，且做了**防御性窄化**
  （`diffs` 缺失/非数组/hunk 畸形时返回 null 走通用卡片，避免崩溃）
- `packages/client/ui-tool/src/client/tool/toolviews/file-mutation-row.tsx`
  —— 文件变更行组件，通过 `ctx.slots.inject('tool.call.toolview', ...)` 注册
- 常量 `CHAT_DIFF_MAX_LINES = 8`：聊天流里 diff 默认折叠到 8 行，详情面板展开

**意义**：diff 卡片的交互范式（折叠行数、聊天流 vs 详情面板两种疏密）已经在上游
被验证过，可以直接照搬，不用自己拍脑袋。

### 2.6 ⚠️ 半成品：能力很强，但没有 HTTP 出口

| 能力 | 位置 | 现状 |
| --- | --- | --- |
| **LSP** | `packages/lsp/lsp`（Service Definition）+ `lsp-stdio`（Provider）+ `tool-lsp`（Consumer） | `ctx.lsp` 提供 `goToDefinition` / `findReferences` / `goToImplementation` / `hover` 四个语义操作，按扩展名路由 provider。**但只有 `tool-lsp` 这一个消费者——是给模型用的工具，不是给前端的服务，没有 HTTP 端点。** |
| **持久 PTY** | `packages/terminal/terminal` | `ctx.terminals` 是 **owner-scoped**（绑定到具体 Agent）的持久 PTY seam，有 spawn/send/read/kill。**同样无 HTTP 端点。** |
| **文件工具** | `packages/fs/tool-fs`（`read.ts` / `write.ts` / `edit.ts` / `diff.ts` / `sandbox.ts`） | agent 侧文件读写 + diff 生成 + 沙箱，**只服务 agent** |

**判断**：这三项是「dsh 内部的 agent 能力」，不是「给 IDE 前端的服务」。
要做编辑器跳转或 IDE 终端，**必须自己接**（见 4.2）。

### 2.7 ✅ 前端是插件化插槽架构（远期可扩展，但本期不能用）

`packages/client/` 下有 30+ 个 `ui-*` 包，通过 `ui-slots` 注册表（`packages/client/ui-slots/README.md`）
以 `register({ name, children?, store?, inject? }, Component)` 贡献组件，
支持 `ctx.slots.inject()` 在声明前后注入。

**理论上**可以写一个包注册文件树 slot。**但这条路被自动更新堵死了**——
往 dsh workspace 里塞包会被 `git reset --hard` 抹掉（见第 7 节 R-A）。
除非走 dsh 的插件市场（`dshmarket` / cordis 插件机制）发布，那是另一条路，
且依赖上游插件加载契约，风险更高。**本期不采用。**

### 2.8 ✅ 其余可用端点（63 个方法，完整清单见 `rpc-map.ts`）

`session.*`（list/create/history/prompt/cancel/fork/models/…）、`subagent.*`、
`host.*`、`workspace.*`（多工作区已支持）、`skill.*`、`agentPreset.*`、
`goal.*`（目标追踪）、`settings.*`、`credentials.*`、`llm.*`。

调用契约：`POST /api/<method>`，必须带 `Content-Type: application/json`（缺了 415），
body `{ rpcId, method, payload }`，`method` 必须等于 URL 端点。

---

## 3. 缺口盘点：必须自建什么

| 缺口 | dsh 是否提供 | 自建难度 | 说明 |
| --- | --- | --- | --- |
| **git 集成** | ❌ 全库零 git 引用 | 中 | Electron 主进程 `spawn git`，`isomorphic-git` 兜底（已有依赖）。见 3.1 |
| **文件树 / 文件列表** | ⚠️ 只有单层目录 API | 中 | `host.listDirectory` 递归 + 懒加载，或直接主进程 fs 扫描（更快） |
| **代码编辑器** | ❌ 只有 shiki 只读高亮 | 中 | CodeMirror 6（~200KB）或 Monaco（~2MB）。**A 路线本期不需要** |
| **代码 diff 渲染** | ⚠️ dsh 有数据、自有组件 | **低** | 数据已有 `oldText/newText`，用 `diff` 库算 hunk 即可渲染 |
| **终端面板** | ❌ 无 HTTP 端点 | 中 | `node-pty` + `xterm.js`（注意 native 模块需重编译） |
| **LSP 跳转/补全** | ❌ 无 HTTP 端点 | **高** | 自己 spawn language server + JSON-RPC，**建议推迟到 C 阶段** |
| **文件读写** | ❌ 无端点 | **低** | Electron 主进程直接 `fs`，这是 Electron 相对纯 Web 的最大优势 |

### 3.1 git 数据源方案（已在上一份分析中定案）

- 主路径：spawn 系统 git（`git status --porcelain -z -uall`、`git diff -- <path>`）
- 兜底：已依赖的 `isomorphic-git`（harness 仓库 9000+ 文件，`statusMatrix` 明显慢，
  **不能当主路径**）
- **写操作护栏**（必须实现）：
  1. 监控目录 == `launcher.sourceDir` 时禁用全部写操作，UI 明示「此目录由自动更新管理」
  2. 写前检查 `.git/index.lock`，存在则拒绝
  3. `checkout` 等破坏性操作二次确认

---

## 4. 四条技术路线对比

### 4.1 路线 A：外壳增强（Shell-Augmented）⭐ 推荐起步

保持 dsh web 为主视图，Electron 侧增加面板容器（`WebContentsView`），
自建 git/文件树/变更面板，通过 SSE + HTTP 消费 dsh。

- **优点**：零上游侵入；上游升级不碎；上一份分析已铺好方案（双视图、写护栏）
- **缺点**：不能在 shell 内编辑代码（编辑跳转需外部编辑器）
- **上游改动**：0 处
- **适合**：Codex 式 / WorkBuddy 式

### 4.2 路线 C：自建 IDE 前端（Own Frontend）

Electron 内另起一个 React 前端（文件树 + CodeMirror + 终端 + git + diff），
完全靠 HTTP/SSE 驱动 dsh，dsh web 降级为可选视图。

- **优点**：真正的 IDE 体验；完全自主可控；代码全在自己仓
- **缺点**：工作量最大；LSP 是长期工程；要自己处理大文件性能
- **上游改动**：0 处
- **判断**：这是终局形态，但**不是第一步**。等路线 A 验证了对 AI 变更的管控价值再投。

### 4.3 路线 S：前端插槽注入（In-Client Slot）

利用 `ui-slots` 写一个插件包，注册文件树/变更面板 slot，随 dsh 前端构建。

- **优点**：能力最深，能复用前端的会话/工作区/设置状态
- **致命缺点**：包要放进 dsh workspace → **被自动更新的 `git reset --hard` 抹掉**（R-A）。
  除非走插件市场发布，但那样又依赖上游插件加载契约，且上游 alpha 滚动会碎。
- **结论**：❌ **不采用**

### 4.4 路线 P：标准 ACP 客户端

把 dsh 当 ACP agent，写一个标准 ACP client 做 IDE。

- **已证否**，依据 `packages/acp/acp/README.md` 原文：
  - 定位是「**Automation-only** ACP server over JSON-RPC stdio」，主要客户端是 `dsh-subagent-acp`
  - `initialize` 时「No session, editor, terminal, filesystem, or MCP capability is advertised」
  - 明确「does not expose editor navigation, transcript replay, commands, modes,
    configuration pickers, elicitation, reasoning, plans, titles, or tool presentation」
  - `session/new` 接受空 `additionalDirectories`/`mcpServers`，非空则拒绝
  - 输出是「committed-message only」——为自动化结果牺牲了 token 级流式延迟
- **结论**：❌ **dsh 的 ACP 是"被父 agent 驱动"的那一侧，不是"给 IDE 接"的那一侧。**
  走这条路能力集最小（无文件、无终端、无编辑器能力通告），且与事件流方案重叠。
  
  *附带价值*：ACP 仍可用于「shell 内部需要程序化驱动 dsh 子任务」的场景（如批量跑任务），
  但不作为 IDE 前端的主通道。

---

## 5. 推荐：双轨渐进

```
现在 ──────────────► 阶段一 ──────────► 阶段二 ──────────► 阶段三
启动器外壳            变更管控 IDE        轻量编辑器         完整 IDE（可选）
                     （Codex 式）        （可编辑 diff）     （路线 C）
                     
                     ├─ 面板容器
                     ├─ git 只读面板
                     ├─ 变更审阅中心  ◄── dsh DiffCallView
                     └─ 审批中心      ◄── dsh approval/requested
                     
                     ▲ 全部在 shell 仓，上游零改动
```

### 阶段一：变更管控 IDE（推荐本期目标）

| 优先级 | 功能 | dsh 数据源 | 自建部分 | 价值 |
| --- | --- | --- | --- | --- |
| P0 | 面板容器（可调整大小 / 显隐持久化） | — | 全部 | 后续所有面板的承载体 |
| P0 | **变更审阅中心** | `DiffCallView`（SSE） | diff 计算 + 渲染 | **Codex 体验核心** |
| P0 | **审批中心** | `approval/requested` → `/api/respond` | 两个按钮 | **代码管控的落点** |
| P0 | git 只读面板（分支/变更/状态） | — | spawn git + iso-git | 你说的「git 这些」 |
| P1 | 文件树 + 点击预览（shiki 高亮） | `host.listDirectory` | 树组件 + 懒加载 | 定位改了哪些文件 |
| P1 | 终端输出面板（只读回放） | `TerminalCallView` | 渲染 | 看 AI 跑了什么命令 |
| P1 | 底部面板（4 份日志现散在 `%APPDATA%`） | — | 全部 | 降低排障成本 |
| P2 | 多会话 / 多标签 | `session.list` | — | 依赖端点稳定性 |
| P2 | git 写操作（暂存/提交/切换分支） | — | 全部 + 3.1 护栏 | 风险高，后置 |
| P3 | 命令面板 (Cmd/Ctrl+K) | — | 全部 | 依赖容器架构 |

**这一阶段结束后，产品形态 = 「Codex 式变更审阅 + WorkBuddy 式工具卡片 + git 基线」，
正好命中你的诉求。**

### 阶段二：轻量编辑器（视阶段一反馈决定）

- 引入 CodeMirror 6（`~200KB`，比 Monaco 轻一个量级）
- 只读为主，**支持在 diff 上直接微调后再应用**（不是完整编辑体验）
- 打开外部编辑器（VS Code）作为补充路径：`host.openPath` 已有端点

### 阶段三：完整 IDE（路线 C）

- Monaco/CodeMirror 完整编辑 + 多标签
- LSP：自己 spawn language server（复用 `lsp-stdio` 的思路，但在 Electron 侧实现）
- 终端：`node-pty` + `xterm.js`
- **判断：投入产出比未验证前不要启动。** LSP + 多语言 + 大文件性能是无底洞。

---

## 6. 架构建议（阶段一）

```
┌─ Electron 主进程 ─────────────────────────────────────────┐
│  ┌─ dsh-backend.ts ──────────┐  ┌─ git-service.ts ──────┐  │
│  │ SSE events.mux 订阅        │  │ spawn git (主)         │  │
│  │ POST /api/respond 审批     │  │ isomorphic-git (兜底)  │  │
│  │ POST /api/session.list     │  │ 写操作护栏             │  │
│  │ POST /api/host.listDirectory│ └───────────────────────┘  │
│  └───────────────────────────┘  ┌─ fs-service.ts ───────┐  │
│  ┌─ window-manager.ts (新拆) ─┐ │ 主进程直接 fs 读写      │  │
│  │ 主视图 + 侧栏/底栏视图      │ │ 文件树扫描             │  │
│  └───────────────────────────┘  └───────────────────────┘  │
└───────────────────────────────────────────────────────────┘
        │ IPC（中心注册表 channels.ts 扩展）
┌─ Renderer ───────────────────────────────────────────────┐
│  主视图：dsh web（loadURL，不变）                          │
│  侧栏/底栏：自建 HTML + preload（独立 contextIsolation）   │
│     ├─ 变更审阅中心（diff 列表 + 单文件展开）              │
│     ├─ 审批中心（允许一次 / 拒绝）                         │
│     ├─ git 面板（分支 / 变更文件 / 状态）                  │
│     └─ 文件树（懒加载）                                   │
└───────────────────────────────────────────────────────────┘
```

**三条架构铁律**（延续上一份分析的结论）：

1. **从 `main.ts` 拆出 `window-manager.ts`** —— main.ts 已经 705 行且会继续膨胀（R2）
2. **IPC 中心注册表** —— 扩展 `channels.ts`，不要散落注册（R3）
3. **独立 `sidebar-preload.js`** —— 避免侧栏 API 污染主视图 `window`（R8）

---

## 7. 决定性约束与风险

| # | 风险 | 严重度 | 说明与对策 |
| --- | --- | --- | --- |
| **R-A** | **自动更新 `git reset --hard` 会抹掉 dsh workspace 内的一切改动** | **高（决定性）** | 这是路线 S 被否的根本原因。所有代码必须在 shell 仓。侧栏面板监控该目录时禁用写操作 |
| **R-B** | `/api/*` 是半公开契约，**无版本承诺** | 高 | 调用点集中在 `dsh-backend.ts` 一个模块；失败降级为手动选目录；上游 alpha 滚动可能改名 |
| **R-C** | 版本漂移：rc.2 运行副本不带 token，历史 alpha 带 token | 中 | 主窗口 URL 捕获的 token「有则带、无则裸调」，两种都兼容。**不要按单一版本调研结果写死** |
| **R-D** | `runtime-source.ts` 2867 行单模块（51% 代码） | 高 | 不重构它，但新功能一律不往里塞（R1 延续） |
| **R-E** | 大仓库性能：harness 9000+ 文件 | 中 | 文件树懒加载；`isomorphic-git` 只兜底不主用；git status 结果做增量更新 |
| **R-F** | LSP 是长期工程（阶段三） | 中 | 阶段一/二不碰；真需要时优先只做 TS/JS |
| **R-G** | `node-pty` 是 native 模块，Electron 版本升级需重编译 | 中 | 阶段一用只读终端回放（`TerminalCallView`）绕开；真需要可交互终端再引入 |
| **R-H** | 运行副本存在未解决 `pnpm-lock.yaml`（`UU`）冲突 | 中 | **建议处理 IDE 化之前先处理**（R6 延续） |
| **R-I** | 测试是 7 个 `.cjs` 脚本，无覆盖率 | 中 | 新模块（diff 计算、git 解析）必须有单测，这两个是纯函数，最容易测 |

---

## 8. 与上一份分析（2026-09-01 侧边栏）的关系

上一份 `docs/analysis-2026-09-01.md` 提出的「双 WebContentsView 侧栏 + git 只读面板」
**完全有效，且正是本报告阶段一的 P0 子集**。本报告的增量是：

1. 把「侧栏」升级为「变更管控 IDE」的**产品定位**（而非一个附属面板）
2. 找到了上一份没挖到的关键能力：**`DiffCallView` + 审批流**——这把「看 git 状态」
   升级成了「**管控 AI 的改动**」，价值高一个量级
3. 明确否掉了 ACP 路线（上一份未涉及）
4. 明确否掉了前端插槽注入路线（自动更新冲突，上一份未涉及）

---

## 9. 待确认事项（需要你拍板）

1. **目标形态**：A（Codex 式变更审阅）/ B（WorkBuddy 式对话卡片）/ A+B 混合？
   → 我推荐 **A+B 混合**：对话流里保留工具卡片（B 的直觉），同时有集中式变更审阅区（A 的管控）
2. **本期范围**：是否同意阶段一（变更审阅中心 + 审批 + git 只读 + 文件树）？
3. **代码编辑**：阶段一完全不做编辑，改文件走外部编辑器（`host.openPath`），是否接受？
4. **架构铺路**：是否在功能开发前先做第 6 节的三条铁律（拆 `window-manager.ts`、
   IPC 中心注册表、独立 preload，约半天改动量）？→ **建议做，否则 R2/R3/R8 会恶化**
5. **R-H**：是否先处理运行副本的 `pnpm-lock.yaml` 冲突？
6. **git 写操作**：本期只做只读，还是包含暂存/提交？（含则必须实现 3.1 三条护栏）
