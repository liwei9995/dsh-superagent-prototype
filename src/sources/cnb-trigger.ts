/** Normalizes CNB issues, pull requests, comments, reviews, and CI transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'cnb'
export type CnbKind = 'issues' | 'pulls'
/** CNB Issue and Pull numbers are separate sequences, so Thread ids keep the kind prefix. */
export const cnbThreadId = (kind: CnbKind, number: number | string): string => `${kind}/${Number(number)}`
export const cnbChannel = (kind: CnbKind, number: number | string, url?: string, extra?: Record<string, string>): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${cnbThreadId(kind, number)}`,
    address: { kind, number: String(Number(number)), ...(url ? { url } : {}), ...extra } })
export const cnbPage = (repository: string, kind: CnbKind, number: number | string): string =>
  `https://cnb.cool/${repository}/-/${kind}/${Number(number)}`
/** Parses a CNB web URL for an Issue or PR in `repository`; returns undefined for other URLs or repositories. */
export function cnbAddress(url: string, repository: string): { kind: CnbKind; number: number; comment?: string } | undefined {
  const address = /^https:\/\/cnb\.cool\/(.+?)\/-\/(issues|pulls)\/(\d+)\/?(?:#(?:issuecomment-|discussion_r|pullcomment-|comment-)?([\w-]+))?$/i
  const match = address.exec(url)
  if (!match || !sameName(match[1]!, repository)) return undefined
  return { kind: match[2]!.toLowerCase() === 'issues' ? 'issues' : 'pulls', number: Number(match[3]),
    ...match[4] ? { comment: match[4] } : {} }
}
export const UserSchema = z.looseObject({
  username: z.string(), nickname: z.string().optional(), email: z.string().optional(), is_npc: z.boolean().optional(),
}).nullable().transform(user => user ?? { username: 'ghost', is_npc: false })
export type CnbUser = z.infer<typeof UserSchema>
export const CommentSchema = z.looseObject({
  id: z.union([z.string(), z.number()]), body: z.string().nullish(), author: UserSchema,
  created_at: z.string().nullish(), updated_at: z.string().nullish(),
  path: z.string().nullish(), start_line: z.number().nullish(), end_line: z.number().nullish(),
  reply_to_comment_id: z.union([z.string(), z.number()]).nullish(),
  review_id: z.union([z.string(), z.number()]).nullish(), review_state: z.string().nullish(),
  commit_hash: z.string().nullish(),
})
export type CnbComment = z.infer<typeof CommentSchema>
export const IssueSchema = z.looseObject({
  number: z.union([z.string(), z.number()]), title: z.string(), state: z.string(),
  body: z.string().nullish(), author: UserSchema,
  created_at: z.string(), updated_at: z.string().nullish(), last_acted_at: z.string().nullish(),
})
export type CnbIssue = z.infer<typeof IssueSchema>
export interface PullRef { kind: CnbKind; number: number; url?: string; prAuthor?: string }
export const isHumanLogin = (user: { username: string; is_npc?: boolean }): boolean => !user.is_npc
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_.-])`, 'i').test(text)
const author = (user: { username: string; is_npc?: boolean }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: isHumanLogin(user) && !sameName(user.username, agent) })
export function reviewPlace(comment: CnbComment): string {
  const line = comment.end_line ?? comment.start_line
  return `${comment.path ?? ''}${line != null ? `:${line}` : ''}`
}
function commentText(comment: CnbComment, kind: 'conversation' | 'inline' | 'review'): string {
  const decided = kind === 'review' && comment.review_state && comment.review_state !== 'commented'
  const decision = decided ? `${comment.review_state} review of commit ${comment.commit_hash ?? 'unknown'}` : ''
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  return [decision, place, comment.body ?? ''].filter(Boolean).join('\n\n')
}
/** Builds a trigger for a comment or review; text is empty for a bodyless comment. */
export function commentTrigger(comment: CnbComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger {
  const at = comment.updated_at ?? comment.created_at ?? new Date().toISOString()
  const version = comment.updated_at ?? ''
  const id = key('cnb-comment', cnbThreadId(ref.kind, ref.number), String(comment.id), version)
  const reviewReply = kind === 'inline' && comment.review_id != null
    ? { commentId: String(comment.id), reviewId: String(comment.review_id) } : undefined
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: cnbThreadId(ref.kind, ref.number) }], ...author(comment.author, agent), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: cnbChannel(ref.kind, ref.number, ref.url, reviewReply),
    ...(ref.url ? { url: ref.url } : {}),
    meta: { kind: ref.kind, number: ref.number, isPr: ref.kind === 'pulls', ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}),
      commentId: String(comment.id), commentKind: kind,
      ...comment.path ? { path: comment.path, line: comment.end_line ?? comment.start_line ?? null } : {},
      ...comment.reply_to_comment_id != null ? { inReplyTo: String(comment.reply_to_comment_id) } : {},
      ...comment.review_id != null ? { reviewId: String(comment.review_id) } : {} } }
}
export function issueTrigger(issue: CnbIssue, agent: string, repository: string): Trigger {
  const number = Number(issue.number)
  const body = issue.body ?? ''
  const url = cnbPage(repository, 'issues', number)
  return { id: key('cnb-issue', String(number)), source: SOURCE,
    threads: [{ source: SOURCE, id: cnbThreadId('issues', number) }], ...author(issue.author, agent), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: cnbChannel('issues', number, url), url, meta: { kind: 'issues', number, isPr: false, commentKind: 'issue' } }
}
export function pullTrigger(pull: CnbIssue, agent: string, repository: string): Trigger {
  const number = Number(pull.number)
  const body = pull.body ?? ''
  const url = cnbPage(repository, 'pulls', number)
  return { id: key('cnb-pull', String(number)), source: SOURCE,
    threads: [{ source: SOURCE, id: cnbThreadId('pulls', number) }], ...author(pull.author, agent), at: pull.created_at,
    text: `${pull.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: cnbChannel('pulls', number, url), url,
    meta: { kind: 'pulls', number, isPr: true, prAuthor: pull.author.username, commentKind: 'pull' } }
}
export function branchCiTrigger(branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('cnb-ci', `branch:${branch}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `ci:${branch}` }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, branch, sha, revision } }
}
export function ciTrigger(pr: { number: number; url: string; author: string }, revision: number, summary: string): Trigger {
  return { id: key('cnb-ci', String(pr.number), String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: cnbThreadId('pulls', pr.number) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: cnbChannel('pulls', pr.number, pr.url), url: pr.url,
    meta: { kind: 'pulls', number: pr.number, isPr: true, prAuthor: pr.author, ci: true, revision } }
}
