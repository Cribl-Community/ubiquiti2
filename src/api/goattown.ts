/**
 * GoatTown server-side investigator transport — the one module that
 * talks to GoatTown. The agent loop runs server-side on durable
 * sessions; this module owns connection metadata, the wire operations,
 * bounded polling, and the wire→transcript folding that feeds the
 * framework's InvestigatorTranscript. No UI lives here.
 *
 * Wire protocol: @criblio/agent-protocol (v1). Operations per the
 * embed-agent recipe: /investigations create/list, per-session
 * status/events/messages and lifecycle. Auth is injected by the fetch
 * proxy (proxies.yml → kv.goattownEmbedToken); browser code never sees
 * the token and only forwards the x-goattown-user member claim.
 */
import type { SessionStatus, WireLoopEvent } from '@criblio/agent-protocol';
import { isTerminalStatus } from '@criblio/agent-protocol';
import {
  applyLoopEvent,
  type InvestigatorTranscriptEntry,
} from '@criblio/app-utils/investigator';
import type { LoopEvent } from '@criblio/app-utils/agent-loop';

export const DEFAULT_AGENT = 'investigator';

const CONNECTION_KEY = 'goattown/connection';
const sessionsKey = (memberId: string) => `goattown/sessions/${memberId}`;
const REQUEST_TIMEOUT_MS = 25_000; // host proxy cuts off at 30s
const RUNNING_POLL_MS = 4_000;
const IDLE_POLL_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_BACKFILL_PAGES = 10;

const apiUrl = () => window.CRIBL_API_URL ?? '/api/v1';

// ─────────────────────────────────────────────────────────────────
// App KV (text/plain — a JSON content-type round-trips [object Object])
// ─────────────────────────────────────────────────────────────────

async function kvGet(key: string): Promise<string | null> {
  const resp = await fetch(`${apiUrl()}/kvstore/${key}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`KV read failed (${resp.status})`);
  return resp.text();
}

async function kvPut(key: string, value: string): Promise<void> {
  const put = (k: string) =>
    fetch(`${apiUrl()}/kvstore/${k}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: value,
    });
  const resp = await put(key);
  if (resp.ok) return;
  if (resp.status === 404) {
    // Cribl KV requires intermediate path segments to exist (PUT
    // goattown/sessions/{id} 404s unless goattown/sessions does). A
    // reinstall can clear them — recreate the missing parents, then retry.
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const r = await fetch(`${apiUrl()}/kvstore/${parent}`, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: '',
      });
      if (!r.ok && r.status !== 404) throw new Error(`KV write failed (${r.status})`);
    }
    const retry = await put(key);
    if (retry.ok) return;
    throw new Error(`KV write failed (${retry.status})`);
  }
  throw new Error(`KV write failed (${resp.status})`);
}

// ─────────────────────────────────────────────────────────────────
// Network map — mesh backhaul (child AP → parent AP)
// ─────────────────────────────────────────────────────────────────

/** The Unifi Poller's Prometheus export carries no wireless-uplink
 *  identity: every topology row is link_type="WIRED" and the uplink
 *  metrics expose no parent MAC/name. Mesh parents are therefore
 *  user-configured in Settings and stored as plain text. */
const MESH_KEY = 'network/mesh-links';

export async function loadMeshLinksText(): Promise<string | null> {
  return kvGet(MESH_KEY);
}

export async function saveMeshLinksText(text: string): Promise<void> {
  return kvPut(MESH_KEY, text.trim());
}

/** Parse `child = parent` lines (`->` and `→` accepted too). Blank
 *  lines and `#` comments are ignored. */
export function parseMeshLinks(text: string | null): Array<[child: string, parent: string]> {
  if (!text) return [];
  const out: Array<[string, string]> = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(.+?)\s*(?:->|=|→)\s*(.+)$/);
    if (m) out.push([m[1].trim(), m[2].trim()]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Connection metadata (public — the token is proxy-injected, not here)
// ─────────────────────────────────────────────────────────────────

export interface GoatTownConnection {
  serviceUrl: string;
  agent: string;
}

const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, '');

