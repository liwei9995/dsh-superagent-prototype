import { describe, expect, it } from 'vitest'
import { agentPull, ticketBranch, type Pull } from '../src/sources/cnb-pull.ts'
import { cnbAddress, cnbPage, cnbThreadId, commentTrigger, issueTrigger, mentions, pullTrigger } from '../src/sources/cnb-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'

describe('cnb triggers', () => {
  it('maps issue and pull numbers into separate thread ids', () => {
    expect(cnbThreadId('issues', 12)).toBe('issues/12')
    expect(cnbThreadId('pulls', '12')).toBe('pulls/12')
    expect(cnbPage('acme/widgets', 'pulls', 3)).toBe('https://cnb.cool/acme/widgets/-/pulls/3')
  })
  it('parses CNB page URLs and detects mentions', () => {
    expect(cnbAddress('https://cnb.cool/acme/widgets/-/issues/9', 'acme/widgets')).toEqual({ kind: 'issues', number: 9 })
    expect(cnbAddress('https://cnb.cool/acme/widgets/-/pulls/2#comment-abc', 'acme/widgets'))
      .toEqual({ kind: 'pulls', number: 2, comment: 'abc' })
    expect(cnbAddress('https://cnb.cool/other/repo/-/issues/1', 'acme/widgets')).toBeUndefined()
    expect(mentions('please @agent-bot fix this', 'agent-bot')).toBe(true)
    expect(mentions('agent-bot without at', 'agent-bot')).toBe(false)
  })
  it('builds triggers with stable ids and mention strength', () => {
    const issue = issueTrigger({
      number: '4', title: 'Bug', state: 'open', body: 'hey @agent-bot', author: { username: 'alice' },
      created_at: '2026-01-01T00:00:00Z',
    }, 'agent-bot', 'acme/widgets')
    expect(issue.threads[0]).toEqual({ source: 'cnb', id: 'issues/4' })
    expect(issue.addressed).toBe('mention')
    const pull = pullTrigger({
      number: 8, title: 'Feat', state: 'open', body: 'no mention', author: { username: 'bob' },
      created_at: '2026-01-02T00:00:00Z',
    }, 'agent-bot', 'acme/widgets')
    expect(pull.meta).toMatchObject({ kind: 'pulls', number: 8, isPr: true, prAuthor: 'bob' })
    const comment = commentTrigger({
      id: 'c1', body: 'looks good', author: { username: 'carol' }, created_at: '2026-01-03T00:00:00Z',
    }, { kind: 'pulls', number: 8, url: cnbPage('acme/widgets', 'pulls', 8) }, 'conversation', 'agent-bot')
    expect(comment.meta).toMatchObject({ kind: 'pulls', number: 8, commentId: 'c1', commentKind: 'conversation' })
    expect(comment.channel!.address).toMatchObject({ kind: 'pulls', number: '8' })
    expect(comment.channel!.address).not.toHaveProperty('reviewId')
  })
  it('puts reviewId on the channel so Outbox can reply in a review thread', () => {
    const inline = commentTrigger({
      id: 'c9', body: 'nit', author: { username: 'carol' }, created_at: '2026-01-03T00:00:00Z',
      review_id: 55, path: 'a.ts', end_line: 3,
    }, { kind: 'pulls', number: 8, url: cnbPage('acme/widgets', 'pulls', 8) }, 'inline', 'agent-bot')
    expect(inline.channel!.address).toMatchObject({ kind: 'pulls', number: '8', commentId: 'c9', reviewId: '55' })
    expect(inline.meta).toMatchObject({ commentKind: 'inline', reviewId: '55', path: 'a.ts', line: 3 })
  })
  it('recognizes agent PRs on the ticket branch and rejects forks', () => {
    const ticket = { execution: { name: 'fix-margin', directory: '/w', assignment: '' } }
    expect(ticketBranch(ticket, 'refs/heads/agent/fix-margin')).toBe(true)
    expect(ticketBranch(ticket, 'refs/heads/other')).toBe(false)
    const deployment = testDeployment({ forge: 'cnb', github: undefined, cnb: { cli: '/bin/false', login: 'agent-bot', noreply: 'a@noreply.cnb.cool' } })
    const pr = {
      number: 1, title: 'x', state: 'open', html_url: cnbPage('acme/widgets', 'pulls', 1),
      author: { username: 'agent-bot' },
      head: { sha: 'abc', ref: 'refs/heads/agent/fix-margin', repo: { path: 'acme/widgets' } },
    } satisfies Pull
    expect(agentPull(pr, deployment)).toBe(true)
    expect(agentPull({ ...pr, head: { ...pr.head, repo: { path: 'other/fork' } } }, deployment)).toBe(false)
    expect(agentPull({ ...pr, author: { username: 'alice' } }, deployment)).toBe(false)
    // Missing head.repo must not fall open to the deployment repository (forks omit it).
    expect(agentPull({ ...pr, head: { ...pr.head, repo: null } }, deployment)).toBe(false)
    expect(agentPull({ ...pr, head: { sha: 'abc', ref: 'refs/heads/agent/fix-margin' } }, deployment)).toBe(false)
  })
})
