/** CNB outbound channel: posts Issue/PR comments and review-thread replies under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { cnbAddress, cnbPage, CommentSchema, type CnbKind } from './cnb-trigger.ts'

/** True when a thread is permanently gone (410) or locked (403); 404 is retried because it can mean temporary permission loss. */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 410 || (error.code === 403 && /lock/i.test(error.message)))
/** Posts a comment or review reply with an embedded HTML marker so retries do not create duplicate comments. */
export async function sendCnb(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { repository, cnb } = commands.deployment
  if (!cnb) throw new Error('CNB channel requires a CNB deployment')
  const kind = (message.channel.address.kind === 'pulls' ? 'pulls' : 'issues') as CnbKind
  const number = Number(message.channel.address.number)
  if (!number) throw new Error('Missing CNB reply target')
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const address = cnbAddress(message.channel.address.url ?? '', repository)
    const reviewId = message.channel.address.reviewId
    const replyTo = address?.comment ?? message.channel.address.commentId
    if (kind === 'pulls' && reviewId && replyTo) {
      const listed = await commands.cnbPages(CommentSchema, 'pulls', 'list-pull-review-comments',
        { number, review_id: Number(reviewId) })
      const mine = listed.some(comment => sameName(comment.author.username, cnb.login)
        && String(comment.reply_to_comment_id ?? '') === String(replyTo) && (comment.body ?? '').includes(marker))
      if (mine) return 'sent'
      await commands.cnb(z.unknown(), 'pulls', 'post-pull-request-review-reply', {
        number, review_id: Number(reviewId), reply_to_comment_id: String(replyTo), body: `${message.text}\n\n${marker}`,
      })
      return 'sent'
    }
    const module = kind === 'pulls' ? 'pulls' : 'issues'
    const listTool = kind === 'pulls' ? 'list-pull-comments' : 'list-issue-comments'
    const postTool = kind === 'pulls' ? 'post-pull-comment' : 'post-issue-comment'
    const listed = await commands.cnbPages(CommentSchema, module, listTool, { number })
    if (listed.some(comment => sameName(comment.author.username, cnb.login) && (comment.body ?? '').includes(marker))) return 'sent'
    await commands.cnb(z.unknown(), module, postTool, { number, body: `${message.text}\n\n${marker}` })
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function cnbLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = address.number ?? ''
  const kind = (address.kind === 'pulls' ? 'pulls' : 'issues') as CnbKind
  const review = !!address.reviewId || !!address.commentId
  return { url: address.url ?? (links.repository ? cnbPage(links.repository, kind, number) : ''),
    label: review ? { zh: `CNB #${number} 的 review 讨论`, en: `Review discussion on CNB #${number}` }
      : { zh: `CNB #${number}`, en: `CNB #${number}` } }
}
