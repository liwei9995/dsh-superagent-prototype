/** CNB source kind definition, repository polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { key, type Thread } from '../core/index.ts'
import { CnbAccountsSchema } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { z } from 'zod'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import { cnbLink, sendCnb } from './cnb-channel.ts'
import { observePull, pullsOf, readPull, type Pull } from './cnb-pull.ts'
import { branchCiTrigger, ciTrigger, commentTrigger, CommentSchema, cnbPage, cnbThreadId, issueTrigger, IssueSchema, mentions, pullTrigger, SOURCE }
  from './cnb-trigger.ts'
import { ciCounts, ciFact, ciFailures, ciSummary, cnbThreadContext, pullChecks } from './cnb-read.ts'

export { commentTrigger, type CnbComment } from './cnb-trigger.ts'

const CnbConfigSchema = CnbAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observePulls: z.boolean().default(false), observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false),
}).strict()
export type CnbConfig = z.infer<typeof CnbConfigSchema>
const OBSERVED = { issues: 'observeIssues', pulls: 'observePulls', comments: 'observeComments', ci: 'observeCi' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issues' || meta.commentKind === 'issue') return 'issues'
  if (meta.kind === 'pulls' || meta.commentKind === 'pull') return 'pulls'
  return meta.commentKind === 'conversation' || meta.commentKind === 'inline' || meta.commentKind === 'review' ? 'comments' : undefined
}

export const cnbKind: SourceKind<CnbConfig> = {
  kind: SOURCE,
  title: { zh: 'CNB', en: 'CNB' },
  description: {
    zh: '智能体的 CNB 账号；接收仓库里的 Issue、PR、评论、CI 状态变化和 PR 合并关闭。',
    en: 'The agent\'s CNB account; receives Issues, pull requests, comments, CI changes, and PR merge or close in the repository.',
  },
  schema: CnbConfigSchema,
  fields: [
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(/[A-Za-z0-9_.\\-]+)+', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 group/repo（可多层）。与 GitHub 来源二选一；保存时检查智能体账号能否推送，然后重启。', en: 'Written group/repo (may be nested). Mutually exclusive with the GitHub Source; saving checks push access, then restarts.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 CNB CLI', en: 'Agent CNB CLI' },
      hint: { zh: '命令名或绝对路径，通常是已 cnb login 的 cnb 包装脚本。保存时检查账号能否推送到仓库，然后重启。', en: 'A command name or absolute path, usually a cnb wrapper signed in with cnb login. Saving checks push access, then restarts.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too. Starts when switched on.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repository' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支的 CI', en: 'Receive the default branch\'s CI' } }],
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['cnb'],
  channel: { send: sendCnb, link: cnbLink },
  threadContext: cnbThreadContext,
  find: query => {
    const number = (/^#?(\d+)$/.exec(query.trim()) ?? /cnb\.cool\/.+?\/-\/(?:pulls|issues)\/(\d+)/.exec(query))?.[1]
    return { threads: number ? [`${SOURCE}:issues/${number}`, `${SOURCE}:pulls/${number}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9._-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9._-]+$/) }).strict()).optional(),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 CNB 账号', en: 'CNB accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9._\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9._\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
    rows(stored) {
      const config = CnbConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('pulls', { zh: '新 PR', en: 'New pull requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        { id: 'ci', label: { zh: '默认分支的 CI', en: 'Default branch CI' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_CNB_REPOSITORY', description: { zh: '这个来源监听的仓库。智能体在这里开的 PR，分支最后一段是 DSH_SUPERAGENT_NAME 时会关联到工单', en: 'The repository this Source watches. A PR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_CNB_ACCOUNT', description: { zh: '智能体的 CNB 账号；cnb 以它登录', en: 'The agent\'s CNB account; cnb is signed in to it' } },
      { key: 'DSH_SUPERAGENT_CNB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱', en: 'Commit email of the agent\'s account' } },
      { key: 'DSH_SUPERAGENT_CNB_NUMBER', description: { zh: '接下工单的 Issue 或 PR 编号；工单不是从 CNB 来的时为空', en: 'Number of the Issue or PR that started the ticket; empty when the ticket did not start on CNB' } },
      { key: 'DSH_SUPERAGENT_CNB_KIND', description: { zh: 'issues 或 pulls；工单不是从 CNB 来的时为空', en: 'issues or pulls; empty when the ticket did not start on CNB' } },
    ],
    values: ({ deployment, trigger }) => {
      const number = trigger?.threads[0]?.source === SOURCE ? Number(trigger.meta.number) || 0 : 0
      const kind = trigger?.meta.kind === 'pulls' || trigger?.meta.isPr === true ? 'pulls' : number ? 'issues' : ''
      return {
        DSH_SUPERAGENT_CNB_REPOSITORY: deployment.repository,
        DSH_SUPERAGENT_CNB_ACCOUNT: deployment.cnb?.login ?? '',
        DSH_SUPERAGENT_CNB_COMMIT_EMAIL: deployment.cnb?.noreply ?? '',
        DSH_SUPERAGENT_CNB_NUMBER: number ? String(number) : '',
        DSH_SUPERAGENT_CNB_KIND: kind,
      }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.cnb ? {
    cli: { zh: `当前账号 @${deployment.cnb.login}`, en: `Current account @${deployment.cnb.login}` },
  } : {},
}

export const name = 'dsh-superagent-cnb'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(cnbKind), 'cnb: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, cnbKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('cnb', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('cnb', health('paused', 'setupPending')); return }
  if (ctx.deployment.forge !== 'cnb' || !ctx.deployment.cnb) {
    ctx.report('cnb', health('paused', 'forgeGithub')); return
  }
  while (!signal.aborted) {
    const config = ctx.config<CnbConfig>(SOURCE)
    try {
      if (config?.repository) await pollRound(ctx, signal)
      else ctx.report('cnb', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('cnb', failed)
    }
    await pause((ctx.config<CnbConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}

interface Round {
  started: string; signal?: AbortSignal | undefined
  pulls: Map<number, Promise<Pull>>; read: Set<string>; failures: string[]; tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, pulls: new Map(), read: new Set(),
  failures: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
export interface Retry { since: string; kind: 'issues' | 'pulls'; failedAt?: string; attempts?: number }
/** True when CNB returns HTTP 410 (Gone); HTTP 404 is retried because it can indicate revoked access to a private repository. */
const deleted = (error: unknown): boolean => error instanceof CliError && error.code === 410

