import { useEffect, useState } from 'react';
import { TIME_RANGES, binSecondsFor, type TimeRangeOption } from '@criblio/app-utils/time';
import { useRangeParam } from '@criblio/app-utils/url-state';

/**
 * Shared time-range picker state for the dashboard pages. The range
 * feeds every range query on the page (`earliest` for KQL, `step`
 * window granularity for PromQL); `refreshKey` bumps on the ↻ button
 * and on the auto-refresh interval, so effects key on it to refetch.
 *
 * The catalog (labels, relative bounds and bin widths) comes from the
 * framework's /time module, and the selection lives in `?range=` via
 * /url-state — so a reload, a Back step and a shared link keep the range
 * the viewer picked, and drill-downs into a detail page inherit it.
 */
const DEFAULT_RANGE = '-1h';

/** The three ranges this app's pickers have always offered, in their
 *  original order and with their original labels, read from the shared
 *  catalog so the bounds and bin widths stay in one place. */
const RANGES: readonly TimeRangeOption[] = TIME_RANGES.filter((r) =>
  (['-1h', '-6h', '-24h'] as const).includes(r.value as '-1h' | '-6h' | '-24h'),
);

const AUTO_REFRESH_MS = 30_000;

export function useTimeRange() {
  const [earliest, setEarliest] = useRangeParam(DEFAULT_RANGE);
  const [auto, setAuto] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => setRefreshKey((k) => k + 1), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [auto]);

  return {
    /** The selected relative range, e.g. '-1h'. */
    range: earliest,
    setRange: setEarliest,
    /** KQL earliest bound for the selected range ('-1h' | '-6h' | '-24h'). */
    earliest,
    /** PromQL step in seconds, coarse enough to keep the window light. */
    step: binSecondsFor(earliest, RANGES),
    /** Bump to refetch — wired to the ↻ button and auto-refresh. */
    refreshKey,
    refresh: () => setRefreshKey((k) => k + 1),
    auto,
    setAuto,
    rangeSelect: (
      <select value={earliest} onChange={(e) => setEarliest(e.target.value)} aria-label="Time range">
        {RANGES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
    ),
    autoSelect: (
      <select
        value={auto ? 'on' : 'off'}
        onChange={(e) => setAuto(e.target.value === 'on')}
        aria-label="Auto refresh"
      >
        <option value="off">Auto-refresh off</option>
        <option value="on">Auto-refresh on</option>
      </select>
    ),
  };
}
