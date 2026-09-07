# 多用户 DSH 财务部部署实施计划（auth + 角色提示词 + 工作空间分配）

> **For agentic workers:** 本计划按阶段推进，每阶段有独立验证标准。P0 为决策前置，P1–P5 为实施，P6 可选，P7 为整体验收。

**Goal:** 在单实例 DSH 上叠加"账号密码登录 → 角色 → 提示词/工作空间/Skill/权限"的映射层，实现财务部（财务经理 + 普通财务）共用工作空间与技能、管理员全权限可控的多用户部署。

**Architecture:** 官方 DSH 单进程多会话 + 社区认证网关（dsh-remote / dsh-passwords 二选一，P0 定稿）+ 少量定制胶水（角色→预设/工作空间映射、会话可见性过滤、管理员放行）。角色约束分两层：提示词层（行为约束，软约束）+ 权限预设/沙箱层（能力边界，硬约束）。

**Tech Stack:** DeepSeek Harness 0.1.2-alpha.3（本地 checkout）、cordis 组合（agent-presets / persona / workspace / permission-presets）、社区插件（dsh-remote 或 dsh-passwords）、可选 caddy TLS 反代、可选 token-ledger-pro。

---

## 1. 可行性评估

### 结论：可行，且官方架构支持度高于预期

| 需求 | 官方/社区现状 | 证据 | 结论 |
|---|---|---|---|
| 局域网访问 | `trustedHosts` 信任栅栏 + 社区 LAN 插件/反代 | `packages/client/connection` 配置项；CLI 仍封 `0.0.0.0`（安全原因） | ✅ 用反代 + 网关解决 |
| 账号密码登录 | 社区插件：dsh-remote（账号密码+MFA+角色）、dsh-passwords（子用户权限+配额+审计）、GDWhisper/dsh-web-startup-auth | GitHub 检索 | ✅ 现成，P0 审代码选型 |
| 角色 → 不同提示词 | **官方原生**：agent-presets 每会话挂一个预设；`dsh-persona` 支持 `text`（角色提示词）、`complete`、按 scope 注入 | `packages/preset/persona/src/index.ts:30-47`；standard/minimal 预设示例 | ✅ 每角色一个 preset 即可 |
| 同部门共用工作空间 | **官方原生**：workspace 实体，多会话可属同一 workspace（`fs-per-session-cwd`）；`workspace-controller` 有 create/rename/delete/insertSessionBefore/archiveSession | `packages/api/workspace-controller` Remote 列表 | ✅ 财务经理+普通财务共用 finance-ws |
| 同部门共用 skill | **官方原生**：skill-filesystem 按 scope 分层；同一 preset 的 skill 层共享 | `packages/skill/skill-filesystem`；预设可挂 skill 目录 | ✅ 部门预设共用技能集 |
| 管理员全权限 + 管理所有工作空间数据 | 会话列表全局可见（现状）；workspace-controller 全量方法；admin 角色经网关放行 | session-controller / workspace-controller 源码 | ✅ 主要补"角色门" |
| 按角色约束 AI 行为 | 提示词约束（软）+ permission-presets（硬）+ 沙箱 | `settings.yaml` permission.defaultPreset；ui-permission-presets | ✅ 双层设计 |
| Token 统计 | 官方 token-meter（每会话计量）+ 社区 token-ledger-pro / usage-dashboard | base bundle 的 token-meter 行 | ✅ 可选阶段 |

### 必须明确的边界（不解决会翻车）

1. **提示词不是安全边界**。角色提示词约束"AI 怎么干活"，约束不了"AI 能碰到什么"——后者由权限预设 + 沙箱 + OS 目录权限决定。财务经理与普通财务同工作空间时，若要求"普通财务改不了经理的文件"，需要**文件级权限**（当前 fs 沙箱按会话模式，不做用户 ACL）——本计划 P3 将其列为可选决策点，默认不隔离文件。
2. **单实例无 OS 级用户隔离**。同一进程共享凭据库（`$DSH_HOME/.credentials.yaml`）、settings.yaml、存储。适用于内网可信团队；不可信/对外场景应改用每用户独立实例（dsh-hub 路线）。
3. **第三方插件兼容性**：dsh-remote / dsh-passwords 针对公开发布版开发，与本地 0.1.2-alpha.3 的兼容性必须 P0 实测。
4. **会话可见性过滤是主要定制点**：官方 session 列表是全局的，需要按用户过滤（见 P4）。

---

## 2. 系统设计

### 2.1 角色与权限模型

| 角色 | 账号（精确区分大小写） | 预设（提示词） | 工作空间 | Skill | 权限预设 |
|---|---|---|---|---|---|
| `admin` 管理员 | `admin` | 默认 `standard-terminal`（全量：含动态插件/终端） | 全部 | 全部 | `danger-full-access` |
| `finance-manager` 财务经理 | `Finance-mgr` | `finance-manager`（审批、复核、汇总裁决） | `finance-ws` | finance 技能集 | `finance-confined`（workspace-write + never） |
| `finance-staff` 普通财务 | `Finance-staff` | `finance-staff`（制单、录入、查询、不可审批） | `finance-ws`（与经理共用） | 同一套 finance 技能集 | `finance-confined` |
| 6 个扩展部门角色 | 待建账号 | `art-design` / `business-sales` / `procurement` / `production` / `hr-management` / `rd-development` | 各自待建（`art-ws` 等，可选） | 各自 `skills/<domain>/SKILL.md` | `finance-confined`（受限，无 shell/web/subagent/workflow） |

> 8 个角色预设均已落地于 `~/.dsh/.agent-presets/<id>/`（`agent.cordis.yml` + `preset.yml` + `skills/<domain>/SKILL.md`），6 个扩展预设与 finance 预设同为受限组合。预设选择 / 工作空间（可多选）现由**账号管理界面**运行时维护，写入 `~/.dsh/auth/role-map.json` 并叠加在静态 `roleMap` 之上（见附录 F）。

**门禁层角色映射（P0 选型结论：dsh-remote 的固定三档角色）**：`admin → admin`；`finance-manager / finance-staff → user`（门禁层同属"工作角色"：被拒 settings.*/credentials.*/agentPreset.*/host.*，可正常会话工作）。经理与员工的**业务差异由 `roles.yaml` 映射表承载**（同 username → 不同预设），不依赖门禁角色档位。若未来需要经理/员工在门禁层也不同（如员工禁止会话导出），P1 决策点：fork dsh-remote 扩展角色联合类型（改动小，已定位 `lib/index.js` 的 role gate 与 zod 联合）。

### 2.2 组件拓扑

```
浏览器（局域网设备）
   │ HTTPS（caddy 反代，可选）
   ▼
认证网关（dsh-remote 或 dsh-passwords，P0 定稿）
   │ 账号密码登录 → 角色令牌（admin / finance-manager / finance-staff）
   │ 会话可见性过滤（P4 定制）：非 admin 只见 finance-ws 的会话
   ▼
DSH 单实例（0.1.2-alpha.3，127.0.0.1:3080）
   ├─ 角色映射插件（P3 定制，host 插件）
   │    登录用户 → 默认预设（persona 提示词）+ 工作空间 + 权限预设
   ├─ agent-presets：admin / finance-manager / finance-staff 三个预设
   ├─ workspace：finance-ws（部门共用）
   ├─ skill：finance 技能集挂进两个 finance 预设的 skill 层
   └─ token-meter +（可选）token-ledger-pro 统计
```