export async function loadConnection(): Promise<GoatTownConnection | null> {
  try {
    const raw = await kvGet(CONNECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { serviceUrl?: string; agent?: string };
    const serviceUrl = normalizeUrl(parsed.serviceUrl ?? '');
    if (!serviceUrl) return null;
    return { serviceUrl, agent: (parsed.agent ?? '').trim() || DEFAULT_AGENT };
  } catch {
    return null;
  }
}

export async function saveConnection(serviceUrl: string, agent: string): Promise<void> {
  const normalized = normalizeUrl(serviceUrl);
  if (!normalized) throw new Error('Service URL is required — refusing to save an empty connection.');
  await kvPut(
    CONNECTION_KEY,
    JSON.stringify({
      version: 1,
      serviceUrl: normalized,
      agent: agent.trim() || DEFAULT_AGENT,
    }),
  );
}

/** The embed token is a write-only credential: it lands in the app's
 *  scoped KV and is resolved by the fetch proxy at request time
 *  (proxies.yml: `authorization: "'Bearer ' + kv.goattownEmbedToken"`).
 *  It is never read back into the browser. */
export async function saveEmbedToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Token is empty — nothing to save.');
  await kvPut('goattownEmbedToken', trimmed);
}

/** Key NAMES only (POST /kvstore/keys) — enough to verify that the
 *  connection record and the write-only token actually exist in the
 *  app's KV namespace without ever pulling the token's value back. */
