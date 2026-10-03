/**
 * GoatTown connection and per-member state.
 *
 * The session TRANSPORT is the framework's: this module used to carry a
 * hand-written client, poller, wire mapper and KV layer, all of which now
 * live in `@criblio/app-utils/goattown` (`GoatTownClient`, `observeSession`,
 * `runRequest`, `sendAndRun`, `SessionDiagnostics`) and
 * `@criblio/app-utils/kv`. What remains here is only what is specific to
 * this app:
 *
 *   - the saved connection record (`goattown/connection`) and the write-only
 *     credential key that `config/proxies.yml` injects from;
 *   - the per-member session pointer and composer draft;
 *   - the connection diagnostics the Investigate and Configuration pages
 *     show.
 *
 * Import the framework by SUBPATH, never from the package root: the root
 * re-exports Node-only modules (`dotenv` → `node:fs/promises`) and the
 * browser build dies on the resolution, which tsc does not catch.
 */
import {
  GoatTownClient,
  SessionDiagnostics,
  type ProtocolResponse,
} from '@criblio/app-utils/goattown';
import {
  KvError,
  kvGetJson,
  kvPutJson,
  kvPutText,
  memberKey,
} from '@criblio/app-utils/kv';

export const DEFAULT_AGENT = 'investigator';

/** Public connection record. Read by the pages; written by the setup flow. */
const CONNECTION_KEY = 'goattown/connection';
/** Credential key. Named here because `config/proxies.yml` reads it. */
const TOKEN_KEY = 'goattownEmbedToken';

const apiUrl = () => window.CRIBL_API_URL ?? '/api/v1';

/**
 * Write app KV, recreating missing parent segments.
 *
 * Cribl's KV store requires the intermediate path segments of a key to exist
 * (a PUT to `goattown/session/<memberId>` 404s until `goattown` does); the framework's
 * writer reports that honestly as a `KvError` instead of hiding it, and this
 * wrapper adds the parents and retries once. The final write is never
 * swallowed — a failure there is the caller's to see.
 */
async function writeKv(write: () => Promise<void>, key: string): Promise<void> {
  try {
    await write();
    return;
  } catch (error) {
    if (!(error instanceof KvError) || error.status !== 404) throw error;
  }
  const parts = key.split('/');
  for (let i = 1; i < parts.length; i++) {
    try {
      await kvPutText(parts.slice(0, i).join('/'), '');
    } catch {
      /* A parent that already exists, or cannot be created, is reported by
         the retry below rather than here. */
    }
  }
  await write();
}

const putKvJson = (key: string, value: unknown) => writeKv(() => kvPutJson(key, value), key);

// ─────────────────────────────────────────────────────────────────
// Connection metadata (public — the token is proxy-injected, not here)
// ─────────────────────────────────────────────────────────────────

export interface GoatTownConnection {
  serviceUrl: string;
  agent: string;
}

const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, '');

export async function loadConnection(): Promise<GoatTownConnection | null> {
  const read = await kvGetJson<{ serviceUrl?: string; agent?: string }>(CONNECTION_KEY);
  if (!read.found) return null;
  const serviceUrl = normalizeUrl(read.value.serviceUrl ?? '');
  if (!serviceUrl) return null;
  return { serviceUrl, agent: (read.value.agent ?? '').trim() || DEFAULT_AGENT };
}

/** Save the public part of the connection. The credential is separate and
 *  write-only; see {@link saveEmbedToken}. */
export async function saveConnection(serviceUrl: string, agent: string): Promise<void> {
  const normalized = normalizeUrl(serviceUrl);
  if (!normalized) throw new Error('Service URL is required — refusing to save an empty connection.');
  await putKvJson(CONNECTION_KEY, {
    version: 1,
    serviceUrl: normalized,
    agent: agent.trim() || DEFAULT_AGENT,
  });
}

/**
 * Store the embed token.
 *
 * Write-only by design: the value lands in the app's scoped KV, the fetch
 * proxy injects it as `authorization` for the declared host
 * (`config/proxies.yml` → `kv.goattownEmbedToken`), and it is never read back
 * into the browser. The framework's writer reports a rejected save instead of
 * letting it look successful.
 */
export async function saveEmbedToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Token is empty — nothing to save.');
  await kvPutText(TOKEN_KEY, trimmed);
}

/** Key NAMES only (POST /kvstore/keys) — enough to show that the connection
 *  record and the write-only credential exist without reading the credential
 *  back. */
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
      typeof row === 'string'
        ? row
        : ((row as { key?: string; name?: string })?.key ?? (row as { name?: string })?.name ?? ''),
    )
    .filter((k): k is string => typeof k === 'string' && k.length > 0);
}

export interface ConnectionDiagnostics {
  connection: GoatTownConnection | null;
  connectionKeyExists: boolean | null;
  tokenKeyExists: boolean | null;
  /** Why the saved record could not be read, described from the framework's
   *  typed KV failure (status and body kind — a routing failure reads like
   *  one) and never from the stored value. */
  readError: string | null;
  /** Why the key listing failed, if it did. */
  error: string | null;
}

/** What the Investigate and Configuration pages both show: is the connection
 *  saved, is the credential saved, and did anything fail. */
