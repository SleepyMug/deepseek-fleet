/**
 * Which sessions dsh has archived, now and on each change. Archiving has no
 * event of its own, but every archive and unarchive rewrites the workspace
 * registry's state, and the write carries the whole new list; the
 * registry's own getter lags until the write returns.
 * @module @sleepymug/fleet-core/dsh/archive
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'

/**
 * Tell `follow` every archived session, at once, and again each time they change.
 * @param dsh - the context whose events are followed, for as long as it lives.
 */
export function followArchived(dsh: Context, follow: (archived: ReadonlySet<string>) => void): void {
  let archived = new Set<string>(dsh.workspaceRegistry.archivedSessionIds)
  dsh.on('domain/changed', (change: DomainChanged) => {
    if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
    const ids = (change.value as { archivedSessionIds?: unknown } | null)?.archivedSessionIds
    if (!Array.isArray(ids)) return
    const next = new Set(ids.map(String))
    if (next.size === archived.size && [...next].every(id => archived.has(id))) return
    archived = next
    follow(archived)
  })
  follow(archived)
}
