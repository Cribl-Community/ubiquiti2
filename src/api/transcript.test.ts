import { describe, expect, it } from 'vitest';
import { foldEvent, foldUserTurn, type InvestigatorTranscriptEntry } from './transcript';
import type { LoopEvent } from '@criblio/app-utils/agent-loop';

const toolCall = (id: string): LoopEvent => ({
  kind: 'toolCall',
  turnId: 't1',
  needsApproval: false,
  call: { id, function: { name: 'run_search', arguments: '{}' } },
});

const toolResult = (id: string): LoopEvent => ({
  kind: 'toolResult',
  turnId: 't1',
  result: { id, name: 'run_search', content: 'ok' },
});

describe('foldEvent', () => {
  it('folds framework events through the framework reducer', () => {
    let entries = foldEvent([], toolCall('c1'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'toolCall', status: 'running' });
    entries = foldEvent(entries, toolResult('c1'));
    expect(entries[0]).toMatchObject({ kind: 'toolCall', status: 'done' });
  });

  it('marks assistant text done on assistantDone', () => {
    let entries = foldEvent([], { kind: 'assistantText', turnId: 't1', chunk: 'hi' });
    expect(entries[0]).toMatchObject({ kind: 'assistant', inProgress: true });
    entries = foldEvent(entries, { kind: 'assistantDone', turnId: 't1' });
    expect(entries[0]).toMatchObject({ kind: 'assistant', inProgress: false });
  });

  it('keeps the transcript when an event cannot be folded', () => {
    const before: InvestigatorTranscriptEntry[] = [{ kind: 'user', id: 'u-1', content: 'hello' }];
    // A frame this build does not understand must not take the page down.
    const bad = { kind: 'toolResult', turnId: 't1' } as unknown as LoopEvent;
    expect(foldEvent(before, bad)).toBe(before);
  });
});

describe('foldUserTurn', () => {
  it('appends the turn the service reports', () => {
    expect(foldUserTurn([], 'hello', 7)).toEqual([{ kind: 'user', id: 'u-7', content: 'hello' }]);
  });

  it('reconciles the optimistic echo instead of duplicating it', () => {
    const echoed: InvestigatorTranscriptEntry[] = [
      { kind: 'user', id: 'local-123', content: 'hello' },
    ];
    const entries = foldUserTurn(echoed, 'hello', 7);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ kind: 'user', id: 'u-7', content: 'hello' });
  });

  it('does not duplicate a turn replayed after reattach', () => {
    const folded = foldUserTurn([], 'hello', 7);
    expect(foldUserTurn(folded, 'hello', 7)).toHaveLength(1);
  });

  it('keeps a later turn that repeats an earlier question', () => {
    const entries = foldUserTurn(foldUserTurn([], 'hello', 7), 'hello', 9);
    expect(entries).toHaveLength(2);
  });
});
