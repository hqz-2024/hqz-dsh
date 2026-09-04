/**
 * Deployment-scoped `session.list`: an optional `scopeUser` on the request
 * (stamped by an authenticating gateway such as the dsh-remote fork) filters
 * the response through the optional `sessionOwnership` Context service.
 * Without the service the field is inert and the list stays unfiltered.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionOwnershipReader } from '../src/types.ts'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'

async function harness(): Promise<{ ctx: Context; remote: TestSessionRemote }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return {
    ctx,
    remote: createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd: '/tmp',
    }),
  }
}

function listIds(remote: TestSessionRemote, request: { scopeUser?: string }): Promise<string[] | undefined> {
  return remote.list(request as never).then(result => (result.ok ? result.value.items.map(item => item.sessionId) : undefined))
}

describe('session.list deployment scope', () => {
  it('filters through the optional sessionOwnership service when scopeUser is set', async () => {
    const { ctx, remote } = await harness()
    const alice = ctx.sessions.create()
    const bob = ctx.sessions.create()
    ctx.agents.register({ id: alice.id, session: alice, status: 'idle', ctx } as Agent)
    ctx.agents.register({ id: bob.id, session: bob, status: 'idle', ctx } as Agent)
    const ownership: SessionOwnershipReader = {
      isVisible: (user, sessionId) => (user === 'alice' ? sessionId === alice.id : sessionId === bob.id),
    }
    ctx.provide('sessionOwnership', ownership)

    const aliceIds = await listIds(remote, { scopeUser: 'alice' })
    expect(aliceIds).toContain(alice.id)
    expect(aliceIds).not.toContain(bob.id)
    const bobIds = await listIds(remote, { scopeUser: 'bob' })
    expect(bobIds).toContain(bob.id)
    expect(bobIds).not.toContain(alice.id)
  })

  it('scopeUser without the ownership service leaves the list unfiltered', async () => {
    const { ctx, remote } = await harness()
    const session = ctx.sessions.create()
    ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    const ids = await listIds(remote, { scopeUser: 'anyone' })
    expect(ids).toContain(session.id)
  })

  it('no scopeUser is never filtered', async () => {
    const { ctx, remote } = await harness()
    const session = ctx.sessions.create()
    ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    const ownership: SessionOwnershipReader = { isVisible: () => false }
    ctx.provide('sessionOwnership', ownership)
    const ids = await listIds(remote, {})
    expect(ids).toContain(session.id)
  })
})
