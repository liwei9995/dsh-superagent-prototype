import { describe, expect, it, vi } from 'vitest'
import { CliError } from '../src/infra/commands.ts'
import { pollThreads } from '../src/sources/cnb.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { testDeployment } from './fixtures/deployment.ts'

const cnbDeployment = testDeployment({
  forge: 'cnb', github: undefined, cnb: { cli: '/bin/false', login: 'agent-bot', noreply: 'a@noreply.cnb.cool' },
})

/** Minimal context that drives `pollThreads` over one subscribed Issue. */
function pollHost(cnb: (schema: unknown, module: string, tool: string) => Promise<unknown>): {
  ctx: SourceContext
  round: { started: string; pulls: Map<number, unknown>; read: Set<string>; failures: string[]; tally: { skipped: number } }
  pollError: string | undefined
} {
  const thread = {
    key: 'cnb:issues/5', ref: { source: 'cnb' as const, id: 'issues/5' }, createdAt: new Date().toISOString(),
    subscriptions: ['ticket'], correlated: [] as string[], pending: [] as string[], meta: {} as Record<string, unknown>,
  }
  let pollError: string | undefined
  const commands = {
    withSignal: () => ({
      cnb: async (schema: unknown, module: string, tool: string) => cnb(schema, module, tool),
      cnbPages: async () => [],
    }),
  }
  const ctx = {
    deployment: cnbDeployment,
    commands,
    ready: Promise.resolve(),
    configured: () => true,
    config: () => ({
      repository: 'acme/widgets', pollSeconds: 60, failuresBeforeError: 3,
      observeIssues: false, observePulls: false, observeComments: false, observeCi: false,
    }),
    receive: vi.fn(),
    atomic: <T>(work: () => T) => work(),
    state: { get: () => undefined, set: () => {}, keys: () => [] },
    threads: {
      get: () => thread,
      subscribed: () => [thread],
      describe: () => {},
      patch: (_key: string, meta: Record<string, unknown>) => {
        if ('pollError' in meta) pollError = meta.pollError as string | undefined
        Object.assign(thread.meta, meta)
      },
    },
    tickets: { get: () => undefined, open: () => [], bindThread: () => {}, threadClosed: () => {} },
    triggers: { get: () => undefined, latest: () => undefined },
    notify: () => {},
    report: () => {},
  } as unknown as SourceContext
  const round = { started: new Date().toISOString(), pulls: new Map(), read: new Set<string>(), failures: [] as string[], tally: { skipped: 0 } }
  return { ctx, round, get pollError() { return pollError } }
}

describe('CNB pollThreads', () => {
  it('counts a subscribed-thread 404 toward round failures, and drops only 410', async () => {
    const missing = pollHost(async () => { throw new CliError('CNB HTTP 404', 404) })
    await pollThreads(missing.ctx, undefined, missing.round)
    expect(missing.round.failures.some(item => item.includes('cnb:issues/5') && item.includes('404'))).toBe(true)
    expect(missing.pollError).toContain('404')

    const gone = pollHost(async () => { throw new CliError('CNB HTTP 410', 410) })
    await pollThreads(gone.ctx, undefined, gone.round)
    expect(gone.round.failures).toEqual([])
    expect(gone.pollError).toContain('410')
  })
})
