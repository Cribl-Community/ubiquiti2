import { describe, expect, it } from 'vitest';
import { foldWireEvents } from './wire-fold';
import type { InvestigatorTranscriptEntry } from '@criblio/app-utils/investigator';
import type { WireLoopEvent } from '@criblio/agent-protocol';

const userMessage = (turnId: string, content: string): WireLoopEvent => ({
  kind: 'userMessage',
  turnId,
  content,
});

const toolCall = (id: string): WireLoopEvent => ({
  kind: 'toolCall',
  turnId: 't1',
  needsApproval: false,
  call: { id, type: 'function', function: { name: 'run_search', arguments: '{}' } },
});

const toolResult = (id: string, ui?: unknown): WireLoopEvent => ({
  kind: 'toolResult',
  turnId: 't1',
  result: { id, name: 'run_search', content: 'ok', ui },
});

describe('foldWireEvents', () => {
  it('renders a wire userMessage as a user entry', () => {
    const entries = foldWireEvents([], userMessage('u1', 'hello'));
    expect(entries).toEqual([{ kind: 'user', id: 'u-u1', content: 'hello' }]);
  });

  it('reconciles an optimistic local echo instead of duplicating it', () => {
    const echoed: InvestigatorTranscriptEntry[] = [
      { kind: 'user', id: 'local-123', content: 'hello' },
    ];
    const entries = foldWireEvents(echoed, userMessage('u1', 'hello'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ kind: 'user', id: 'u-u1', content: 'hello' });
  });

  it('does not duplicate a userMessage replayed after reattach', () => {
    const folded = foldWireEvents([], userMessage('u1', 'hello'));
    expect(foldWireEvents(folded, userMessage('u1', 'hello'))).toHaveLength(1);
  });

  it('folds tool calls and results through the framework reducer', () => {
    let entries = foldWireEvents([], toolCall('c1'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'toolCall', status: 'running' });
    entries = foldWireEvents(entries, toolResult('c1', { kind: 'metrics' }));
    expect(entries[0]).toMatchObject({ kind: 'toolCall', status: 'done' });
  });

  it('maps wire errors (plain message) to error entries', () => {
    const entries = foldWireEvents([], { kind: 'error', message: 'boom' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'error', message: 'boom' });
  });

  it('marks assistant text done on assistantDone', () => {
    let entries = foldWireEvents([], { kind: 'assistantText', turnId: 't1', chunk: 'hi' });
    expect(entries[0]).toMatchObject({ kind: 'assistant', inProgress: true });
    entries = foldWireEvents(entries, { kind: 'assistantDone', turnId: 't1' });
    expect(entries[0]).toMatchObject({ kind: 'assistant', inProgress: false });
  });
});
