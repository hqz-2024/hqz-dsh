# Agent Note: Deployment-scoped session visibility

Status: implemented

[English](2026-09-02-session-visibility-scope.md) | 中文

## Problem

自行接入认证网关（如 dsh-remote fork）的部署需要按账号隔离会话可见性：每个账号只看到自己的对话，管理员全见。官方 `session.list` Remote 返回全部会话；网关无法安全过滤响应（Web 传输层会拒绝被改写的响应），而请求 schema 也没有过滤字段。

## Decision

`SessionListRequest` 新增可选字段 `scopeUser`。认证网关把账号名盖章进 `session.list` 请求（请求改写，传输层处理干净）。`SessionController.list()` 解析可选的 `sessionOwnership` Context 服务：字段与服务都存在时，用 `SessionOwnershipReader.isVisible(user, sessionId, cwd)` 过滤返回项；缺任一者则不过滤——标准部署与管理员行为不变。

归属策略由提供服务的网关实现：本部署的 fork 维护 `session-owners.json` 映射，首次使用（prompt/rename/attachment）即认领会话，`isVisible` 按该映射作答。会话操作门禁（拒绝他人会话）留在网关请求层。

改动由 `tests/session-list-scope.host.spec.ts` 覆盖（有服务则过滤 / 无服务不滤 / 无 scopeUser 不滤）。

## Alternatives considered

**网关层响应改写。** 否决：Web 传输层拒绝被改写的响应（客户端以同一 rpcId 反复重发直至放弃），已在运行部署上实证。

**按工作空间标题过滤。** 否决：未归属的遗留会话与跨工作空间对话无法据此归属，且工作空间强锁破坏了合法的跨工作空间对话。

**归属写入 Session 记录本身。** 否决：触及会话格式与全部读取方；网关级策略用认证库旁的部署级映射即可。

## Consequences

- 官方线上类型新增一个可选字段；字段缺失时标准行为不变。
- 账号隔离依赖网关盖章 `scopeUser` 并提供 `sessionOwnership`，缺任一则能力失效（惰性）。
- 认领机制上线前创建的未归属会话对非 admin 账号不可见，对管理员仍可见。
- `search` 本次未做范围过滤，留作后续。
