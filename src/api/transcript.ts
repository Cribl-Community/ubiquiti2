/**
 * Transcript folding for the GoatTown investigator.
 *
 * The framework owns almost all of this now: `observeSession` runs the wire
 * mapping (`wireEventToLoopEvent` / `readEventCollection`) internally and
 * hands back framework `LoopEvent`s, and `applyLoopEvent` turns those into
 * transcript entries. So this module is only the one case the reducer has no
 * opinion about — the user's own turn, which the wire carries as a
 * `userMessage` frame that is deliberately NOT a LoopEvent — plus the
 * optimistic echo the composer renders before the service confirms it.
 *
 * Keeping it separate from ./goattown keeps it unit-testable without loading
 * the browser transport.
 */
import {
  applyLoopEvent,
  type InvestigatorTranscriptEntry,
} from '@criblio/app-utils/investigator';
import type { LoopEvent } from '@criblio/app-utils/agent-loop';

export { applyLoopEvent };
export type { InvestigatorTranscriptEntry };

/** Fold one framework event, never throwing mid-render: a malformed event is
 *  dropped rather than taking the transcript down. */
export function foldEvent(
  prev: InvestigatorTranscriptEntry[],
  ev: LoopEvent,
): InvestigatorTranscriptEntry[] {
  try {
    return applyLoopEvent(prev, ev);
  } catch {
    return prev;
  }
}

/**
 * Fold the user's own turn.
 *
 * A local echo (`local-…`) with the same text is the same turn arriving back
 * from the service, so it is reconciled in place rather than duplicated; a
 * replayed turn the transcript already shows is ignored, which is what makes
 * reattaching to a session idempotent.
 */
export function foldUserTurn(
  prev: InvestigatorTranscriptEntry[],
  content: string,
  seq: number,
): InvestigatorTranscriptEntry[] {
  const id = `u-${seq}`;
  const last = prev[prev.length - 1];
  if (last && last.kind === 'user' && last.id.startsWith('local-') && last.content === content) {
    return [...prev.slice(0, -1), { ...last, id }];
  }
  if (prev.some((e) => e.kind === 'user' && e.id === id)) return prev;
  return [...prev, { kind: 'user', id, content }];
}