export async function listKvKeys(prefix: string): Promise<string[]> {
  const resp = await fetch(`${apiUrl()}/kvstore/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefix }),
  });
  if (!resp.ok) throw new Error(`KV key list failed (${resp.status})`);
  const data = (await resp.json()) as unknown;
  const rows: unknown[] = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null
      ? ((data as { results?: unknown[]; keys?: unknown[] }).results ??
        (data as { keys?: unknown[] }).keys ??
        [])
      : [];
  return rows
    .map((row) =>
      typeof row === 'string' ? row : ((row as { key?: string; name?: string })?.key ?? (row as { name?: string })?.name ?? ''),
    )
    .filter((k): k is string => typeof k === 'string' && k.length > 0);
}

export interface RawConnectionRead {
  status: number;
  body: string;
  connection: GoatTownConnection | null;
  parseError: string | null;
}

/** The exact GET behind loadConnection, exposed for diagnostics. */
export async function readConnectionRaw(): Promise<RawConnectionRead> {
  let status = 0;
  let body = '';
  try {
    const resp = await fetch(`${apiUrl()}/kvstore/goattown/connection`);
    status = resp.status;
    body = (await resp.text()).slice(0, 300);
  } catch (e) {
    return {
      status: 0,
      body: e instanceof Error ? e.message : String(e),
      connection: null,
      parseError: 'fetch failed',
    };
  }
  if (status === 404) return { status, body, connection: null, parseError: null };
  const trimmed = body.trim();
  if (!trimmed || trimmed === '[object Object]') {
    return {
      status,
      body,
      connection: null,
      parseError: trimmed
        ? 'KV value is not JSON — it was probably stored with a JSON content-type (served back as [object Object])'
        : 'KV value is empty',
    };
  }
  try {
    const parsed = JSON.parse(trimmed) as { serviceUrl?: string; agent?: string };
    const serviceUrl = normalizeUrl(parsed.serviceUrl ?? '');
    if (!serviceUrl)
      return { status, body, connection: null, parseError: 'saved JSON carries no serviceUrl' };
    return {
      status,
      body,
      connection: { serviceUrl, agent: (parsed.agent ?? '').trim() || DEFAULT_AGENT },
      parseError: null,
    };
  } catch (e) {
    return {
      status,
      body,
      connection: null,
      parseError: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export interface ConnectionDiagnostics {
  connection: GoatTownConnection | null;
  connectionKeyExists: boolean | null;
  tokenKeyExists: boolean | null;
  rawRead: RawConnectionRead | null;
  error: string | null;
}

/** What the Investigate page and Settings page both show: is the
 *  connection saved, is the token saved, and did anything fail. */
export async function connectionDiagnostics(): Promise<ConnectionDiagnostics> {
  const diag: ConnectionDiagnostics = {
    connection: null,
    connectionKeyExists: null,
    tokenKeyExists: null,
    rawRead: null,
    error: null,
  };
  try {
    const [connKeys, tokenKeys] = await Promise.all([
      listKvKeys('goattown'),
      listKvKeys('goattownEmbedToken'),
    ]);
    diag.connectionKeyExists = connKeys.includes('goattown/connection');
    diag.tokenKeyExists = tokenKeys.includes('goattownEmbedToken');
  } catch (e) {
    diag.error = e instanceof Error ? e.message : String(e);
  }
  diag.rawRead = await readConnectionRaw();
  diag.connection = diag.rawRead.connection;
  return diag;
}

// ─────────────────────────────────────────────────────────────────
// Member-scoped session state (active session + composer draft)
// ─────────────────────────────────────────────────────────────────

export interface SessionState {
  activeId: string | null;
  draft: string;
}

export async function loadSessionState(memberId: string): Promise<SessionState> {
  try {
    const raw = await kvGet(sessionsKey(memberId));
    if (!raw) return { activeId: null, draft: '' };
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    return {
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
      draft: typeof parsed.draft === 'string' ? parsed.draft : '',
    };
  } catch {
    return { activeId: null, draft: '' };
  }
}

export async function saveSessionState(memberId: string, state: SessionState): Promise<void> {
  await kvPut(sessionsKey(memberId), JSON.stringify(state));
}

// ─────────────────────────────────────────────────────────────────
// Identity — attribution claim, not authorization
// ─────────────────────────────────────────────────────────────────

export async function memberClaim(): Promise<string> {
  const get = (window as { getCriblUser?: () => Promise<{ id?: string; username?: string }> })
    .getCriblUser;
  if (typeof get !== 'function') {
    throw new Error(
      'Signed-in user is unavailable — GoatTown sessions require window.getCriblUser() for attribution.',
    );
  }
  const user = await get();
  const claim = user?.id ?? user?.username ?? '';
  if (!claim) throw new Error('Signed-in user has no stable id — cannot attribute GoatTown sessions.');
  return claim;
}

// ─────────────────────────────────────────────────────────────────
// Wire operations
// ─────────────────────────────────────────────────────────────────

export class GoatTownError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly retryAfterMs: number | null;
  constructor(status: number, detail: string, retryAfterMs: number | null = null) {
    super(detail ? `GoatTown request failed (${status}): ${detail}` : `GoatTown request failed (${status})`);
    this.name = 'GoatTownError';
    this.status = status;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

interface CallInit {
  method: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(
  conn: GoatTownConnection,
  memberId: string,
  path: string,
  init: CallInit,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  init.signal?.addEventListener('abort', onOuterAbort);
  try {
    const resp = await fetch(`${conn.serviceUrl}${path}`, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-goattown-user': memberId,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const retryHeader = Number(resp.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader * 1000 : null;
      const text = (await resp.text()).slice(0, 400);
      throw new GoatTownError(resp.status, text, retryAfterMs);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onOuterAbort);
  }
}

export interface GoatTownCapabilities {
  followUp?: boolean;
  stop?: boolean;
  close?: boolean;
  reopen?: boolean;
  recover?: boolean;
  archive?: boolean;
}

/** Core actions assumed when /protocol is unreachable; anything the
 *  protocol explicitly omits is treated as unsupported. */
const DEFAULT_CAPABILITIES: GoatTownCapabilities = {
  followUp: true,
  stop: true,
  close: true,
  reopen: true,
  archive: true,
};

const CAPABILITY_KEYS = ['followUp', 'stop', 'close', 'reopen', 'recover', 'archive'] as const;

export async function fetchCapabilities(
  conn: GoatTownConnection,
  memberId: string,
): Promise<{ caps: GoatTownCapabilities; authoritative: boolean }> {
  try {
    const data = await request<Record<string, unknown>>(conn, memberId, '/protocol', { method: 'GET' });
    const src = (data.capabilities ?? data) as Record<string, unknown>;
    const caps: GoatTownCapabilities = {};
    for (const key of CAPABILITY_KEYS) {
      if (src[key] === true) caps[key] = true;
    }
    return { caps, authoritative: true };
  } catch {
    return { caps: { ...DEFAULT_CAPABILITIES }, authoritative: false };
  }
}

export interface InvestigationSummary {
  id: string;
  title: string;
  status: SessionStatus;
  mode?: string;
  createdAt: number;
  concludedAt: number | null;
}

export async function listInvestigations(
  conn: GoatTownConnection,
  memberId: string,
  agent: string,
): Promise<InvestigationSummary[]> {
  const data = await request<{ investigations?: unknown }>(
    conn,
    memberId,
    `/investigations?agent=${encodeURIComponent(agent)}`,
    { method: 'GET' },
  );
  const rows = Array.isArray(data.investigations) ? data.investigations : [];
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string')
    .map((r) => ({
      id: String(r.id),
      title: typeof r.title === 'string' && r.title ? r.title : 'Investigation',
      status: (typeof r.status === 'string' ? r.status : 'concluded') as SessionStatus,
      mode: typeof r.mode === 'string' ? r.mode : undefined,
      createdAt: Number(r.createdAt ?? r.created_at ?? 0),
      concludedAt: typeof r.concludedAt === 'number' ? r.concludedAt : null,
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);
}

export async function createInvestigation(
  conn: GoatTownConnection,
  memberId: string,
  input: { agent: string; prompt: string; title: string },
): Promise<{ id: string }> {
  const data = await request<{ id?: string; investigation?: { id?: string } }>(
    conn,
    memberId,
    '/investigations',
    { method: 'POST', body: { agent: input.agent, prompt: input.prompt, title: input.title } },
  );
  const id = data.id ?? data.investigation?.id;
  if (!id) throw new GoatTownError(0, 'Create succeeded but the response carried no investigation id.');
  return { id: String(id) };
}

export interface ObserveBatch {
  status: SessionStatus;
  latestSeq: number;
  events: Array<{ seq: number; ev: WireLoopEvent }>;
  title?: string | null;
}

/** Status + fresh events since a cursor. Older-event responses use
 *  `frames`; tolerate either field name. */
export async function observeInvestigation(
  conn: GoatTownConnection,
  memberId: string,
  id: string,
  eventsSince: number,
  signal?: AbortSignal,
): Promise<ObserveBatch> {
  const data = await request<Record<string, unknown>>(
    conn,
    memberId,
    `/investigations/${encodeURIComponent(id)}/status?eventsSince=${eventsSince}`,
    { method: 'GET', signal },
  );
  return toBatch(data);
}

/** Older-events fallback (GET …/events?since=) used for backfill. */
export async function fetchEvents(
  conn: GoatTownConnection,
  memberId: string,
  id: string,
  since: number,
  signal?: AbortSignal,
): Promise<ObserveBatch> {
  const data = await request<Record<string, unknown>>(
    conn,
    memberId,
    `/investigations/${encodeURIComponent(id)}/events?since=${since}`,
    { method: 'GET', signal },
  );
  return toBatch(data);
}

function toBatch(data: Record<string, unknown>): ObserveBatch {
  const raw = (
    Array.isArray(data.events) ? data.events : Array.isArray(data.frames) ? data.frames : []
  ) as Array<{ seq?: number; ev?: WireLoopEvent }>;
  const events = raw
    .filter((f): f is { seq: number; ev: WireLoopEvent } => !!f && !!f.ev)
    .map((f) => ({ seq: Number(f.seq ?? 0), ev: f.ev }));
  return {
    status: (typeof data.status === 'string' ? data.status : 'running') as SessionStatus,
    latestSeq: Number(data.latestSeq ?? 0),
    events,
    title: typeof data.title === 'string' ? data.title : null,
  };
}

export async function sendMessage(
  conn: GoatTownConnection,
  memberId: string,
  id: string,
  content: string,
): Promise<void> {
  await request(conn, memberId, `/investigations/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: { content },
  });
}

