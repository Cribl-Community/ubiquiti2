import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  InvestigatorTranscript,
  type InvestigatorTranscriptEntry,
} from '@criblio/app-utils/investigator';
import MetricsToolCard from '@criblio/app-utils/investigator/metrics-tool-card';
import type { MetricsQueryUi } from '@criblio/app-utils/agent-tools';
import { exportAsPng } from '@criblio/app-utils/investigator';
import { titleFromPrompt } from '@criblio/agent-protocol';
import { isTerminalStatus } from '@criblio/agent-protocol';
import type { SessionStatus } from '@criblio/agent-protocol';
import {
  buildServerPrompt,
  SUGGESTED_QUESTIONS,
} from '../api/investigator';
import {
  connectionDiagnostics,
  createInvestigation,
  fetchCapabilities,
  foldWireEvents,
  InvestigationFeed,
  listInvestigations,
  loadConnection,
  loadSessionState,
  loadTranscript,
  memberClaim,
  runLifecycle,
  saveSessionState,
  sendMessage,
  setArchived,
  type GoatTownCapabilities,
  type GoatTownConnection,
  type InvestigationSummary,
  type LifecycleAction,
} from '../api/goattown';
import type { WireLoopEvent } from '@criblio/agent-protocol';
import s from './InvestigatePage.module.css';

/** Default context window: the last hour, snapshotted absolutely. */
const contextWindow = () => ({ earliestMs: Date.now() - 3_600_000, latestMs: Date.now() });

const STATUS_LABEL: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  idle: 'awaiting follow-up',
  concluded: 'concluded',
  failed: 'failed',
  cancelled: 'cancelled',
};