export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const round = newRound(signal)
  await pollRepository(ctx, round)
  await pollTicketPulls(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  if (signal?.aborted) return
  if (round.failures.length) throw new Error(`${round.failures.length} CNB reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const skipped = round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''
  ctx.report('cnb', { state: 'ready', detail: `polled repository streams${skipped}`, at: round.started })
}

async function pollRepository(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<CnbConfig>(SOURCE)
  if (!config) return
  for (const stream of ['issues', 'pulls', 'issue-comments', 'pull-comments'] as const) {
    if (stopped(ctx, round)) return
    const observed = stream === 'issues' ? config.observeIssues
      : stream === 'pulls' ? config.observePulls
        : config.observeComments
    // Always scan for @agent mentions even when observe* is off (CNB has no notification feed).
    try { await readStream(ctx, round, stream, observed) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${stream}: ${String(error)}`) }
  }
  if (!config.observeCi) {
    const seen = ctx.state.get(KV.cnb.branchCi)
    ctx.state.set(KV.cnb.branchCi, seen && { revision: seen.revision })
    return
  }
  try { await pollBranchCi(ctx, round) }
  catch (error) { if (!stopped(ctx, round)) round.failures.push(`default branch CI: ${String(error)}`) }
}

async function readStream(ctx: SourceContext, round: Round, stream: string, observed: boolean): Promise<void> {
  const name = KV.cnb.stream(stream)
  const stored = ctx.state.get(name)
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const since = new Date(Math.max(Date.parse(stored?.since ?? round.started), horizon)).toISOString()
  const startedAt = stored?.started ?? round.started
  const login = ctx.deployment.cnb!.login
  const { repository } = ctx.deployment
  const day = since.slice(0, 10)
  if (stream === 'issues' || stream === 'pulls') {
    const module = stream === 'issues' ? 'issues' : 'pulls'
    const tool = stream === 'issues' ? 'list-issues' : 'list-pulls'
    // Paginate the day window so a burst larger than one page is not lost when the cursor advances.
    const items = await ctx.commands.withSignal(round.signal)
      .cnbPages(IssueSchema, module, tool, { order_by: '-created_at', updated_time_begin: day }, round.tally)
    for (const item of items) {
      if (stopped(ctx, round)) throw new Error('The CNB Source stopped during the poll')
      if (sameName(item.author.username, login)) continue
      if (Date.parse(item.created_at) < Math.max(Date.parse(startedAt), horizon)) continue
      const addressed = mentions(`${item.title}\n${item.body ?? ''}`, login)
      if (!observed && !addressed) continue
      if (Date.parse(item.created_at) < Date.parse(since) && !addressed) continue
      await ctx.receive(stream === 'issues' ? issueTrigger(item, login, repository) : pullTrigger(item, login, repository))
      nameThread(ctx, stream === 'issues' ? 'issues' : 'pulls', Number(item.number), item.title)
    }
  } else {
    // ponytail: re-scan recently updated parents (open+closed); ceiling ~20 pages × 50 parents/poll
    const kind = stream === 'issue-comments' ? 'issues' as const : 'pulls' as const
    const module = kind === 'issues' ? 'issues' : 'pulls'
    const listTool = kind === 'issues' ? 'list-issues' : 'list-pulls'
    const commentTool = kind === 'issues' ? 'list-issue-comments' : 'list-pull-comments'
    const floor = Math.max(Date.parse(since), horizon)
    const parents = await recentlyUpdated(ctx, round, module, listTool, day, floor,
      kind === 'pulls' ? { state: 'all' } : {})
    for (const item of parents) {
      if (stopped(ctx, round)) throw new Error('The CNB Source stopped during the poll')
      const number = Number(item.number)
      const comments = await ctx.commands.withSignal(round.signal).cnbPages(CommentSchema, module, commentTool, { number }, round.tally)
      for (const comment of comments) {
        if (sameName(comment.author.username, login)) continue
        const at = comment.updated_at ?? comment.created_at ?? ''
        if (Date.parse(at) < floor) continue
        const addressed = mentions(comment.body ?? '', login)
        if (!observed && !addressed) continue
        const ref = { kind, number, url: cnbPage(repository, kind, number),
          ...(kind === 'pulls' ? { prAuthor: item.author.username } : {}) }
        const trigger = commentTrigger(comment, ref, 'conversation', login)
        if (trigger.text) await ctx.receive(trigger)
      }
    }
  }
  ctx.state.set(name, { since: cursorAt(round.started), started: startedAt })
}