### 2.3 关键机制

- **角色 → 提示词**：每个角色一个 preset，preset 的 `persona` 行写角色提示词（含行为约束条款）。会话创建时按登录角色选预设（官方 `select(agent, agentPreset)` Remote + 映射插件）。
- **工作空间**：`finance-ws` 由管理员创建；两个 finance 角色共用。会话按 workspace 归属（官方原生）。
- **Skill**：部门预设的 `skill-filesystem` 行挂 finance 技能目录（`~/.dsh/.agent-presets/.../skills/finance/` 或用户级 `~/.agents/skills/finance-*`），两角色同预设族 → 同技能集。
- **管理员**：admin 角色经网关放行所有 Remote（session/workspace/settings/credentials）；workspace-controller 的 create/rename/delete/archiveSession 即"分配调整工作空间数据"的官方入口。

---

## 3. 实施计划

### P0：选型与兼容性验证（✅ 已完成，决策见附录 A）

**结论：认证网关选 `@xgone/dsh-remote` v0.3.0（插件式、MFA、角色门、与现有单实例形态一致）；备选 `dsh-passwords`（alpha.3 兼容矩阵背书，但为独立网关进程）。P1 实测若 dsh-remote 在 0.1.2-alpha.3 上出现兼容问题，切换备选。**

**Files:**
- 审阅：`C:\Users\<用户名>\Desktop\audit\dsh-remote`、`C:\Users\<用户名>\Desktop\audit\dsh-passwords`（已 clone）

- [ ] **Step 1（已完成）: 克隆并审阅两个候选网关**
  审计结论摘要：
  - dsh-remote：MIT、npm 发布 v0.3.0、cordis 双半区 + bundle patch；scrypt 密码哈希、HMAC-SHA256 签名 HttpOnly Cookie、RFC 6238 TOTP + 备用码、IP+用户名限速、loopback-only 引导创建首管理员、受保护根账号；角色固定三档 `admin/user/guest`（`lib/index.js` zod 联合，未知角色回落 user）；trustProxy 把认证后请求 Host/Origin 归一化到 loopback 以穿透官方信任围栏；依赖仅 cordis + dsh-home-paths + schemastery + qrcode；README 明示"每用户独立工作区/会话插件层做不了"（事件流/搜索全局泄漏）。
  - dsh-passwords：v2.6.7，兼容矩阵声明支持 DSH **0.1.2-alpha.1~alpha.3**（正是本机版本）；独立网关进程（自带 DB/.env/Docker）、子用户资源过滤（workspace/follow、session/control 按用户过滤）、配额、审计日志、fail-closed 生命周期（缺补丁 exit 33/35）；部署形态重。
- [ ] **Step 2: 兼容性实测（P1 前置，未做）**
  命令：`dsh plugin --profile web add @xgone/dsh-remote` → 重启 → 登录页出现 → loopback 创建首管理员 → 验证 `/auth/me`。失败则记录错误并切换到 dsh-passwords。
- [ ] **Step 3: 决策已记录**
  见附录 A（本文件下方）。

### P1：认证网关部署

**Files:**
- Modify: `~/.dsh/profiles/web/cordis.patch.yml`（dsh-remote 行配置，装包时自动追加 bundle）
- Create: `~/.dsh/roles.yaml`（业务角色映射表：username → 预设/工作空间/权限）

- [ ] **Step 1: 安装 dsh-remote**
  命令（repo 根目录）：`pnpm dsh plugin --profile web add @xgone/dsh-remote`
  验证：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 出现 `@xgone/dsh-remote`。
- [ ] **Step 2: 配置角色模式**
  在 `~/.dsh/profiles/web/cordis.patch.yml` 给 `remote` 行补配置：`adminOnly: false`（允许多账号）、`enforceRoles: true`、`bootstrap: {username: admin, password: <强密码>}`（headless 预置首管理员，幂等；首次登录后移除该节）。
- [ ] **Step 3: 重启并验证登录**
  命令：重启 web 应用 → 浏览器登录 admin → `curl http://127.0.0.1:3080/auth/me` 返回 `{authenticated:true, role:"admin"}`。
- [ ] **Step 4: 创建部门账号（管理员操作）**
  登录 admin → 设置 → 登录与账号 → 添加 `mgr`（role: user）、`staff`（role: user）；建议绑定 MFA。
- [ ] **Step 5（可选）: TLS 反代**
  用 caddy 对 127.0.0.1:3080 反代（WebSocket 升级转发 + `session.secure: true`），局域网设备经 `https://<host>` 访问。

**验收:** 三账号可登录（admin 管理员、mgr/staff 为 user 角色）；错误密码被拒且限速生效；`/api` 对未认证请求返回 403。

### P2：角色预设与提示词

**Files:**
- Create: `~/.dsh/.agent-presets/finance-manager/`（agent.cordis.yml + preset.yml）
- Create: `~/.dsh/.agent-presets/finance-staff/`
- Create: `~/.dsh/.agent-presets/admin-preset/`（或直接沿用 cordis/standard）

