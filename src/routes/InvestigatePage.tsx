import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  InvestigatorTranscript,
  type InvestigatorTranscriptEntry,
} from '@criblio/app-utils/investigator';
import { exportAsPng } from '@criblio/app-utils/investigator';
import MetricsToolCard from '@criblio/app-utils/investigator/metrics-tool-card';
import type { MetricsQueryUi } from '@criblio/app-utils/agent-tools';
import {
  GoatTownError,
  observeSession,
  type GoatTownClient,
} from '@criblio/app-utils/goattown';
import { titleFromPrompt, isTerminalStatus } from '@criblio/agent-protocol';
import type { SessionStatus, SessionSummaryRow } from '@criblio/agent-protocol';
import { buildServerPrompt, SUGGESTED_QUESTIONS } from '../api/investigator';
import { foldEvent, foldUserTurn } from '../api/transcript';
import {
  connectionDiagnostics,
  createClient,
  DEFAULT_AGENT,
  loadConnection,
  loadSessionState,
  memberClaim,
  saveSessionState,
  sessionCapabilities,
  type GoatTownCapabilities,
  type GoatTownConnection,
} from '../api/goattown';
import s from './InvestigatePage.module.css';

/** Default context window: the last hour, snapshotted absolutely. */
const contextWindow = () => ({ earliestMs: Date.now() - 3_600_000, latestMs: Date.now() });

