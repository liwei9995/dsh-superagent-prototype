/** CNB pull-request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { cnbPage, cnbThreadId, SOURCE, UserSchema } from './cnb-trigger.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), body: z.string().nullish(),
  author: UserSchema, created_at: z.string().optional(), updated_at: z.string().optional(),
  is_merged: z.boolean().optional(), mergeable_state: z.string().optional(),
  closed_at: z.string().nullish(), merged_at: z.string().nullish(),
  head: z.looseObject({
    sha: z.string(), ref: z.string(),
    repo: z.looseObject({ path: z.string() }).nullish(),
  }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number; html_url: string }
export const readPull = async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull> => {
  const raw = await ctx.commands.withSignal(signal).cnb(PullSchema, 'pulls', 'get-pull', { number: String(number) })
  return { ...raw, number, html_url: cnbPage(ctx.deployment.repository, 'pulls', number) }
}
const pullNumber = (thread: string): number | undefined => {
  if (!thread.startsWith(`${SOURCE}:pulls/`)) return undefined
  const number = Number(thread.slice(`${SOURCE}:pulls/`.length))
  return number || undefined
}
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullNumber(item.thread) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)
const branchName = (ref: string): string => ref.replace(/^refs\/heads\//, '')
/** True when the PR was opened by the agent account from a branch in the configured repository (not a fork). */
export const agentPull = (pr: { author: { username: string }; head?: { repo?: { path?: string } | null } | null },
  deployment: Pick<Deployment, 'cnb' | 'repository'>): boolean =>
  !!deployment.cnb && sameName(pr.author.username, deployment.cnb.login)
  // Fail closed when CNB omits head.repo (forks); matching GitHub's `?? ''`.
  && sameName(pr.head?.repo?.path ?? '', deployment.repository)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && branchName(ref).split('/').at(-1) === ticket.execution.name
/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch.
 * Returns an error message when binding is refused, or undefined when bound / not open.
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.isPr === true && source.meta.number === pr.number
  const opened = agentPull(pr, ctx.deployment) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    const login = ctx.deployment.cnb?.login ?? 'the agent'
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).includes(pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${cnbThreadId('pulls', pr.number)}`)
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened)
  return undefined
}
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  const ended = pr.state === 'closed' || pr.state === 'merged' || !!pr.is_merged
  if (ended) closePull(ctx, pr)
  else {
    const candidates = agentPull(pr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:${cnbThreadId('pulls', pr.number)}` && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true).every(number => number === pr.number))) claimPull(ctx, ticket.id, pr)
  }
  // ponytail: CNB has no auto-merge API; do not map mergeable_state onto the autoMerge fact.
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: cnbThreadId('pulls', pr.number) }, own)
    ctx.threads.patch(`${SOURCE}:${cnbThreadId('pulls', pr.number)}`, {
      kind: 'pulls', number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.author.username,
    })
  })
}
function closePull(ctx: SourceContext, pr: Pull): void {
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).includes(pr.number))) return
  const at = pr.merged_at ?? pr.closed_at ?? pr.updated_at ?? new Date().toISOString()
  const merged = pr.state === 'merged' || !!pr.is_merged || pr.mergeable_state === 'merged'
  ctx.tickets.threadClosed({ source: SOURCE, id: cnbThreadId('pulls', pr.number) }, merged ? 'merged' : 'closed', at)
}
export function pullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const number = pullNumber(follow.thread)!
  const url = cnbPage(repository, 'pulls', number)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('cnb-pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome),
    channel, text, kind: 'notice', ticketId: ticket.id }))
}