- [ ] **Step 1: 复制官方 standard 生成三个预设骨架**
  命令（以 finance-manager 为例）：
  ```powershell
  Copy-Item C:\Users\<用户名>\Desktop\deepseek-harness\packages\preset\agent-presets\presets\standard\agent.cordis.yml `
    "$env:USERPROFILE\.dsh\.agent-presets\finance-manager\agent.cordis.yml"
  ```
- [ ] **Step 2: 写角色提示词（persona 行）**
  在 `finance-manager/agent.cordis.yml` 的 persona 行写入，示例：
  ```yaml
  - id: persona
    name: '@deepseek-ai/dsh-persona'
    config:
      text: >-
        你是财务部经理助理。你可以：汇总财务数据、复核单据、生成审批意见。
        你不可以：未经授权的对外发送、修改凭证、删除数据。
        所有涉及资金的指令必须向用户确认后执行。
  ```
  `finance-staff` 的 persona 写普通财务约束（制单/录入/查询，无审批权，敏感操作必须请示）。
- [ ] **Step 3: 按角色裁剪工具集**
  从两个预设删除高风险工具行（如默认保留 fs/pwsh 但移除或保留由权限预设兜底）；至少保证 finance 预设**不挂动态插件工具**（cordis 工具集仅 admin 保留）。
- [ ] **Step 4: 挂载校验**
  命令：用 agentPresets 服务的 `standingKeyFor('finance-manager')` / `('finance-staff')` 校验（探针插件方法见 P4 Step 2 模板），预期 `mounted OK`。

**验收:** 三个预设均通过挂载校验；两个 finance 预设的 persona 文本正确；admin 预设含动态插件工具。

### P3：工作空间与角色映射

**Files:**
- Create: `~/.dsh/.agent-presets/finance-manager/skills/finance/`（finance 技能集，两个预设共用）
- Create: `~/.dsh/roles.yaml`（角色 → 预设/工作空间/权限 映射表）
- Create: `~/.dsh/plugins/role-mapper/`（定制 host 插件源码 + 构建）

- [ ] **Step 1: 创建 finance 技能集**
  将部门技能（如报销审核、凭证规范）写成 `SKILL.md` 放入两个预设共享的 skills 目录；两个 finance 预设的 `skill-filesystem` 行挂该目录。
- [ ] **Step 2: 管理员创建 finance-ws**
  以 admin 登录 → 工作空间管理 → 新建 `finance-ws`（或调用 workspace-controller create Remote）。
- [ ] **Step 3: 写角色映射表**
  ```yaml
  roles:
    finance-manager: { preset: finance-manager, workspace: finance-ws, permission: workspace-write }
    finance-staff:   { preset: finance-staff,   workspace: finance-ws, permission: workspace-write }
    admin:           { preset: admin-preset,    workspace: null,       permission: danger-full-access }
  ```
- [ ] **Step 4: 实现 role-mapper 插件（会话创建时按用户落预设/工作空间）**
  host 插件骨架（挂进 web 组合，注入 `agentPresets`，在会话创建回调里按登录用户调 `select(agent, presetId)`）：
  ```js
  return {
    name: 'role-mapper',
    inject: ['agentPresets'],
    apply(ctx) {
      // 在会话创建事件/agent setup 中：读登录用户 → roles.yaml → agentPresets.select(agent, preset)
      // （事件名与调用点以 P0 源码审计为准）
    },
  }
  ```
- [ ] **Step 5: 验证**
  mgr 登录新建会话 → 会话记录预设 `finance-manager`、工作空间 `finance-ws`；staff 同理；admin 新建会话可任意选择工作空间。

**验收:** 三角色新建会话的预设/工作空间符合映射表。

### P4：会话可见性过滤（核心定制点）

**Files:**
- Create: `~/.dsh/plugins/session-filter/`（定制网关或 host 插件）

- [ ] **Step 1: 选择实现层**（P0 审计结论：dsh-remote 明示"事件流/搜索/任务全局泄漏无法在插件层隔离"，因此本步骤定位为**控制面过滤**：隐藏会话列表 + 拒绝打开越权会话；数据面（搜索、事件流）不做承诺）
  - 路线 A（网关层）：在 dsh-remote 门禁内扩展，按会话归属过滤 session 列表响应（JSON 改写）。
  - 路线 B（host 插件）：注入 web 组合，包装 session 列表 Remote，按登录用户过滤。
- [ ] **Step 2: 实现过滤逻辑**
  规则：`admin` → 全量；`user` 角色 → 仅 `finance-ws` 的会话（按 roles.yaml 的 username → workspace 映射）；其余 → 空列表。越权打开会话 id → 403。
- [ ] **Step 3: 验证**
  staff 登录 → 会话列表只见 finance-ws 会话；admin 登录 → 全部可见；直接构造 API 请求访问他人会话 id → 被拒。

**验收:** 非 admin 无法看到/打开其他工作空间会话（含直接 API 路径）；已知边界：跨会话搜索与事件流泄漏不在本阶段承诺（见风险表）。

### P5：管理员控制台与角色门

**Files:**
- Modify: 网关配置（admin 放行规则）
- 可选：`~/.dsh/plugins/` 下管理员设置页定制（沿用官方 ui-settings / ui-workspace 即可，先不做新 UI）

- [ ] **Step 1: 网关角色门**
  配置 admin 角色可调用全部 Remote（session/workspace/settings/credentials）；非 admin 禁止 settings/credentials 域。
- [ ] **Step 2: 验证管理员工作流**
  admin 登录 → 创建/重命名/删除工作空间 → 移动会话（`insertSessionBefore`/`archiveSession`）→ 均成功；mgr/staff 调用这些接口 → 被拒。
- [ ] **Step 3: 文档化**
  在 `plan.md` 附录 B 记录管理员操作手册（如何分配工作空间、调整用户角色）。

**验收:** admin 全权限闭环；非 admin 调用管理接口全部被拒。

### P5.1：非 admin 操作权限收紧（✅ 已完成：2026-09-02，待重启验证）

**背景:** Finance-mgr 会话让 AI 重启了服务器（预设含 shell 工具 + 全局默认 `danger-full-access` + 审批 never），违反"操作权限限定在工作区文件夹内"的要求。

**Files:**
- Modify: `~/.dsh/.agent-presets/{finance-manager,finance-staff}/agent.cordis.yml` —— 两个预设瘦身为受限组合：**移除** tool-bash/tool-pwsh（任意命令执行）、tool-jobs、command-goal/tool-goal、plan-mode、整个 delegation 组（subagent/workflow/ralph）、tool-web（网络出口）；保留 persona / agent-instructions / tool-fs / tool-fs-search / skills / compaction / ask-user / todo。
- Modify: `~/.dsh/plugins/dsh-remote-local/lib/index.js` —— ① `NON_ADMIN_DENY` 增 `commands.execute`（封死 /permission 等所有客户端命令，非 admin 无法自行改宽沙箱/审批旋钮）；② 未映射（无 roleMap 条目）的非 admin 账号对全部 `session.*` 方法 fail-closed（否则 session.list 会因无 scopeUser 而返回全量会话）；③ `session.selectModel` 纳入会话归属校验；④ 新增**会话钉住**：凡 header.agentPreset 为映射预设（或 cwd 落在映射工作区路径）的会话，追加 `sandbox/mode=workspace-write` + `approval/policy=never` + `permission/preset=finance-confined`（新建会话经 `session/created` 监听，存量会话启动时全量补齐；本插件注册晚于 permission-presets，事件折叠后者生效）。
- Modify: `~/.dsh/profiles/web/cordis.patch.yml` —— 覆写 `permission` 行，预设表新增 `finance-confined`（workspace-write + never，显示名"工作区限定"）。
- Modify: fork 测试 `test/role-gate.test.js` —— 新增 4 例（未映射账号拒绝/映射账号放行/admin 豁免/commands 拒绝），12/12 通过。

**边界语义:** `workspace-write` 的写根 = 会话 cwd = `C:\Users\<用户名>\Desktop\finance-ws`（+ 平台临时目录）；approval `never` 使任何 `sandbox_permissions` 升级被确定性拒绝。读取操作不受模式限制（产品默认行为），本阶段接受该残余面；如需读取级隔离需改官方 fs-sandbox。

**验收（待重启）:**
- Finance-mgr / Finance-staff 新会话与存量会话 → 运行时上下文显示 `Current DSH file policy: workspace-write`（根为 finance-ws）+ "Approval prompts are disabled"；向 finance-ws 外写文件 → 被拒且无法升级；无 shell/terminal/subagent/web 工具；`/permission`、`/export`、`/compact` 等命令被拒。
- admin 会话不受影响（仍 danger-full-access）；admin 仍可在设置页查看 Usage 面板。

### P6：Token 统计（✅ 已完成：2026-09-02 安装 dsh-usage-panel，待重启验证）

**选型:** dsh-token-ledger-pro（每用户输入框小组件，不满足"管理员看全站"）已卸载；改用社区 `dsh-usage-panel`（AlfredChaos/dsh-usage-panel，MIT，零依赖）：设置页 **Usage 面板**，从持久化会话日志聚合全站用量（跨所有登录用户）——累计 Token/KPI、缓存命中率、半年热力图、按模型柱状图、Top 会话、导出 CSV/JSON。

**2026-09-02 事故与修复:** npm 原版 0.2.0 按 rc.6 的 `sessionProjectionCache.coldSnapshot(sessionId)` 编写；本运行时（0.1.2-alpha.3）签名是 `coldSnapshot(meta, events)`，首次启动每会话抛 `Cannot read properties of undefined (reading 'at')`，重扫后把进程带崩（exit 4294967295）。已**本地 fork** 到 `~/.dsh/plugins/dsh-usage-panel-local`：强制 `mode="scan"`（走 `sessionQuery.listSessions/readSession/readTitle`，该 API 与 rc.6 形状一致、已对照 harness 源码验证），跳过坏掉的 projection 路径；profile 依赖改为 `link:`。**第二次事故**：`link:` 依赖不会安装被链接包自己的依赖，fork 目录内必须单独 `pnpm install`（zod/react 等），否则插件加载即 `ERR_MODULE_NOT_FOUND: zod`——已补装并验证 boot 成功。

**Files:**
- 审计：`C:\Users\<用户名>\Desktop\audit\dsh-usage-panel`
- Create: `~/.dsh/plugins/dsh-usage-panel-local`（本地 fork，scan 模式补丁）
- Modify: `~/.dsh/plugins/dsh-remote-local/lib/index.js`（wrapHttp 硬门：`/usage-stats` 数据通道非 admin 一律 403；设置页本身已被 NON_ADMIN_DENY 拒掉 → 双层管理员专属）

- [x] **Step 1: 审代码并挂载**
  命令：`pnpm dsh plugin --profile web remove dsh-token-ledger-pro`（exit 0）+ `pnpm dsh plugin --profile web add dsh-usage-panel`（exit 0）→ 首启崩溃后：remove npm 版 + `add C:\Users\<用户名>\.dsh\plugins\dsh-usage-panel-local`（link:，exit 0，bundles 含 `dsh-usage-panel`）
- [ ] **Step 2: 验证（待重启）**
  admin → 设置 → Usage 页可见全站统计；Finance-mgr/Finance-staff → 设置被拒（settings.* deny）+ `/usage-stats` 直连返回 403。

### P7：端到端验收

- [ ] **Step 1: 剧本执行**（三个浏览器/设备）
  1. `Finance-staff` 登录 → 新建会话 → 提示词为普通财务约束 → 提问"报销单录入" → AI 执行制单类操作，拒绝审批类请求；
  2. `Finance-mgr` 登录 → 会话列表仅含自己账户的会话（重登后仍保留）→ 看不到 Finance-staff 会话 → 提示词含复核/审批条款；
  3. `admin` 登录 → 可见全部账户全部会话 → 可新建/调整工作空间、移动会话、查看全部；
  4. 权限验证：Finance-staff 尝试打开 Finance-mgr 账户的会话 → 不可见且直连被拒。
- [ ] **Step 2: 记录结论**（附录 C：实测结果表）

### P8：办公文档能力（✅ 已完成实施：2026-09-02，待重启验证）

**需求:** 上传/阅读 Word、Excel、PDF；页内分列窗格供用户查看和编辑文档，AI 同时可读写。

**选型结论:**
- **AI 解析**: `dsh-doc@0.1.1`（[Sqhao-O/dsh-docs](https://github.com/Sqhao-O/dsh-docs)，MIT）——全本地解析 PDF/DOCX/XLSX/PPTX/MD/CSV + 离线中文 OCR（扫描发票）；安全模型与 P5.1 一致：路径 realpath 校验 + 仅会话工作区可读、URL 拒绝、引擎只收字节流、无监听端口、OCR 语言包本地失败即拒。工具 `dshdoc_health`/`dshdoc_extract`。
- **页内窗格**: `folder-tree-sh`（[Nothree-code/folder-tree-sh](https://github.com/Nothree-code/folder-tree-sh)，MIT）——工作区文件树 + 多标签预览（PDF 原生渲染 / DOCX mammoth 真渲染 / CSV 表格 / 图片 / Markdown 渲染+内联编辑）+ 5 秒自动刷新（AI 改文件窗格自动更新）。
- **否决**: DSH-Office（第三方引擎自动下载）；dsh-workbench-plugin（内置 PTY 终端 + git 工具，对财务账号是安全倒退）。
- **已知边界**: 页内原生 Word/Excel 所见即所得编辑无任何插件实现；原生文件编辑由 AI 代劳（CSV/MD 直接写，docx/xlsx 经用户 Office 另存），窗格负责查看。
- **2026-09-02 窗格不显示事故与修复（根因）**: 上游客户端 bundle 未导出 `inject`，客户端内核在 ui-renderer 提供 `slots` 服务**之前**就执行了其 apply → `ctx.get('slots')` 为 undefined → 整个槽位注册被静默跳过（CSS 已注入、无报错、无 UI）。排查手段：客户端 Slots Inspect（`sidebar.footer.action` 占用者无 ftree 条目）对比 usage-panel（导出 inject 等待服务 → 注册成功）。已**本地 fork** 到 `~/.dsh/plugins/folder-tree-sh-local`：`exports.inject = ["slots"]` 一行修复；profile 依赖改 `link:`，fork 目录内已 `pnpm install`（mammoth/iconv-lite/react）。
- **2026-09-02 分列排版修复**: 上游把树列/预览列做成 fixed 浮层并对目标版本的前端类名（`.pI_x6G_frame`）做 margin 补偿，与 0.1.2 AppFrame 不匹配 → 盖住对话区。fork 已重写布局引擎：以 `[data-shell-overlay]` 的父元素定位帧（AppFrame 结构：DocumentTitle 渲染 null，网格子元素 = [sidebar][center][details][overlay]），树列贴侧栏右侧、预览列贴 details 列左侧，聊天区以 `marginLeft/marginRight` 双端让位，关闭时复位——最终呈现 [侧栏][文件树][对话][预览][详情] 分列。**二次修复（实测数据定位）**：0.1.2 客户端内核无 `timer` 服务 → 上游 1 秒重排循环从未启动，且插件 apply 时 React 尚未渲染帧、`frameEl` 只在定时循环里重找 → 布局永远早退（树列/预览列停在 x=0）。修复：`applyLayout` 每次懒解析帧 + MutationObserver 每次重排 + 自有 `setInterval` 兜底（随插件 disposer 清理）。

- **2026-09-02 上传/下载/拖拽复制（P8.1）**: ① fork 门禁：guest 对全部 `/dsh-ftree-*` 返回 403"需要升级权限才能使用该功能"；为每个 ftree 请求盖 `x-dsh-role` 头；upload 的 `dir` 查询参数纳入收容校验；二进制上传体验证后直通 handler（防止后续 roleGate 吞掉 body）。② ftree 宿主 fork：新增 `POST /dsh-ftree-upload?dir&name&token`（50MB 上限、非法字符/重名处理）与 `GET /dsh-ftree-download?path`（attachment 下载）；全部 pathAllowed 检查对 admin 豁免（admin 仅持 API 访问权限）。③ ftree 客户端 fork：头部"上传"按钮 + 整列拖放上传 + 文件夹行拖放（外部文件=上传，内部行=拖拽复制）、行 draggable、右键菜单与预览列头部"下载"按钮、当前路径显示；5 秒自动刷新改自有 setInterval（内核无 timer 服务）。权限矩阵：admin=全盘 API 权限（界面不提供上级目录浏览，按用户要求移除"⬆"按钮，文件树停留在工作区）、user=仅映射工作区、guest=全部拒绝并提示升级。
- **2026-09-02 shell 依赖移除（P8.2）**: 文件树的剪切/粘贴/删除/重命名/新建全部改写为 node:fs 直接实现（renameSync/copyFileSync/cpSync/rmSync/mkdirSync/writeFileSync），不再依赖 PowerShell 的 `ctx.shell`（该运行时下 ftree 取不到此服务，操作曾统一报"需要 shell 服务"）。shell 仅在可用时作为增强：删除走系统回收站（不可用时退化为工作区内的 `.dsh-recycle` 可恢复文件夹，客户端已隐藏该目录并提示"已移入回收文件夹"）。"打开源文件夹"功能按用户要求**移除**（右键菜单项、双击打开、doOpen 均删除）。操作提示 toast 改为自有 setTimeout 自动消失（默认 2.6s；内核无 timer 服务导致提示常驻的问题一并修复）。docx 预览走 mammoth（已装），git 面板仍依赖 shell（未在本次修复范围）。
- **2026-09-02 xlsx 页内表格 + AI 原生文档写入（P8.3）**: ① 窗格 xlsx：宿主用 SheetJS 解析（工作簿按路径缓存），read 路由返回 {sheets/rows/merges/colWidths}；新增 `POST /dsh-ftree-xlsx-save`（编辑批量回写，被改单元格保留样式，空值删除单元格）；客户端新增 Excel 风格网格（A/B/C 列头、行号、冻结表头、绿色选中框、名称框+编辑栏、Enter 下移、双击内联编辑、底部工作表标签、保存按钮、300×40 渲染上限）。docx 预览改为 Word 纸张风（灰底白页+页边距+阴影）；旧版 .doc 明确提示另存为 .docx。② AI 原生写入器：给 dsh-doc 离线 Python 运行时引导 pip 并安装 openpyxl 3.1.5 + python-docx 1.2.0；fork 新增 `python/office_worker.py`（JSON-stdio，二进制缓冲+UTF-8，规避 Windows 管道编码）；宿主注册两个模型工具 `office_xlsx_write`（create/update，保样式）与 `office_docx_write`（create/append/replace），路径经 sandboxPolicy 收容（workspace-write 会话仅限工作区，danger-full-access 放行），defineTool 经 profile 镜像解析（fail-safe）。冒烟测试：create/update/replace 三模式全通过。
- **2026-09-03 HTTPS 反代下文件树写操作失效（P8.5）**: 用户经 `https://…:8443` 反代访问时，浏览器 POST 带 `Origin: https://<局域网IP>:8443`；ftree 宿主 `allowRequest` 原做"Origin 精确等于白名单"匹配（白名单只有 `http://` 条目，scheme 不符）→ 所有写操作（复制/剪切/删除/新建/上传/保存）被判 403；读操作是 GET、同源不带 Origin 所以正常。修复：`allowRequest` 改为**仅按 hostname 比对**（用 `authorityHostname` 解析 Origin，放行 127.0.0.1/localhost/::1 + 启动绑定主机 + `--trusted-host` 列表，忽略 scheme/端口差异）。
- **2026-09-03 文件树写入/上传第二、三处修复 + 文件夹上传（P8.6）**: ① 写操作曾报 `signal time out`——fork 的 `replayable` 请求包装只支持 `Symbol.asyncIterator`，`req.on('data')` 拿不到请求体；`readBody`/`readBodyBuf` 改为 `for await (const chunk of req)`。② 上传到尚不存在的子目录失败——upload handler 改 `mkdirSync(base, { recursive: true })`。③ **文件夹上传**：客户端新增"传文件夹"按钮 + 整目录拖放，走 `webkitRelativePath` / `webkitGetAsEntry` 递归读目录（`readAllEntries`/`walkDroppedEntry`/`droppedEntries`/`handleDrop`），逐文件 POST 到 `/dsh-ftree-upload`。