type LifecycleAction = 'stop' | 'close' | 'reopen' | 'recover';

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
  const [history, setHistory] = useState<SessionSummaryRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
  const [entries, setEntries] = useState<InvestigatorTranscriptEntry[]>([]);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'creating' | 'sending' | 'switching' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvalNotice, setApprovalNotice] = useState(false);
  const [exportedPng, setExportedPng] = useState<string | null>(null);

  /** Transcript observer for the session on screen. Observation runs until
   *  the turn's receipt drains; leaving the page or switching sessions
   *  aborts it. */
  const observeRef = useRef<AbortController | null>(null);
  /** Last consumed seq, so a follow-up resumes instead of replaying. */
  const cursorRef = useRef(0);
  const transcriptInnerRef = useRef<HTMLDivElement | null>(null);
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consumedSeed = useRef<string | null>(null);

  /** The framework client for the saved connection. Identity is resolved per
   *  call and sent as x-goattown-user. */
  const handle = useMemo(
    () => (conn ? createClient(conn, memberId ?? undefined) : null),
    [conn, memberId],
  );
  const client = handle?.client ?? null;

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

  const refreshHistory = useCallback(async (gt: GoatTownClient) => {
    try {
      setHistory(await gt.listSessions({ agent: DEFAULT_AGENT, limit: 25 }));
    } catch {
      /* history is best-effort; the banner shows hard failures */
    }
  }, []);

  /**
   * Follow a session's transcript.
   *
   * `requestId` pins observation to one turn's receipt — the turn this page
   * just started — while omitting it follows whatever the service last
   * accepted, which is what reattaching to an existing session wants.
   * `seed` replaces the transcript before replaying; without it the observer
   * resumes from the cursor already consumed, so a follow-up appends instead
   * of replaying the whole session.
   */
  const follow = useCallback(
    async (
      gt: GoatTownClient,
      sessionId: string,
      opts: { requestId?: string; seed?: InvestigatorTranscriptEntry[] } = {},
    ) => {
      observeRef.current?.abort();
      const controller = new AbortController();
      observeRef.current = controller;
      if (opts.seed) {
        cursorRef.current = 0;
        setEntries(opts.seed);
      }
      const result = await observeSession(gt, sessionId, {
        since: opts.seed ? 0 : cursorRef.current,
        requestId: opts.requestId,
        signal: controller.signal,
        onEvent: (ev) => setEntries((prev) => foldEvent(prev, ev)),
        onUserMessage: (content, seq) => setEntries((prev) => foldUserTurn(prev, content, seq)),
        onStatus: setStatus,
        onCursor: (seq) => {
          cursorRef.current = seq;
        },
        onError: (err) => setError(err instanceof Error ? err.message : String(err)),
      });
      cursorRef.current = result.cursor;
      setStatus(result.status);
      if (result.reason === 'stalled') {
        setError(
          'GoatTown stopped delivering events for this turn — the transcript below may be incomplete.',
        );
      }
      if (isTerminalStatus(result.status)) void refreshHistory(gt);
      return result;
    },
    [refreshHistory],
  );

  const attach = useCallback(
    async (gt: GoatTownClient, id: string, title?: string) => {
      setBusy('switching');
      setError(null);
      setActiveId(id);
      setActiveTitle(title ?? null);
      try {
        await follow(gt, id, { seed: [] });
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setBusy(null);
      }
    },
    [follow],
  );

  // Re-read the connection after the user links GoatTown on the
  // Configuration page, without a full page reload — and say exactly
  // what is missing when it is still unlinked.
  const recheckConnection = useCallback(async () => {
    setError(null);
    const diag = await connectionDiagnostics();
    setConn(diag.connection);
    if (!diag.connection) {
      if (diag.readError) setError(`GoatTown link check failed: ${diag.readError}`);
      else if (diag.error) setError(`GoatTown link check failed: ${diag.error}`);
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
      else setError('A GoatTown connection is saved but could not be read back.');
      return;
    }
    const gt = createClient(diag.connection, memberId ?? undefined);
    void sessionCapabilities(gt.client, { refresh: true })
      .then(setCaps)
      .catch(() => setCaps({}));
    void refreshHistory(gt.client);
    if (memberId) {
      const state = await loadSessionState(memberId);
      setDraft((prev) => prev || state.draft);
      if (state.activeId) {
        const row = history.find((h) => h.id === state.activeId);
        await attach(gt.client, state.activeId, row?.title);
      }
    }
  }, [memberId, attach, refreshHistory, history]);

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
        const gt = createClient(connection, member);
        void sessionCapabilities(gt.client).then((c) => !cancelled && setCaps(c)).catch(() => undefined);
        void refreshHistory(gt.client);
        const state = await loadSessionState(member);
        if (cancelled) return;
        setDraft(state.draft);
        if (state.activeId) await attach(gt.client, state.activeId);
      } catch (err) {
        if (!cancelled) {
          setConnLoaded(true);
          setMemberError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
      observeRef.current?.abort();
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
    async (question: string) => {
      if (!client || !memberId || busy) return;
      setBusy('creating');
      setError(null);
      const window = contextWindow();
      const entity = question.match(/(?:access point|switch|client|gateway)\s+"([^"]+)"/i)?.[1];
      const title = titleFromPrompt(question);
      const seed: InvestigatorTranscriptEntry[] = [
        { kind: 'user', id: `local-${Date.now()}`, content: question },
      ];
      const start = async (id: string, initialStatus: SessionStatus, sessionTitle?: string) => {
        setActiveId(id);
        setActiveTitle(sessionTitle ?? title);
        setStatus(initialStatus);
        /* Session-pointer persistence is best-effort: a KV failure must
           never detach or blank a live investigation. */
        await saveSessionState(memberId, { activeId: id, draft: '' }).catch(() => undefined);
        setDraft('');
        void refreshHistory(client);
      };
      try {
        const receipt = await client.createSession({
          prompt: buildServerPrompt({ question }, { entity, ...window }),
          agent: DEFAULT_AGENT,
          title,
        });
        await start(receipt.id, 'queued', receipt.title);
        await follow(client, receipt.id, { requestId: receipt.requestId, seed });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const gtErr = err instanceof GoatTownError ? err : null;
        // An answer we can act on (4xx) is a real failure and must not be
        // reconciled into "maybe it started anyway".
        if (gtErr && gtErr.status >= 400 && gtErr.status < 500) {
          setError(
            gtErr.isPermanentAuthFailure
              ? `${message} — the GoatTown host may be missing from config/proxies.yml, or the embed token is not provisioned.`
              : message,
          );
          return;
        }
        // Ambiguous create: no usable answer came back (a proxy timeout or a
        // dropped connection), but GoatTown may have created the session
        // anyway. Reconcile against server history instead of retrying — a
        // retry would start a second session.
        try {
          const history = await client.listSessions({ agent: DEFAULT_AGENT, limit: 25 });
          const recent = (ts: number) =>
            Date.now() - ts < 10 * 60_000 || Date.now() / 1000 - ts < 600;
          const candidate = history.find((h) => recent(h.createdAt) && !isTerminalStatus(h.status));
          if (!candidate) {
            setError(
              'The create request timed out before GoatTown answered, and no new session is visible yet — check Past investigations in a moment.',
            );
            return;
          }
          await start(candidate.id, candidate.status, candidate.title);
          await follow(client, candidate.id, { seed });
          setError(
            `The create request timed out client-side, but GoatTown did start the session — attached to ${candidate.id.slice(0, 8)}…`,
          );
          void refreshHistory(client);
        } catch (reconcileErr) {
          setError(
            `The create request timed out and reconciling history failed: ${reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr)}`,
          );
        }
      } finally {
        setBusy(null);
      }
    },
    [busy, client, memberId, follow, refreshHistory],
  );

  // An explicit Investigate action (entity button or ?q= link) starts
  // exactly once; it is consumed so reload/mount never restarts work.
  useEffect(() => {
    if (!seed || !client || !memberId || busy) return;
    if (consumedSeed.current === seed.question) return;
    consumedSeed.current = seed.question;
    const question = seed.question;
    consumeSeed();
    void startInvestigation(question);
  }, [seed, client, memberId, busy, consumeSeed, startInvestigation]);

  const sendFollowUp = useCallback(async () => {
    if (!client || !memberId || !activeId || !draft.trim()) return;
    setBusy('sending');
    setError(null);
    const content = draft.trim();
    setEntries((prev) => [...prev, { kind: 'user', id: `local-${Date.now()}`, content }]);
    setDraft('');
    try {
      const receipt = await client.sendMessage(activeId, content);
      setStatus('running');
      await follow(client, activeId, { requestId: receipt.requestId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus((prev) => prev ?? 'idle');
    } finally {
      setBusy(null);
    }
  }, [client, memberId, activeId, draft, follow]);

  const doLifecycle = useCallback(
    async (action: LifecycleAction) => {
      if (!client || !memberId || !activeId) return;
      setError(null);
      try {
        const { status: next } = await client[action](activeId);
        if (action === 'close') {
          observeRef.current?.abort();
          setActiveId(null);
          setEntries([]);
          setStatus(null);
          await saveSessionState(memberId, { activeId: null, draft }).catch(() => undefined);
        } else {
          setStatus(next);
        }
        void refreshHistory(client);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, memberId, activeId, draft, refreshHistory],
  );

  const doArchive = useCallback(
    async (id: string) => {
      if (!client || !memberId) return;
      setError(null);
      try {
        await client.archive(id);
        if (id === activeId) {
          observeRef.current?.abort();
          setActiveId(null);
          setEntries([]);
          setStatus(null);
          await saveSessionState(memberId, { activeId: null, draft }).catch(() => undefined);
        }
        void refreshHistory(client);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, memberId, activeId, draft, refreshHistory],
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
    // search, summary, code (0.8.5+), and report (0.8.6+) render as
    // framework built-ins.
    if (ui.kind === 'search' || ui.kind === 'summary' || ui.kind === 'code' || ui.kind === 'report') {
      return null;
    }
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
            {client && memberId && activeId && status === 'running' && caps.stop !== false && (
              <button onClick={() => void doLifecycle('stop')}>Stop</button>
            )}
            {client && memberId && activeId && status === 'idle' && caps.close && (
              <button onClick={() => void doLifecycle('close')}>Close</button>
            )}
            {client && memberId && activeId && (status === 'cancelled' || status === 'concluded') && caps.reopen && (
              <button onClick={() => void doLifecycle('reopen')}>Reopen</button>
            )}
            {client && memberId && activeId && status === 'failed' && caps.recover && (
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
                        disabled={!client || !memberId || busy !== null}
                        onClick={() => {
                          void startInvestigation(suggestion);
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
                client && memberId
                  ? activeId
                    ? 'Ask a follow-up…'
                    : 'Describe what to investigate…'
                  : 'Link GoatTown to start investigations'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={!client || !memberId || busy === 'creating'}
            />
            {activeId ? (
              <button
                className={s.send}
                onClick={() => void sendFollowUp()}
                disabled={
                  !client ||
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
                onClick={() => void startInvestigation(draft.trim())}
                disabled={!client || !memberId || busy !== null || !draft.trim()}
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
                      disabled={busy === 'switching' || !client || !memberId}
                      title={item.title}
                      onClick={() => {
                        if (client) void attach(client, item.id, item.title);
                      }}
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
