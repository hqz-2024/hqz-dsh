# Agent Note: Deployment-scoped session visibility

Status: implemented

English | [中文](2026-09-02-session-visibility-scope.zh.md)

## Problem

A deployment that adds its own authentication gateway (e.g. the dsh-remote fork) needs per-account Session visibility: each account sees only its own conversations, administrators see everything. The official `session.list` Remote returns every Session, and a gateway cannot filter the response safely — the web transport rejects rewritten responses, and the request schema has no filter field.

## Decision

`SessionListRequest` gains an optional `scopeUser` field. The authenticated gateway stamps the account name into the `session.list` request (request rewriting, which the transport handles cleanly). `SessionController.list()` resolves the optional `sessionOwnership` Context service and, when both the field and the service exist, filters the returned items through `SessionOwnershipReader.isVisible(user, sessionId, cwd)`. Absent either, the list stays unfiltered, so stock deployments and administrators are unaffected.

The ownership policy itself lives with the providing gateway: the deployment's fork keeps a `session-owners.json` map, claims sessions on first use (prompt/rename/attachment), and answers `isVisible` from that map. Session operation gating (deny others' sessions) stays in the gateway's request layer.

The change is covered by `tests/session-list-scope.host.spec.ts` (filtered with service, unfiltered without service, unfiltered without scopeUser).

## Alternatives considered

**Response rewriting in the gateway.** Rejected: the web transport rejects rewritten responses (the client re-issues the same rpcId until it gives up), verified against the running deployment.

**Workspace-title filtering in the gateway.** Rejected: unowned legacy sessions and cross-workspace conversations cannot be attributed that way, and a workspace filter broke legitimate cross-workspace chatting.

**Ownership stored on the Session record itself.** Rejected: would touch the session format and every reader; a deployment-side map beside the auth store is sufficient for a gateway-provided policy.

## Consequences

- The official wire type gains one optional field; stock behavior is unchanged when it is absent.
- Per-account isolation depends on the gateway stamping `scopeUser` and providing `sessionOwnership`; without them the feature is inert.
- Unowned sessions (created before claims existed) are invisible to non-admin accounts; they remain visible to administrators.
- Session `search` is not scoped in this change; scope search filtering remains a follow-up.