- **2026-09-02 工作区菜单"新建文件夹"崩溃修复（P8.4）**: 该按钮由 ftree 客户端 `enhanceWorkspaceMenu()`（对话归档功能残留）注入官方工作区右键菜单——向 React 管理的菜单手工克隆插入"新建文件夹"行，点击后与 React 渲染冲突导致页面/服务崩溃。已把 `createArchiveFolderFromMenu` / `enhanceWorkspaceMenu` / `renderArchiveFolders` 三个注入函数整体置为 no-op（MutationObserver 与定时器的调用点保留，注入与 DOM 手术全部停用）；文件树自己的右键"新建文件夹"（node 实现）不受影响。

### P9：本机桥接 local_run（✅ 已实施：2026-09-02，待重启验证）

**需求:** 服务器部署、用户经网络使用 agent，让 agent 调用用户本机软件——打开/编辑本机 Office/PDF、跑本机 PowerShell、执行任意本地脚本（PS / Blender 等软件自动化）。平台先 Windows，接受用户端安装 sidecar。

**架构（方案 A：本机 sidecar + 出站 WebSocket）:**
- 每台用户机器跑 `sidecar/sidecar.mjs`（Node 常驻），**出站**连服务器 `/sidecar`（带每账号 token），收到 run 命令在本机 spawn 执行，回传 stdout/stderr/exitCode + 回传文件（base64）。
- 服务器宿主插件 `dsh-local-bridge`：`/sidecar` WebSocket 端点（token→账号 认证，`ws` 库）+ 模型工具 `local_run`（按"会话归属账号"路由到对应 sidecar；归属来自 `~/.dsh/auth/session-owners.json`，无归属按 admin）。
- 文件往返：`inputFiles`（base64）先写入本机临时 workdir 再执行，`collect`（相对 glob）回传输出文件；工作区仍是文件交换面。
- 协议：`exe==='pwsh'` 特指 PowerShell（args[0]=整段脚本）；上限 stdout/stderr 各 1MB、单文件 50MB、超时默认 120s（可到 900s）。

