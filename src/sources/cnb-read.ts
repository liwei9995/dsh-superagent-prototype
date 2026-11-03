/** Read-only CNB repository, conversation, and commit-status inspection for assessments and workers. */
import { z } from 'zod'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { CommentSchema, IssueSchema, isHumanLogin, reviewPlace, type CnbComment } from './cnb-trigger.ts'
import { ciCounts, ciFact, ciFailures, ciSummary, type CiSnapshot } from './github-read.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

export { ciCounts, ciFact, ciFailures, ciSummary, type CiSnapshot }

const StatusSchema = z.looseObject({ context: z.string(), state: z.string() })
const CommitStatusesSchema = z.looseObject({
  sha: z.string().optional(),
  state: z.string().optional(),
  statuses: z.array(z.unknown()).optional(),
})
const ContentSchema = z.looseObject({
  type: z.string().optional(),
  content: z.string().optional(),
  encoding: z.string().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
  entries: z.array(z.looseObject({ name: z.string() })).optional(),
})

/** Reads commit statuses for a ref without emitting a trigger. CNB has no separate check-runs API. */
export async function pullChecks(commands: Commands, head: string, tally?: Tally): Promise<CiSnapshot> {
  const body = await commands.cnb(CommitStatusesSchema, 'git', 'get-commit-statuses', { commitish: head })
  const statuses = validItems(StatusSchema, body.statuses ?? [], tally)
  const latest = new Map<string, string>()
  for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status.state)
  return { head: body.sha ?? head, checks: [],
    statuses: [...latest].map(([context, state]) => ({ context, state })).sort((a, b) => a.context.localeCompare(b.context)) }
}

/** Reads a non-hidden file or directory listing from the repository's default branch via the CNB API. */
export async function readRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) {
    throw new Error('Only non-hidden repository source paths are available')
  }
  const filePath = parts.join('/')
  if (!filePath && kind === 'file') throw new Error('Name a file path')
  const body = filePath
    ? await commands.cnb(ContentSchema, 'git', 'get-content', { file_path: filePath })
    : await commands.cnb(ContentSchema, 'git', 'get-content-without-path', {})
  if (kind === 'file') {
    if (body.encoding === 'base64' && body.content) return Buffer.from(body.content, 'base64').toString('utf8')
    if (typeof body.content === 'string') return body.content
    throw new Error(`${path} is not a file`)
  }
  const entries = body.entries ?? (Array.isArray(body) ? body as { name: string }[] : undefined)
  if (!entries) throw new Error(`${path || '/'} is not a directory`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}

function cnbMessage(item: Pick<CnbComment, 'author' | 'created_at' | 'path' | 'start_line' | 'end_line'>, text: string, id: string): ContextMessage {
  const line = item.end_line ?? item.start_line
  return { id, from: item.author.username, at: item.created_at ?? '', text,
    ...!isHumanLogin(item.author) ? { bot: true } : {},
    ...item.path ? { path: item.path, ...line != null ? { line } : {} } : {} }
}
const DescriptionSchema = IssueSchema.extend({
  labels: z.array(z.looseObject({ name: z.string() })).nullish(),
  is_wip: z.boolean().nullish(), is_merged: z.boolean().nullish(),
  head: z.looseObject({ ref: z.string() }).nullish(), base: z.looseObject({ ref: z.string() }).nullish(),
})

/**
 * Reads an Issue or PR, a page of its comments or reviews, or a CI snapshot as model-facing messages.
 * Resource paths: `cnb/issues|<pulls>/<number>[/comments|reviews|checks|thread/<id>]` or `cnb/commits/<sha>/checks`.
 */