export default function InvestigatePage() {
  const location = useLocation();
  const navigate = useNavigate();

  const [conn, setConn] = useState<GoatTownConnection | null>(null);
  const [connLoaded, setConnLoaded] = useState(false);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [caps, setCaps] = useState<GoatTownCapabilities>({});
  const [history, setHistory] = useState<InvestigationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
  const [entries, setEntries] = useState<InvestigatorTranscriptEntry[]>([]);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'creating' | 'sending' | 'switching' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvalNotice, setApprovalNotice] = useState(false);
  const [exportedPng, setExportedPng] = useState<string | null>(null);

  const feedRef = useRef<InvestigationFeed | null>(null);
  const transcriptInnerRef = useRef<HTMLDivElement | null>(null);
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consumedSeed = useRef<string | null>(null);

  const seed = useMemo(() => {
    const state = location.state as { question?: string } | null;
    if (state?.question) return { question: state.question, explicit: true };
    const params = new URLSearchParams(location.search);
    const q = params.get('q');
    return q ? { question: q, explicit: true } : null;
  }, [location.state, location.search]);

  const consumeSeed = useCallback(() => {
    navigate('/investigate', { replace: true });
  }, [navigate]);

  const refreshHistory = useCallback(async (connection: GoatTownConnection, member: string) => {
    try {
      setHistory(await listInvestigations(connection, member, connection.agent));
    } catch {
      /* history is best-effort; the banner shows hard failures */
    }
  }, []);

  const attach = useCallback(
    async (connection: GoatTownConnection, member: string, id: string) => {
      setBusy('switching');
      setError(null);
      try {
        const backfill = await loadTranscript(connection, member, id);
        setEntries(backfill.entries);
        setStatus(backfill.status);
        setActiveTitle(null);
        feedRef.current?.stop();
        const feed = new InvestigationFeed(connection, member, id, {
          onBatch: (batch) => {
            setEntries((prev) => {
              let next = prev;
              for (const event of batch.events) next = foldSafe(next, event.ev);
              return next;
            });
            setStatus(batch.status);
            if (batch.title) setActiveTitle(batch.title);
            if (
              batch.status === 'concluded' ||
              batch.status === 'failed' ||
              batch.status === 'cancelled'
            ) {
              feedRef.current?.stop();
              void refreshHistory(connection, member);
            }
          },
          onError: (err) => setError(err.message),
        });
        feedRef.current = feed;
        feed.start(backfill.latestSeq);
        setActiveId(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refreshHistory],
  );

  // Re-read the connection after the user links GoatTown on the
  // Configuration page, without a full page reload — and say exactly
  // what is missing when it is still unlinked.
  const recheckConnection = useCallback(async () => {
    setError(null);
    const diag = await connectionDiagnostics();
    setConn(diag.connection);
    if (!diag.connection) {
      if (diag.error) setError(`GoatTown link check failed: ${diag.error}`);
      else if (diag.connectionKeyExists === false && diag.tokenKeyExists === false)
        setError(
          'GoatTown is not configured yet — neither the service URL nor the embed token is saved. Set both under Configuration → GoatTown connection, then recheck.',
        );
      else if (diag.connectionKeyExists === false)
        setError(
          'The service URL is not saved yet — set it under Configuration → GoatTown connection, then recheck.',
        );
      else if (diag.tokenKeyExists === false)
        setError(
          'The embed token is not saved — the fetch proxy cannot authenticate to GoatTown without it. Save it under Configuration → GoatTown connection (leave the URL as is), then recheck.',
        );
      else if (diag.connectionKeyExists && !diag.connection) {
        const raw = diag.rawRead;
        setError(
          `Saved connection unreadable — GET goattown/connection → HTTP ${raw?.status ?? '?'}` +
            (raw?.parseError ? `: ${raw.parseError}` : '') +
            (raw?.body ? ` — body: ${raw.body.slice(0, 140)}` : ''),
        );
      } else setError('A GoatTown connection is saved but could not be read back.');
      return;
    }
    if (memberId) {
      void fetchCapabilities(diag.connection, memberId).then(({ caps: c }) => setCaps(c));
      void refreshHistory(diag.connection, memberId);
      const state = await loadSessionState(memberId);
      setDraft((prev) => prev || state.draft);
      if (state.activeId) void attach(diag.connection, memberId, state.activeId);
    }
  }, [memberId, refreshHistory, attach]);

  // Boot: identity → connection → persisted session (reattach, never restart).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const member = await memberClaim();
        if (cancelled) return;
        setMemberId(member);
        const connection = await loadConnection();
        if (cancelled) return;
        setConn(connection);
        setConnLoaded(true);
        if (!connection) return;
        void fetchCapabilities(connection, member).then(({ caps: c }) => !cancelled && setCaps(c));
        void refreshHistory(connection, member);
        const state = await loadSessionState(member);
        if (cancelled) return;
        setDraft(state.draft);
        if (state.activeId) void attach(connection, member, state.activeId);
      } catch (err) {
        if (!cancelled) {
          setConnLoaded(true);
          setMemberError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
      feedRef.current?.stop();
    };
  }, [attach, refreshHistory]);

  // Draft persistence (KV is authoritative; keyed per member).
  useEffect(() => {
    if (!memberId) return;
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      void loadSessionState(memberId)
        .then((state) => saveSessionState(memberId, { ...state, draft }))
        .catch(() => undefined);
    }, 500);
  }, [draft, memberId]);

  const startInvestigation = useCallback(
    async (question: string, connection: GoatTownConnection, member: string) => {
      if (busy) return;
      setBusy('creating');
      setError(null);
      const window = contextWindow();
      const entity = question.match(/(?:access point|switch|client|gateway)\s+"([^"]+)"/i)?.[1];
      const title = titleFromPrompt(question);
      const attach = (id: string, initialStatus: SessionStatus) => {
        setEntries([{ kind: 'user', id: 'local-open', content: question }]);
        setStatus(initialStatus);
        setActiveTitle(title);
        feedRef.current?.stop();
        const feed = new InvestigationFeed(connection, member, id, {
          onBatch: (batch) => {
            setEntries((prev) => {
              let next = prev;
              for (const event of batch.events) next = foldSafe(next, event.ev);
              return next;
            });
            setStatus(batch.status);
            if (batch.title) setActiveTitle(batch.title);
            if (
              batch.status === 'concluded' ||
              batch.status === 'failed' ||
              batch.status === 'cancelled'
            ) {
              feedRef.current?.stop();
              void refreshHistory(connection, member);
            }
          },
          onError: (err) => setError(err.message),
        });
        feedRef.current = feed;
        feed.start(0);
        setActiveId(id);
      };
      try {
        const { id } = await createInvestigation(connection, member, {
          agent: connection.agent,
          prompt: buildServerPrompt({ question }, { entity, ...window }),
          title,
        });
        attach(id, 'queued');
        await saveSessionState(member, { activeId: id, draft: '' });
        setDraft('');
        void refreshHistory(connection, member);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const aborted =
          (err instanceof DOMException && err.name === 'AbortError') || /abort|timed?\s?out/i.test(message);
        if (!aborted) {
          setError(
            `${message}${message.includes('403') ? ' — the GoatTown host may be missing from config/proxies.yml or the embed token is not provisioned.' : ''}`,
          );
          return;
        }
        // Ambiguous create: the request hit its client-side timeout, but
        // GoatTown may have created the session anyway. Reconcile against
        // server history instead of retrying (a retry would duplicate it).
        try {
          const history = await listInvestigations(connection, member, connection.agent);
          const recent = (ts: number) =>
            (Date.now() - ts < 10 * 60_000) || (Date.now() / 1000 - ts < 600);
          const candidate = history.find((h) => recent(h.createdAt) && !isTerminalStatus(h.status));
          if (!candidate) {
            setError(
              'The create request timed out before GoatTown answered, and no new session is visible yet — check Past investigations in a moment.',
            );
            return;
          }
          attach(candidate.id, candidate.status);
          await saveSessionState(member, { activeId: candidate.id, draft: '' });
          setDraft('');
          setError(
            `The create request timed out client-side, but GoatTown did start the session — attached to ${candidate.id.slice(0, 8)}…`,
          );
          void refreshHistory(connection, member);
        } catch (reconcileErr) {
          setError(
            `The create request timed out and reconciling history failed: ${reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr)}`,
          );
        }
      } finally {
        setBusy(null);
      }
    },
    [busy, refreshHistory],
  );

  // An explicit Investigate action (entity button or ?q= link) starts
  // exactly once; it is consumed so reload/mount never restarts work.
  useEffect(() => {
    if (!seed || !conn || !memberId || busy) return;
    if (consumedSeed.current === seed.question) return;
    consumedSeed.current = seed.question;
    const question = seed.question;
    consumeSeed();
    void startInvestigation(question, conn, memberId);
  }, [seed, conn, memberId, busy, consumeSeed, startInvestigation]);

  const sendFollowUp = useCallback(async () => {
    if (!conn || !memberId || !activeId || !draft.trim()) return;
    setBusy('sending');
    setError(null);
    const content = draft.trim();
    setEntries((prev) => [...prev, { kind: 'user', id: `local-${Date.now()}`, content }]);
    setDraft('');
    try {
      await sendMessage(conn, memberId, activeId, content);
      setStatus('running');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus((prev) => prev ?? 'idle');
    } finally {
      setBusy(null);
    }
  }, [conn, memberId, activeId, draft]);

  const doLifecycle = useCallback(
    async (action: LifecycleAction) => {
      if (!conn || !memberId || !activeId) return;
      setError(null);
      try {
        await runLifecycle(conn, memberId, activeId, action);
        if (action === 'stop') setStatus('cancelled');
        if (action === 'close') {
          feedRef.current?.stop();
          setStatus('cancelled');
          setActiveId(null);
          setEntries([]);
          await saveSessionState(memberId, { activeId: null, draft });
        }
        if (action === 'reopen' || action === 'recover') setStatus('idle');
        void refreshHistory(conn, memberId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [conn, memberId, activeId, draft, refreshHistory],
  );

  const doArchive = useCallback(
    async (id: string) => {
      if (!conn || !memberId) return;
      setError(null);
      try {
        await setArchived(conn, memberId, id, true);
        if (id === activeId) {
          feedRef.current?.stop();
          setActiveId(null);
          setEntries([]);
          setStatus(null);
          await saveSessionState(memberId, { activeId: null, draft });
        }
        void refreshHistory(conn, memberId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [conn, memberId, activeId, draft, refreshHistory],
  );

  const doExport = useCallback(async () => {
    if (!transcriptInnerRef.current) return;
    try {
      setExportedPng(await exportAsPng({ element: transcriptInnerRef.current }));
    } catch {
      setError('PNG export failed in this sandbox.');
    }
  }, []);

  const running = status === 'running' || status === 'queued';

  const renderToolCard = (ui: { kind: string } & Record<string, unknown>) => {
    if (ui.kind === 'metrics') return <MetricsToolCard ui={ui as MetricsQueryUi} />;
    if (ui.kind === 'search' || ui.kind === 'summary') return null; // built-in cards
    return (
      <div className={s.unknownCard}>
        <strong>Result ({ui.kind})</strong>
        <pre>{JSON.stringify(ui, null, 2).slice(0, 2000)}</pre>
      </div>
    );
  };

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <h1>
            Network Investigator <small>GoatTown server-side investigation</small>
          </h1>
        </div>
        <div className={s.actions}>
          {activeId && (
            <button onClick={doExport} disabled={entries.length === 0}>
              Export PNG
            </button>
          )}
        </div>
      </header>

      {memberError && <div className={`${s.banner} ${s.bannerError}`}>{memberError}</div>}
      {connLoaded && !conn && !memberError && (
        <div className={s.banner}>
          <strong>GoatTown is not linked.</strong> Set the service URL and save the embed token
          under Configuration → GoatTown connection, then recheck. The token is stored write-only
          in this app's KV and injected server-side by the fetch proxy — until both are set,
          investigations cannot be started and no local fallback runs instead.{' '}
          <button className={s.bannerBtn} onClick={() => void recheckConnection()}>
            Recheck connection
          </button>
        </div>
      )}
      {error && <div className={`${s.banner} ${s.bannerError}`}>{error}</div>}
      {approvalNotice && (
        <div className={`${s.banner} ${s.bannerWarn}`}>
          This investigation has a pending tool approval. Approvals are resolved by GoatTown's
          runtime — they cannot be granted from this page.
        </div>
      )}

      <div className={s.grid}>
        <section className={s.chat}>
          <div className={s.chatHeader}>
            <span className={s.chatTitle}>{activeTitle ?? 'New investigation'}</span>
            {status && <span className={`${s.chip} ${s[`chip_${status}`] ?? ''}`}>{STATUS_LABEL[status] ?? status}</span>}
            <span className={s.spacer} />
            {conn && memberId && activeId && status === 'running' && caps.stop !== false && (
              <button onClick={() => void doLifecycle('stop')}>Stop</button>
            )}
            {conn && memberId && activeId && status === 'idle' && caps.close && (
              <button onClick={() => void doLifecycle('close')}>Close</button>
            )}
            {conn && memberId && activeId && (status === 'cancelled' || status === 'concluded') && caps.reopen && (
              <button onClick={() => void doLifecycle('reopen')}>Reopen</button>
            )}
            {conn && memberId && activeId && status === 'failed' && caps.recover && (
              <button onClick={() => void doLifecycle('recover')}>Recover</button>
            )}
          </div>

          <div className={s.transcript}>
            <div className={s.transcriptInner} ref={transcriptInnerRef}>
              {entries.length === 0 && !running ? (
                <div className={s.emptyState}>
                  <div className={s.emptyTitle}>Investigate your network</div>
                  <div className={s.emptyHint}>
                    Server-side investigations run as durable GoatTown sessions — ask about
                    clients, APs, switches, WAN health, or anything the network did. Start from one
                    of these:
                  </div>
                  <div className={s.suggestions}>
                    {SUGGESTED_QUESTIONS.map((suggestion) => (
                      <button
                        key={suggestion}
                        className={s.suggestion}
                        disabled={!conn || !memberId || busy !== null}
                        onClick={() => {
                          if (conn && memberId) void startInvestigation(suggestion, conn, memberId);
                        }}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <InvestigatorTranscript
                  entries={entries}
                  renderToolCard={renderToolCard}
                  running={running}
                  onApprove={() => setApprovalNotice(true)}
                  onSkip={() => setApprovalNotice(true)}
                />
              )}
            </div>
          </div>

          <div className={s.composer}>
            <textarea
              className={s.composerTextarea}
              rows={2}
              placeholder={
                conn && memberId
                  ? activeId
                    ? 'Ask a follow-up…'
                    : 'Describe what to investigate…'
                  : 'Link GoatTown to start investigations'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={!conn || !memberId || busy === 'creating'}
            />
            {activeId ? (
              <button
                className={s.send}
                onClick={() => void sendFollowUp()}
                disabled={
                  !conn ||
                  !memberId ||
                  busy !== null ||
                  running ||
                  !draft.trim() ||
                  caps.followUp === false
                }
              >
                {busy === 'sending' ? 'Sending…' : 'Send'}
              </button>
            ) : (
              <button
                className={s.send}
                onClick={() => conn && memberId && void startInvestigation(draft.trim(), conn, memberId)}
                disabled={!conn || !memberId || busy !== null || !draft.trim()}
              >
                {busy === 'creating' ? 'Starting…' : 'Investigate'}
              </button>
            )}
          </div>
        </section>

        <aside className={s.side}>
          <div className={s.connectionCard}>
            <h2>Connection</h2>
            {conn ? (
              <>
                <div className={s.connRow}>
                  <span>Service</span>
                  <code>{conn.serviceUrl}</code>
                </div>
                <div className={s.connRow}>
                  <span>Agent</span>
                  <code>{conn.agent}</code>
                </div>
                <div className={`${s.chip} ${s.chip_concluded}`}>linked</div>
              </>
            ) : (
              <p className={s.connHint}>
                Not linked. Configure the service URL on the Configuration page; the embed token is
                provisioned by an administrator in KV.
              </p>
            )}
          </div>

          <div className={s.historyCard}>
            <h2>Past investigations</h2>
            {history.length === 0 ? (
              <p className={s.connHint}>No sessions yet.</p>
            ) : (
              <ul className={s.historyList}>
                {history.map((item) => (
                  <li key={item.id} className={item.id === activeId ? s.historyActive : undefined}>
                    <button
                      className={s.historyItem}
                      disabled={busy === 'switching' || !conn || !memberId}
                      title={item.title}
                      onClick={() => conn && memberId && void attach(conn, memberId, item.id)}
                    >
                      <span className={s.historyTitle}>{item.title}</span>
                      <span className={s.historyMeta}>
                        <span className={`${s.chip} ${s[`chip_${item.status}`] ?? ''}`}>
                          {STATUS_LABEL[item.status] ?? item.status}
                        </span>
                        <time>{new Date(item.createdAt).toLocaleString()}</time>
                      </span>
                    </button>
                    {(item.status === 'concluded' ||
                      item.status === 'failed' ||
                      item.status === 'cancelled') &&
                      caps.archive && (
                        <button
                          className={s.archiveBtn}
                          title="Archive"
                          onClick={() => void doArchive(item.id)}
                        >
                          ×
                        </button>
                      )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {exportedPng && (
        <div className={s.exportOverlay} onClick={() => setExportedPng(null)}>
          <div className={s.exportCard} onClick={(e) => e.stopPropagation()}>
            <div className={s.exportHint}>
              Right-click or long-press to copy the image (downloads are blocked in this sandbox).
              <button onClick={() => setExportedPng(null)}>Close</button>
            </div>
            <img src={exportedPng} alt="Investigation export" className={s.exportImg} />
          </div>
        </div>
      )}
    </div>
  );
}

/** foldWireEvents that never throws mid-render: a malformed event is
 *  dropped rather than taking the transcript down. */
function foldSafe(
  prev: InvestigatorTranscriptEntry[],
  ev: WireLoopEvent,
): InvestigatorTranscriptEntry[] {
  try {
    return foldWireEvents(prev, ev);
  } catch {
    return prev;
  }
}