export async function connectionDiagnostics(): Promise<ConnectionDiagnostics> {
  const diag: ConnectionDiagnostics = {
    connection: null,
    connectionKeyExists: null,
    tokenKeyExists: null,
    readError: null,
    error: null,
  };
  try {
    const [connKeys, tokenKeys] = await Promise.all([
      listKvKeys('goattown'),
      listKvKeys(TOKEN_KEY),
    ]);
    diag.connectionKeyExists = connKeys.includes(CONNECTION_KEY);
    diag.tokenKeyExists = tokenKeys.includes(TOKEN_KEY);
  } catch (e) {
    diag.error = e instanceof Error ? e.message : String(e);
  }
  try {
    diag.connection = await loadConnection();
  } catch (e) {
    // Absence is not an error here: a genuinely missing key reads as
    // `{found:false}` and yields null. Anything thrown is a misroute, a
    // rejected read or an unparseable body, and it must not read as "unset".
    diag.readError = e instanceof KvError ? e.message : e instanceof Error ? e.message : String(e);
  }
  return diag;
}

// ─────────────────────────────────────────────────────────────────
// Member-scoped session state (active session + composer draft)
// ─────────────────────────────────────────────────────────────────

export interface SessionState {
  activeId: string | null;
  draft: string;
}

/** The framework's route-safe key builder — a raw member id containing `:` or
 *  `%` never matched the KV router, so ids are hex-encoded into the key. */
const sessionKey = (memberId: string) => memberKey('goattown-sessions', memberId);
/** The key this app wrote before it used the framework builder. */
const legacySessionKey = (memberId: string) => `goattown/sessions/${memberId}`;

export async function loadSessionState(memberId: string): Promise<SessionState> {
  const keys = [sessionKey(memberId), legacySessionKey(memberId)];
  for (const key of keys) {
    const read = await kvGetJson<Partial<SessionState>>(key);
    if (!read.found) continue;
    return {
      activeId: typeof read.value.activeId === 'string' ? read.value.activeId : null,
      draft: typeof read.value.draft === 'string' ? read.value.draft : '',
    };
  }
  return { activeId: null, draft: '' };
}

export async function saveSessionState(memberId: string, state: SessionState): Promise<void> {
  await putKvJson(sessionKey(memberId), state);
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
// Client
// ─────────────────────────────────────────────────────────────────

export interface GoatTownClientHandle {
  client: GoatTownClient;
  /** Redacted record of every call the session made — what to show when an
   *  answer looks empty. */
  diagnostics: SessionDiagnostics;
}

/**
 * Build the framework client for a saved connection.
 *
 * `userId` resolves the acting Cribl member and is sent as
 * `x-goattown-user`: sessions are owned per user, so a client without it
 * reads someone else's list or none at all. Pass `memberId` when it is
 * already resolved to avoid a second identity lookup.
 */
export function createClient(
  connection: GoatTownConnection,
  memberId?: string,
): GoatTownClientHandle {
  const diagnostics = new SessionDiagnostics();
  const client = new GoatTownClient({
    baseUrl: connection.serviceUrl,
    userId: memberId ? async () => memberId : memberClaim,
    onDiagnostic: diagnostics.sink,
  });
  return { client, diagnostics };
}

export interface GoatTownCapabilities {
  followUp?: boolean;
  stop?: boolean;
  close?: boolean;
  reopen?: boolean;
  recover?: boolean;
  archive?: boolean;
}

/** Session actions this app can offer at all. The framework client
 *  implements every one of them. */
const KNOWN_CAPABILITIES: readonly (keyof GoatTownCapabilities)[] = [
  'followUp',
  'stop',
  'close',
  'reopen',
  'recover',
  'archive',
];

/** Alias spellings a service may advertise for the same action. */
const CAPABILITY_ALIASES: Record<keyof GoatTownCapabilities, string[]> = {
  followUp: ['followup', 'session-followup', 'session-messages'],
  stop: ['session-stop', 'session-cancel'],
  close: ['session-close'],
  reopen: ['session-reopen', 'session-resume'],
  recover: ['session-recover'],
  archive: ['session-archive'],
};

/**
 * Which session actions the service declares.
 *
 * Read from the client's `/protocol` response; pass `refresh` for a
 * user-initiated re-check, because the cached answer is from before an
 * administrator's toggle took effect.
 *
 * An action is taken as supported unless the service explicitly denies it
 * (i.e. names it `no-<action>`/`<action>:false`), because the protocol's
 * vocabulary is open and has changed names before: treating "not mentioned"
 * as "unsupported" is what would hide every lifecycle button in front of a
 * service that renamed one.
 */
export async function sessionCapabilities(
  client: GoatTownClient,
  options: { refresh?: boolean } = {},
): Promise<GoatTownCapabilities> {
  let protocol: ProtocolResponse;
  try {
    protocol = options.refresh ? await client.refreshProtocol() : await client.protocol();
  } catch {
    // Unreachable protocol: the session calls themselves will report the
    // real failure, so keep the UI usable rather than hiding its controls.
    return Object.fromEntries(KNOWN_CAPABILITIES.map((k) => [k, true]));
  }
  const declared = new Set((protocol.capabilities ?? []).map((c) => c.toLowerCase()));
  const caps: GoatTownCapabilities = {};
  for (const key of KNOWN_CAPABILITIES) {
    const names = [key.toLowerCase(), ...CAPABILITY_ALIASES[key]];
    const denied = names.some(
      (name) => declared.has(`no-${name}`) || declared.has(`${name}:false`),
    );
    caps[key] = !denied;
  }
  return caps;
}