export async function readCnb(commands: Commands, resource: string): Promise<unknown> {
  const commit = /^cnb\/commits\/([0-9a-f]{7,40}|[^/]+)\/checks$/.exec(resource)
  if (commit) return pullChecks(commands, commit[1]!)
  const match = /^cnb\/(issues|pulls)\/([1-9]\d*)(?:\/(comments|reviews|checks|thread)(?:\/([^/]+))?)?$/.exec(resource)
  if (!match) {
    throw new Error('Use cnb/issues/<number>, cnb/pulls/<number>, or append /comments/<page>, /reviews/<page>, /thread/<comment-id> or /checks; or cnb/commits/<sha>/checks')
  }
  const [, kind, number, section, page = '1'] = match
  if (kind === 'issues' && (section === 'reviews' || section === 'checks' || section === 'thread')) {
    throw new Error('Reviews, review threads and checks require a pull request')
  }
  if (section === 'checks') {
    if (match[4]) throw new Error('Checks do not take a page number')
    const pr = await commands.cnb(z.looseObject({ head: z.looseObject({ sha: z.string() }) }), 'pulls', 'get-pull', { number })
    return pullChecks(commands, pr.head.sha)
  }
  if (section === 'thread') {
    if (!match[4]) throw new Error('Name the review thread by one of its comments: cnb/pulls/<number>/thread/<comment-id>')
    const reviews = await commands.cnbPages(z.looseObject({ id: z.union([z.string(), z.number()]) }), 'pulls', 'list-pull-reviews', { number })
    for (const review of reviews) {
      const comments = await commands.cnbPages(CommentSchema, 'pulls', 'list-pull-review-comments',
        { number, review_id: Number(review.id) })
      const root = comments.find(item => String(item.id) === page)?.reply_to_comment_id ?? page
      const thread = comments.filter(item => String(item.id) === String(root) || String(item.reply_to_comment_id ?? '') === String(root))
        .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
      if (thread.length) {
        const [first] = thread
        return { messages: thread.map(item => item === first
          ? cnbMessage(item, [reviewPlace(item), item.body ?? ''].filter(Boolean).join('\n\n'), String(item.id))
          : { ...cnbMessage(item, item.body ?? '', String(item.id)), reply_to: String(first!.id) }) }
      }
    }
    throw new Error('No review comment of this PR has that id')
  }
  if (!section) {
    const module = kind === 'pulls' ? 'pulls' : 'issues'
    const tool = kind === 'pulls' ? 'get-pull' : 'get-issue'
    const item = await commands.cnb(DescriptionSchema, module, tool, { number })
    const branches = item.head && item.base ? { head: item.head.ref, base: item.base.ref } : {}
    const labels = item.labels?.length ? { labels: item.labels.map(label => label.name) } : {}
    return { number: Number(item.number), title: item.title, state: item.state, ...item.is_merged ? { merged: true } : {},
      ...item.is_wip ? { draft: true } : {}, ...branches, ...labels,
      ...cnbMessage(item, item.body ?? '', String(item.number)) }
  }
  const module = kind === 'pulls' ? 'pulls' : 'issues'
  const tool = section === 'reviews' ? 'list-pull-reviews'
    : kind === 'pulls' ? 'list-pull-comments' : 'list-issue-comments'
  if (section === 'reviews' && kind !== 'pulls') throw new Error('Reviews require a pull request')
  const listed = await commands.cnb(z.array(z.unknown()), module, tool, { number, page: Number(page), page_size: 20 })
  const tally = { skipped: 0 }
  const items = validItems(CommentSchema, Array.isArray(listed) ? listed : [], tally)
  const messages = items.map(item => section === 'reviews'
    ? cnbMessage(item, [item.review_state && item.review_state !== 'commented' ? item.review_state : '', item.body ?? ''].filter(Boolean).join('\n\n'), String(item.id))
    : { ...cnbMessage(item, item.body ?? '', String(item.id)),
      ...item.reply_to_comment_id != null ? { reply_to: String(item.reply_to_comment_id) } : {} })
  return { messages, ...tally.skipped ? { skipped: tally.skipped } : {},
    ...items.length === 20 ? { next_resource: `cnb/${kind}/${number}/${section}/${Number(page) + 1}` } : {} }
}

async function conversationPage(commands: Commands, kind: 'issues' | 'pulls', number: number, page: number) {
  const messages: ContextMessage[] = []
  if (page === 1) {
    const module = kind === 'pulls' ? 'pulls' : 'issues'
    const tool = kind === 'pulls' ? 'get-pull' : 'get-issue'
    const issue = await commands.cnb(IssueSchema, module, tool, { number })
    messages.push(cnbMessage(issue, `${issue.title}\n\n${issue.body ?? ''}`, String(issue.number)))
  }
  const module = kind === 'pulls' ? 'pulls' : 'issues'
  const tool = kind === 'pulls' ? 'list-pull-comments' : 'list-issue-comments'
  const listed = await commands.cnb(z.array(z.unknown()), module, tool, { number, page, page_size: 100 })
  const tally = { skipped: 0 }
  const comments = validItems(CommentSchema, Array.isArray(listed) ? listed : [], tally)
  messages.push(...comments.map(comment => cnbMessage(comment, comment.body ?? '', String(comment.id))))
  return { messages, next_resource: comments.length === 100 ? String(page + 1) : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}

export const cnbThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? trigger.id,
  read: async (commands, trigger, part, cursor) => {
    if (typeof trigger.meta.branch === 'string') {
      const message = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true as const }
      return { messages: [message], body: { status: 'branch_ci', messages: [message] }, status: 'branch_ci' }
    }
    const number = Number(trigger.meta.number)
    const kind = trigger.meta.isPr === true || trigger.meta.kind === 'pulls' ? 'pulls' as const : 'issues' as const
    if (trigger.meta.commentKind === 'inline' && trigger.meta.commentId != null) {
      const body = await readCnb(commands, `cnb/pulls/${number}/thread/${trigger.meta.commentId}`)
      const messages = (body as { messages: ContextMessage[] }).messages
      const read = part === 'thread' ? messages : messages.slice(0, 1)
      return { messages: read, body: { status: 'review_thread', messages: read }, status: 'review_thread' }
    }
    const page = await conversationPage(commands, kind, number, Number(cursor ?? '1'))
    return { messages: page.messages, next: page.next_resource ?? undefined, body: page }
  },
}