export type LifecycleAction = 'stop' | 'close' | 'reopen' | 'recover';

export async function runLifecycle(
  conn: GoatTownConnection,
  memberId: string,
  id: string,
  action: LifecycleAction,
): Promise<void> {
  await request(conn, memberId, `/investigations/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
  });
}

export async function setArchived(
  conn: GoatTownConnection,
  memberId: string,
  id: string,
  archived: boolean,
): Promise<void> {
  await request(conn, memberId, `/investigations/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
    body: { archived },
  });
}

// ─────────────────────────────────────────────────────────────────
// Wire → transcript folding
// ─────────────────────────────────────────────────────────────────

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

/** Replay a whole session from the older-events endpoint (bounded). */
export async function loadTranscript(
  conn: GoatTownConnection,
  memberId: string,
  id: string,
  signal?: AbortSignal,
): Promise<{ entries: InvestigatorTranscriptEntry[]; status: SessionStatus; latestSeq: number }> {
  let entries: InvestigatorTranscriptEntry[] = [];
  let since = 0;
  let latestSeq = 0;
  let status: SessionStatus = 'running';
  for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
    const batch = await fetchEvents(conn, memberId, id, since, signal);
    latestSeq = Math.max(latestSeq, batch.latestSeq);
    status = batch.status;
    const fresh = batch.events.filter((e) => e.seq > since);
    if (fresh.length === 0) break;
    for (const event of fresh) {
      entries = foldWireEvents(entries, event.ev);
      since = Math.max(since, event.seq);
    }
    if (since >= latestSeq) break;
  }
  return { entries, status, latestSeq };
}