/** Lists Issues/PRs updated on/after `day`, newest first, stopping once a page falls below `floor` or the page ceiling. */
async function recentlyUpdated(ctx: SourceContext, round: Round, module: string, tool: string, day: string, floor: number,
  flags: Record<string, string | number | boolean | undefined> = {}): Promise<z.infer<typeof IssueSchema>[]> {
  const items: z.infer<typeof IssueSchema>[] = []
  let page = 1
  for (;;) {
    const batch = validItems(IssueSchema, await ctx.commands.withSignal(round.signal)
      .cnb(z.array(z.unknown()), module, tool, { ...flags, page, page_size: 50, order_by: '-updated_at', updated_time_begin: day })
      .then(data => Array.isArray(data) ? data : []), round.tally)
    items.push(...batch)
    const oldest = batch.at(-1)
    const stamp = Date.parse(oldest?.updated_at ?? oldest?.created_at ?? '')
    if (batch.length < 50 || !Number.isFinite(stamp) || stamp < floor || page >= 20) break
    page += 1
  }
  return items
}

async function pollBranchCi(ctx: SourceContext, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const headRef = await commands.cnb(z.looseObject({ name: z.string() }), 'git', 'get-head', {})
  const branch = headRef.name
  const commit = await commands.cnb(z.looseObject({ sha: z.string().optional(), id: z.string().optional() }), 'git', 'get-commit', { ref: branch })
  const sha = commit.sha ?? commit.id
  if (!sha) throw new Error('CNB default branch head has no sha')
  const snapshot = await pullChecks(commands, sha, round.tally)
  const previous = ctx.state.get(KV.cnb.branchCi)
  const known = previous?.branch === branch ? previous.failures : undefined
  const failures = ciFailures(snapshot)
  const counts = ciCounts(snapshot)
  const now = failures.length || !counts.running ? failures : known ?? []
  let revision = previous?.revision ?? 0
  if (known && JSON.stringify(now) !== JSON.stringify(known)) {
    revision += 1
    const summary = ciSummary(snapshot, branch, `cnb/commits/${sha}/checks`)
    const url = `https://cnb.cool/${ctx.deployment.repository}/-/commit/${sha}`
    await ctx.receive(branchCiTrigger(branch, sha, revision, summary, url))
    ctx.threads.describe(`${SOURCE}:ci:${branch}`, { label: `CI on ${branch}`, facts: { ci: ciFact(counts) } })
  }
  ctx.state.set(KV.cnb.branchCi, { branch, failures: now, revision })
}

function pull(ctx: SourceContext, round: Round, number: number): Promise<Pull> {
  let read = round.pulls.get(number)
  if (!read) {
    read = readPull(ctx, number, round.signal).then(async pr => { await observePull(ctx, pr); return pr })
    round.pulls.set(number, read)
  }
  return read
}

export async function pollTicketPulls(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const numbers = [...new Set(ctx.tickets.open().flatMap(ticket => pullsOf(ticket, true)))]
  for (const number of numbers) {
    if (stopped(ctx, round)) return
    try {
      const pr = await pull(ctx, round, number)
      if (pr.state === 'open' && !pr.is_merged) await pollChecks(ctx, round, number, pr)
    } catch (error) { if (!stopped(ctx, round)) round.failures.push(`#${number}: ${String(error)}`) }
  }
}

