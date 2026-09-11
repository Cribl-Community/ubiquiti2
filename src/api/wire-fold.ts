/**
 * Pure wire→transcript folding for the GoatTown investigator.
 *
 * Deliberately dependency-light: the only runtime import is the framework's
 * transcript reducer, so this logic is unit-testable in a plain Node test
 * environment without loading the browser transport (`./goattown` pulls the
 * whole GoatTown client: fetch proxy assumptions, polling, KV access). The
 * transport re-exports `foldWireEvents` so callers keep one import site.
 *
 * Wire protocol: @criblio/agent-protocol (v1). Rendering must stay identical
 * to a client-run transcript, hence the framework reducer rather than a local
 * reimplementation.
 */
import {
  applyLoopEvent,
  type InvestigatorTranscriptEntry,
} from '@criblio/app-utils/investigator';
import type { LoopEvent } from '@criblio/app-utils/agent-loop';
import type { WireLoopEvent } from '@criblio/agent-protocol';

/**
 * Fold a wire event into transcript entries. `userMessage` and `error`
 * are handled here (they are not framework LoopEvents / carry a plain
 * message); everything else is structurally identical and goes through
 * the framework reducer so server-run transcripts render pixel-identical
 * to client-run ones. Optimistic local echoes (ids prefixed `local-`)
 * are reconciled against the canonical userMessage instead of duplicated.
 */
export function foldWireEvents(
  prev: InvestigatorTranscriptEntry[],
  ev: WireLoopEvent,
): InvestigatorTranscriptEntry[] {
  if (ev.kind === 'userMessage') {
    const last = prev[prev.length - 1];
    if (last && last.kind === 'user' && last.id.startsWith('local-') && last.content === ev.content) {
      return [...prev.slice(0, -1), { ...last, id: `u-${ev.turnId}` }];
    }
    if (prev.some((e) => e.kind === 'user' && e.id === `u-${ev.turnId}`)) return prev;
    return [...prev, { kind: 'user', id: `u-${ev.turnId}`, content: ev.content }];
  }
  if (ev.kind === 'error') {
    return [
      ...prev,
      {
        kind: 'error',
        id: `err-${prev.length}-${ev.message.length}-${ev.message.slice(0, 24)}`,
        message: ev.message,
      },
    ];
  }
  if (ev.kind === 'done') {
    return applyLoopEvent(prev, {
      kind: 'done',
      reason: ev.reason === 'aborted' ? 'aborted' : 'complete',
    });
  }
  return applyLoopEvent(prev, ev as LoopEvent);
}