**Files:**
- Create: `~/.dsh/plugins/dsh-local-bridge/`（package.json + cordis.patch.yml + lib/index.js + sidecar/sidecar.mjs + README.md + AGENTS.md + sidecar/README.md）
- Modify: `~/.dsh/plugins/dsh-remote-local/lib/index.js`（wrapUpgrade 对 `/sidecar` 豁免会话 cookie 门禁——sidecar 无浏览器 cookie，用自身 token 认证）
- Modify: `~/.dsh/profiles/web/cordis.patch.yml`（local-bridge 行 tokens：admin / Finance-mgr / Finance-staff 三个随机 token）
- Modify: `~/.dsh/.agent-presets/{finance-manager,finance-staff}/agent.cordis.yml`（persona 增第 6 条：本机能力 + 副作用前先确认）

**安全模型（MVP）:** token 绑定账号、会话归属路由隔离、agent 工具描述+AGENTS.md 要求副作用前确认、命令与结果写日志。已知边界：无 exe 白名单、无逐动作审批（财务会话 approval=never 冲突未接入审批链），等价于用户本机自己敲命令，仅限可信用户。

**验收（待重启）:** admin 本机跑 sidecar（token=admin）→ agent `local_run` 跑 `pwsh -c "echo hi"` 返回 hi；把 finance-ws 的 xlsx 作 inputFiles 下发本机 → PowerShell 改 → collect 回传 → 写回工作区；Finance 账号未连 sidecar 时返回"本地助手未连接"。