// ─────────────────────────────────────────────────────────────────
// Bounded poller — no overlapping polls, paused hidden pages,
// aborts on stop, stale-response guarded, honors Retry-After.
// ─────────────────────────────────────────────────────────────────

export interface FeedHandlers {
  onBatch: (batch: ObserveBatch) => void;
  onError: (error: Error) => void;
}

export class InvestigationFeed {
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private pollingNow = false;
  private stopped = true;
  private backoffMs = 0;

  constructor(
    private readonly conn: GoatTownConnection,
    private readonly memberId: string,
    private readonly id: string,
    private readonly handlers: FeedHandlers,
  ) {}

  start(fromSeq = 0): void {
    this.cursor = fromSeq;
    this.stopped = false;
    this.backoffMs = 0;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  private onVisibility = (): void => {
    if (this.stopped) return;
    if (document.hidden) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.inFlight?.abort();
      this.inFlight = null;
      this.pollingNow = false;
    } else {
      this.schedule(0);
    }
  };

  private schedule(delayMs: number): void {
    if (this.stopped || document.hidden) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.pollingNow || document.hidden) return;
    this.pollingNow = true;
    this.inFlight = new AbortController();
    let nextDelayMs = IDLE_POLL_MS;
    let terminal = false;
    try {
      const batch = await observeInvestigation(
        this.conn,
        this.memberId,
        this.id,
        this.cursor,
        this.inFlight.signal,
      );
      const fresh = batch.events.filter((e) => e.seq > this.cursor);
      for (const event of fresh) this.cursor = Math.max(this.cursor, event.seq);
      this.backoffMs = 0;
      nextDelayMs =
        batch.status === 'running' || batch.status === 'queued' ? RUNNING_POLL_MS : IDLE_POLL_MS;
      terminal = isTerminalStatus(batch.status);
      this.handlers.onBatch({ ...batch, events: fresh });
    } catch (error) {
      if (this.stopped || (error instanceof DOMException && error.name === 'AbortError')) return;
      this.handlers.onError(error instanceof Error ? error : new Error(String(error)));
      const retryAfter = error instanceof GoatTownError ? error.retryAfterMs : null;
      this.backoffMs = Math.min(this.backoffMs ? this.backoffMs * 2 : RUNNING_POLL_MS, MAX_BACKOFF_MS);
      nextDelayMs = Math.max(this.backoffMs, retryAfter ?? 0);
    } finally {
      this.pollingNow = false;
      this.inFlight = null;
    }
    if (!terminal && !this.stopped) this.schedule(nextDelayMs);
  }
}