async function pollChecks(ctx: SourceContext, round: Round, number: number, pr: Pull): Promise<void> {
  const snapshot = await pullChecks(ctx.commands.withSignal(round.signal), pr.head.sha, round.tally)
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = ctx.state.get(KV.cnb.ci(number))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous) {
    await ctx.receive(ciTrigger({ number, url: pr.html_url, author: pr.author.username }, revision,
      ciSummary(snapshot, `PR #${number}`, `cnb/pulls/${number}/checks`)))
  }
  ctx.state.set(KV.cnb.ci(number), { fingerprint, revision })
  ctx.threads.describe(`${SOURCE}:${cnbThreadId('pulls', number)}`, { facts: { ci: ciFact(ciCounts(snapshot)) } })
}

function nameThread(ctx: SourceContext, kind: 'issues' | 'pulls', number: number, title: string): void {
  const thread = `${SOURCE}:${cnbThreadId(kind, number)}`
  ctx.threads.patch(thread, { title, kind, number, isPr: kind === 'pulls' })
  ctx.threads.describe(thread, { label: `#${number} ${title}`, facts: { number: { value: `#${number}` } } })
}

export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      if (!deleted(error)) round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(thread.ref.id))
}

async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  if (thread.ref.id.startsWith('ci:')) return
  const match = /^(issues|pulls)\/(\d+)$/.exec(thread.ref.id)
  if (!match) throw new Error('Subscribed thread has no CNB issue or PR id')
  const kind = match[1] as 'issues' | 'pulls'
  const number = Number(match[2])
  round.read.add(thread.ref.id)
  const login = ctx.deployment.cnb!.login
  const checkpoint = KV.cnb.cursor(thread.ref.id)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  if (kind === 'pulls') {
    const pr = await pull(ctx, round, number)
    await intakeComments(ctx, { kind, number, url: pr.html_url, prAuthor: pr.author.username }, since, round, login)
    if (pr.title) nameThread(ctx, kind, number, pr.title)
  } else {
    const issue = await ctx.commands.withSignal(round.signal).cnb(IssueSchema, 'issues', 'get-issue', { number })
    await intakeComments(ctx, { kind, number, url: cnbPage(ctx.deployment.repository, kind, number) }, since, round, login)
    nameThread(ctx, kind, number, issue.title)
  }
  ctx.state.set(checkpoint, cursorAt(round.started))
  ctx.threads.patch(thread.key, { pollError: undefined })
}

async function intakeComments(ctx: SourceContext, ref: { kind: 'issues' | 'pulls'; number: number; url?: string; prAuthor?: string },
  since: string, round: Round, login: string): Promise<void> {
  const module = ref.kind === 'pulls' ? 'pulls' : 'issues'
  const commentTool = ref.kind === 'pulls' ? 'list-pull-comments' : 'list-issue-comments'
  const comments = await ctx.commands.withSignal(round.signal).cnbPages(CommentSchema, module, commentTool, { number: ref.number }, round.tally)
  for (const comment of comments) {
    if (stopped(ctx, round)) throw new Error('The CNB Source stopped during the poll')
    const timestamp = Date.parse(comment.updated_at ?? comment.created_at ?? '')
    if (!Number.isFinite(timestamp) || timestamp < Date.parse(since)) continue
    if (sameName(comment.author.username, login)) continue
    const trigger = commentTrigger(comment, ref, 'conversation', login)
    if (trigger.text) await ctx.receive(trigger)
  }
  if (ref.kind === 'pulls') {
    const reviews = await ctx.commands.withSignal(round.signal)
      .cnbPages(CommentSchema.extend({ id: z.union([z.string(), z.number()]) }), 'pulls', 'list-pull-reviews', { number: ref.number }, round.tally)
    for (const review of reviews) {
      if (stopped(ctx, round)) throw new Error('The CNB Source stopped during the poll')
      const timestamp = Date.parse(review.updated_at ?? review.created_at ?? '')
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(since)) continue
      if (sameName(review.author.username, login)) continue
      const trigger = commentTrigger(review, ref, 'review', login)
      if (trigger.text) await ctx.receive(trigger)
      const inlines = await ctx.commands.withSignal(round.signal)
        .cnbPages(CommentSchema, 'pulls', 'list-pull-review-comments', { number: ref.number, review_id: Number(review.id) }, round.tally)
      for (const comment of inlines) {
        const at = Date.parse(comment.updated_at ?? comment.created_at ?? '')
        if (!Number.isFinite(at) || at < Date.parse(since)) continue
        if (sameName(comment.author.username, login)) continue
        // Review-comment payloads often omit review_id; bind the parent review so Outbox can reply in-thread.
        const trigger = commentTrigger({ ...comment, review_id: comment.review_id ?? review.id }, ref, 'inline', login)
        if (trigger.text) await ctx.receive(trigger)
      }
    }
  }
}