**Files:**
- Create: `~/.dsh/runtimes/dshdoc-runtime-win32-x64/`（OCR 运行时，hash 校验离线产物：CPython 3.11.9 + xberg 1.0.14 + 中英 tessdata）
- Modify: `~/.dsh/profiles/web/cordis.patch.yml`（dsh-doc 行：engine python + runtimeDir + defaultOcr + maxOutputChars）
- Modify: `~/.dsh/profiles/web/package.json`（bundles + deps：dsh-doc@0.1.1、folder-tree-sh@github）
- Modify: `~/.dsh/plugins/dsh-remote-local/lib/index.js`（**/dsh-ftree-* 门禁**：该插件白名单默认含全部注册工作区，会泄露 admin 仓库；fork 对非 admin 校验每个 path/srcPath/destDir/target 必须 realpath 收容于映射工作区（finance-ws），POST 体读取后经 replayable 直接重放给窗格 handler）

**验收（待重启）:**
- Finance-mgr 窗格：只见 finance-ws 文件树；PDF/DOCX/CSV/MD 可预览；MD 可内联编辑保存；试图 list/read 其他工作区 → 403。
- AI 读 `finance-ws` 下的报销单.xlsx / 发票扫描件.pdf → dshdoc_extract 正常解析（扫描件走 OCR）。
- admin 窗格全量工作区 + AI 解析不受限。

---

## 4. 风险与开放问题

| 风险/问题 | 影响 | 缓解 |
|---|---|---|
| 网关插件与 0.1.2-alpha.3 不兼容 | P0 阻塞 | 双候选实测；必要时自研薄网关（~1 个 host 插件） |
| 提示词约束被绕过（软约束） | 行为越权 | 双层设计：权限预设 + 沙箱兜底；高风险工具从 finance 预设裁剪 |
| 同工作空间文件互改 | 数据完整性 | 默认不隔离（同部门共享）；如需隔离，P3 决策点：OS 目录 ACL 或会话级 fs 白名单（额外开发） |
| 社区插件版本漂移 | 升级破坏 | 锁定版本；P0 记录版本对应表 |
| 局域网未加密 | 凭据泄露 | P1 Step 4 强制 caddy TLS（计划内） |

## 5. 附录

**A. P0 选型记录（2026-09-01 完成）**

| 维度 | `@xgone/dsh-remote` v0.3.0（✅ 首选） | `slywalker2006/dsh-passwords` v2.6.7（备选） |
|---|---|---|
| 形态 | cordis 双半区插件 + bundle patch，`dsh plugin add` 一行安装 | 独立网关进程（DB/.env/Docker/证书） |
| 认证 | scrypt + HMAC Cookie + MFA(TOTP RFC6238) + 限速 + loopback-only 引导 | 加密认证 + 子用户 + 配额 + 审计日志 |
| 角色 | 固定三档 admin/user/guest（方法级门禁；未知角色回落 user） | 子用户模型 + 资源过滤（workspace/session/control） |
| 版本兼容 | 活跃维护，本部署已 fork 本地化（~/.dsh/plugins/dsh-remote-local） | 兼容矩阵声明支持 0.1.2-alpha.1~alpha.3 |
| 多租户 | 明示"每用户独立工作区/会话插件层做不了"——本部署用 fork 补齐（会话归属门禁 + 列表过滤） | 子用户资源过滤部分 code-level 兼容 |
| 逃生 | `enabled: false` 重启即恢复；删除 `$DSH_HOME/auth/store.json` 重引导 | `dsh-passwords uninstall` |

**B. 管理员操作手册（2026-09-02 完成）**

1. **账号/角色维护**：admin 登录 → 设置 → 登录与账号：添加账号（角色 admin/user/guest）、重置密码、禁用 MFA（需管理员密码）。
2. **角色映射配置**：`~/.dsh/profiles/web/cordis.patch.yml` 的 `remote` 行 `roleMap`（账号名精确区分大小写 → preset + workspace 标题）；改后重启生效。
3. **工作空间分配**：admin 登录 → 工作区管理：新建（目录选择）、重命名、删除、归档会话；新建 `finance-ws` 后成员账号的新会话自动落在其中。
4. **会话迁移**：工作区管理的拖拽/归档操作（insertSessionBefore / archiveSession 为官方 Remote，admin 专属）。
5. **fork 维护**：`~/.dsh/plugins/dsh-remote-local/`（认证+角色注入+会话门禁的本地 fork），更新上游后需人工合入；测试 `node --test <dir>/test/role-gate.test.js`。
6. **逃生**：`enabled: false` 重启即关闭门禁；删除 `$DSH_HOME/auth/store.json` 重新引导首管理员。
7. **权限收紧（P5.1）**：所有 roleMap 映射账号的会话被服务端钉为 `finance-confined`（workspace-write + never）——写边界为账号工作区文件夹（finance-ws = `C:\Users\<用户名>\Desktop\finance-ws`），禁止升级，且 finance 预设无 shell/子代理/工作流/web 工具。新账号必须先加 roleMap 才能用（未映射账号的 `session.*` 全部拒绝）。如需给某账号更多权限：改 roleMap 指向其他预设，或在 fork 的 `confinedPresets` 白名单外放行。

**C. 验收实测结果（截至 2026-09-02，最终模型）**

| 验收项 | 结果 |
|---|---|
| P1 登录门禁（admin/MFA/多账号） | ✅ 三账号登录正常；admin MFA 已绑定 |
| P2 角色预设挂载 | ✅ finance-manager / finance-staff standingKeyFor mounted OK |
| P3 预设锁定 | ✅ 新对话锁定各自预设（select 注入） |
| P3 工作空间落位 | ✅ 新会话落 finance-ws（create 注入） |
| P3 共享技能集 | ✅ `~/.dsh/.agent-presets/{finance-manager,finance-staff}/skills/finance/SKILL.md`（报销审核/凭证规范） |
| P4 会话按账号隔离（最终模型） | ✅ 用户确认：两财务账号仅见 finance-ws 且**各自对话互不可见**；发言即认领、跨登录保留；admin 全见 |
| P4 隔离修复（2026-09-03） | ✅ 定位：过滤本身正常；根因是 `session-49e662a1`（deepseek-harness 会话）在早期测试中被 Finance-mgr **越工作区认领**。已清数据 + 门禁硬化（mapped 用户只能操作/认领自己映射工作区内的会话，越界返回 "session outside your workspace"）+ /auth/me allowed 隐藏工作区行；待重启验证。 |
| P4 越权拒绝 | ✅ 他人会话 prompt/page 等被拒（session belongs to another account） |
| P5 角色门 | ✅ admin 全权限；非 admin 被拒 settings/credentials/agentPreset/workspace 写面 |
| P5.1 操作权限收紧 | ⏳ 已实施（预设瘦身 + workspace-write/never 钉住 + commands.execute 拒绝），待重启验证 |
| UI 角色化隐藏 | ✅ 预设选择/添加工作区/选择工作区组件隐藏；侧栏工作区树按 /auth/me.workspaces 隐藏非映射工作区（fork 客户端） |
| P6 Token 统计 | ⏳ dsh-usage-panel 已本地 fork 修复（scan 模式）+ `/usage-stats` 硬门（非 admin 403），待重启验证 |
| P8 办公文档 | ⏳ 已安装 dsh-doc（AI 解析+OCR）+ folder-tree-sh（页内窗格，非 admin 限定 finance-ws），待重启验证 |
| 账号管理界面（2026-09-03） | ⏳ 账号卡片可编辑 + 工作区多选下拉 + 预设选择，写入 auth/role-map.json，待重启验证 |
| 隐藏工作区/会话（2026-09-03） | ⏳ admin 专属"隐藏/取消隐藏"，hidden-items.json + /auth/me 过滤，待重启验证 |
| 文件树文件夹上传（2026-09-03） | ⏳ "传文件夹"按钮 + 目录拖放，配合 Origin/for-await/mkdir 三处修复，待重启验证 |
| usage-panel 卡死修复（2026-09-03） | ⏳ scanFallback 改原始 sessionPersistence 读取（node --check 通过），待重启验证 |
| 6 个扩展角色预设（2026-09-03） | ⏳ 8 个角色预设全部落地，待重启验证 |
| MIGRATION.md（2026-09-03） | ✅ 已创建整部署迁移指南 |
| P7 端到端 | ✅ 多轮实测覆盖三账号关键路径 |

**C2. 实施修正记录（关键决策变更）**

1. **工作空间强锁已移除**：最终模型是**纯账号归属**（create/使用即认领，列表按归属过滤），不再拒绝跨工作空间对话——工作空间仅作为新会话的默认落点。
2. **可见性过滤实现层**：放弃网关响应改写（传输层拒绝），改为官方 `session.list` 的 `scopeUser` + `sessionOwnership` 服务（见 Agent Note [2026-09-02-session-visibility-scope](C:\Users\<用户名>\Desktop\deepseek-harness\.agents\notes\implemented\feature\2026-09-02-session-visibility-scope.md)）。
3. **运行方式**：官方宿主包经 tsx 源码启动（无需编译，本会话已证实）；如改用构建产物启动则需 `pnpm --filter @deepseek-ai/dsh-api-session-controller bundle`。
4. **P5.1 权限收紧（2026-09-02）**：Finance-mgr 会话曾成功重启服务器 → 三层封堵：预设瘦身（无 shell/subagent/workflow/web 工具）、会话级钉住（`workspace-write` + approval `never`，写根 = 工作区文件夹，升级被确定性拒绝）、API 面拒绝（`commands.execute` 全拒 + 未映射账号 `session.*` fail-closed）。admin 不受影响。
5. **P8 办公文档（2026-09-02）**：无页内原生 Word/Excel 所见即所得编辑方案 → 采用 dsh-doc（AI 解析，工作区限定）+ folder-tree-sh（页内窗格）；后者白名单默认含全部工作区，fork 对非 admin 增加 per-user 收容门禁（仅 finance-ws）。
6. **usage-panel 首启崩溃（2026-09-02）**：npm 原版按 rc.6 的 `coldSnapshot(sessionId)` 编写，0.1.2 改为 `coldSnapshot(meta, events)` → 全会话抛 `undefined.at` 并把进程带崩。教训：社区插件装完必须在重启后立刻验证，审计 README 不能替代运行时验证。已本地 fork 强制 scan 模式（sessionQuery API 两版本形状一致）。
7. **账号管理界面（2026-09-03）**：设置页新增账号卡片（可编辑），支持为每账号多选工作区 + 选预设；保存写入 `~/.dsh/auth/role-map.json`（`dynamicRoleMap`/`saveRoleMap`/`effectiveRoleMap`，`{ preset, workspaces[] }` 叠加在静态 roleMap 之上），删除账号即移除映射。配置项经 `/auth/config-options` 下发（工作区列表 + 预设列表）；工作区多选用自定义勾选下拉（点击展开、✓ 切换、确认收起，弃用原生 `<select multiple>`）。
8. **隐藏工作区/会话（admin 专属，2026-09-03）**：`/auth/hide` 写入 `~/.dsh/auth/hidden-items.json`（`{workspaces[], sessions[]}`）；会话标题经 `sessionController.list({}, undefined)` + `projections.values.title` 反查（冷会话也覆盖，`listSessionSummaries`）；客户端在"…"菜单注入 隐藏/取消隐藏（admin-only，MutationObserver 挂到 `[role="menu"]`，toast 反馈）；非 admin 侧栏工作区树按 `/auth/me.hiddenWorkspaceTitles` 过滤。
9. **usage-panel 统计卡死（2026-09-03）**：`readSession()` 会 `Session.create` 重放超大会话日志（admin 22.9MB/5 文件，耗时数分钟）→ `scanFallback` 改为经 `sessionPersistence.open(header.id, "read").read(0, undefined)` 原始读取，强制 `mode="scan"`。
10. **6 个扩展角色预设（2026-09-03）**：`art-design`/`business-sales`/`procurement`/`production`/`hr-management`/`rd-development`，各含 persona + 受限工具组合 + `skills/<domain>/SKILL.md`（design/sales/procurement/production/hr/rd）。
11. **迁移指南（2026-09-03）**：新增 `~/.dsh/MIGRATION.md`（190 行），覆盖架构总览、数据/配置/插件/运行时迁移清单、路径假设（用户名 `<用户名>`、绝对路径已烘焙）与恢复验证。
12. **git pull 评估（2026-09-03，未执行）**：本地 checkout 落后 origin/master 404 提交，上游已重写 `packages/api/session-controller`（破坏性，与本地 `scopeUser`/`sessionOwnership` 定制冲突）→ 评估结论：**不 pull**，核心仓库保持只读，继续在本地 fork 维护，避免破坏运行中的部署。

**D. 部署状态文件**：`~/.dsh/upgrade-state.json`（接力检查点）、`~/.dsh/plugins/dsh-remote-local/run-diag.log`（注入/拒绝操作日志，非高频）。
**E. 参考**：dsh-remote（GitHub/npm `@xgone/dsh-remote`）、官方 packages/workspace、packages/preset/agent-presets、persona 配置（`packages/preset/persona/src/index.ts`）。

---

**F. 全量改动记录（CHANGELOG，截至 2026-09-03）**

> 本部署全部定制集中在本地 fork 与 `~/.dsh/` 数据目录，**核心 checkout（`C:\Users\<用户名>\Desktop\deepseek-harness`）保持只读**（仅 session-controller 的 `scopeUser`/`sessionOwnership` 为源码级本地修改）。git pull 已评估为冲突风险（404 提交落后 + 上游重写 session-controller），暂不执行。标记 ⏳ 的项已实施、待整进程重启后验收。

### F1 认证与角色门禁（`~/.dsh/plugins/dsh-remote-local`，fork 自 `@xgone/dsh-remote`）
- 多账号登录（scrypt + HMAC Cookie + TOTP），固定三档 admin/user/guest 方法级门禁。
- 静态 `roleMap`（`profiles/web/cordis.patch.yml`）：`Finance-mgr → finance-manager + finance-ws`、`Finance-staff → finance-staff + finance-ws`。
- 会话归属：`sessionOwnership` 服务 + `~/.dsh/auth/session-owners.json`（发言即认领、跨登录保留）；越权会话被拒（"session belongs to another account"）。
- 隔离硬化：mapped 用户只能操作/认领自己映射工作区内的会话（越界 "session outside your workspace"）。
- 动态角色映射：`~/.dsh/auth/role-map.json`（`dynamicRoleMap`/`saveRoleMap`/`effectiveRoleMap`，`{ preset, workspaces[] }` 多工作区），叠加在静态 roleMap 之上；`/auth/config-options` 下发工作区+预设列表；`/auth/accounts` upsert/remove/list 维护账号映射。
- 隐藏：`/auth/hide` → `~/.dsh/auth/hidden-items.json`（workspaces/sessions）；`/auth/me` 返回 hiddenWorkspaceTitles / hiddenSessionTitles（含冷会话）。
- 收容（P5.1）：`commands.execute` 全拒 + 未映射账号 `session.*` fail-closed + 会话钉住 `finance-confined`（workspace-write + never）。

### F2 会话可见性（`packages/api/session-controller` 本地修改）
- `SessionOwnershipReader.isVisible(user, sessionId, cwd)`、`SessionListRequest.scopeUser`、`list()` 按 `ownership.isVisible` 过滤。
- 上游已重写该包（破坏性）；本改动仅在本机 tsx 源码运行，无需编译。

### F3 文件树 / 办公文档（`~/.dsh/plugins/folder-tree-sh-local`，fork 自 `folder-tree-sh`）
- `exports.inject = ["slots"]` 修复窗格不显示；分列布局重写（侧栏/文件树/对话/预览/详情）；内核无 timer → 自有 setInterval + MutationObserver 兜底。
- 上传/下载/拖拽复制；shell 依赖移除（改 node:fs 实现剪切/粘贴/删除/重命名/新建，删除退化为 `.dsh-recycle`）；移除"打开源文件夹"；toast 自动消失。
- xlsx 页内网格（SheetJS 解析 + 编辑回写）+ Word 纸张风 docx 预览；AI 原生写入器 `office_xlsx_write`/`office_docx_write`（openpyxl 3.1.5 + python-docx 1.2.0）。
- 工作区菜单"新建文件夹"崩溃修复（三处注入函数置 no-op）。
- **Origin 修复**：`allowRequest` 改仅 hostname 比对（回环 + 绑定主机 + trustedHosts，忽略 scheme/端口）。
- **请求体修复**：`readBody`/`readBodyBuf` 改 `for await`（`replayable` 仅支持 asyncIterator）。
- **上传修复**：`mkdirSync(base, { recursive: true })`。
- **文件夹上传**："传文件夹"按钮 + 目录拖放（webkitRelativePath / webkitGetAsEntry 递归）。
- 权限矩阵：admin=全量 API、user=映射工作区、guest=403"需要升级权限才能使用该功能"。

### F4 使用统计（`~/.dsh/plugins/dsh-usage-panel-local`，fork 自 `dsh-usage-panel`）
- 强制 scan 模式（避开 `coldSnapshot(meta, events)` 版本漂移）；`link:` 依赖需在 fork 内单独 `pnpm install`。
- **卡死修复**：`scanFallback` 改经 `sessionPersistence.open(header.id, "read").read(0, undefined)` 原始读取，避免 `Session.create` 重放大日志。
- `/usage-stats` 数据通道非 admin 一律 403（双层管理员专属）。

### F5 角色预设（`~/.dsh/.agent-presets/<id>/`）
- 财务：`finance-manager`（审批/复核）、`finance-staff`（制单/录入），共享 `skills/finance/SKILL.md`。
- 扩展 6 个：`art-design`(design)、`business-sales`(sales)、`procurement`(procurement)、`production`(production)、`hr-management`(hr)、`rd-development`(rd)。
- 默认：`standard-terminal`。
- 8 个角色预设均为受限组合（persona + tool-fs/tool-fs-search/skill-filesystem/tool-skill/compaction-group/tool-ask-user/tool-todo，无 shell/web/subagent/workflow）；`rd-development` 未来可按需加 shell/web。

### F6 本机桥接（`~/.dsh/plugins/dsh-local-bridge`）
- 每用户 sidecar（出站 WebSocket 连 `/sidecar`，token 绑定账号）+ 模型工具 `local_run`（按会话归属路由）；文件往返 inputFiles/collect；附 README.md + AGENTS.md。

### F7 文档与迁移
- `~/.dsh/MIGRATION.md`：整部署迁移指南（数据/配置/插件/运行时清单 + 路径假设）。
- `~/.dsh/README.md`：局域网部署说明（caddy 反代、启动、证书、功能清单 + CHANGELOG）。
- `plan.md`（本文件）：实施计划 + 附录 A–F。

### F8 部署与安全
- caddy HTTPS 反代 `https://<LAN-IP>:8443 → 127.0.0.1:3080`（`tls internal` 自签）；dsh 只监听 loopback，`--trusted-host <LAN-IP>` 放行。
- `remote.trustProxy: false`（保留原始 Host 以匹配 cookie）；`permission.finance-confined`（workspace-write + never）；local-bridge per-account tokens（私密）。

### 运维要点
- **host 改动需整进程重启**（插件 `lib/index.js`、cordis.patch.yml）；**客户端 `lib/client.js` 改动经 HMR 自动重发**，浏览器 Ctrl+F5 生效。
- 启动命令：`pnpm dsh --profile web --trusted-host <局域网IP>`（于 checkout 根目录）。
- 状态文件：`~/.dsh/auth/{store,session-owners,hidden-items,role-map}.json`、`~/.dsh/upgrade-state.json`、`~/.dsh/plugins/dsh-remote-local/run-diag.log`。
