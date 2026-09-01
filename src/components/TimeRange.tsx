import { useEffect, useState } from 'react';

/**
 * Shared time-range picker state for the dashboard pages. The range
 * feeds every range query on the page (`earliest` for KQL, `step`
 * window granularity for PromQL); `refreshKey` bumps on the ↻ button
 * and on the auto-refresh interval, so effects key on it to refetch.
 *
 * The labels/values are the ones the original app's pickers used —
 * the pages' selects were uncontrolled decoration until this hook
 * replaced them.
 */
export type TimeRange = 'Last hour' | 'Last 6 hours' | 'Last 24 hours';

const EARLIEST: Record<TimeRange, string> = {
  'Last hour': '-1h',
  'Last 6 hours': '-6h',
  'Last 24 hours': '-24h',
};

const STEP: Record<TimeRange, number> = {
  'Last hour': 60,
  'Last 6 hours': 300,
  'Last 24 hours': 900,
};

const AUTO_REFRESH_MS = 30_000;

export function useTimeRange() {
  const [range, setRange] = useState<TimeRange>('Last hour');
  const [auto, setAuto] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => setRefreshKey((k) => k + 1), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [auto]);

  return {
    range,
    setRange,
    /** KQL earliest bound for the selected range ('-1h' | '-6h' | '-24h'). */
    earliest: EARLIEST[range],
    /** PromQL step in seconds, coarse enough to keep the window light. */
    step: STEP[range],
    /** Bump to refetch — wired to the ↻ button and auto-refresh. */
    refreshKey,
    refresh: () => setRefreshKey((k) => k + 1),
    auto,
    setAuto,
    rangeSelect: (
      <select
        value={range}
        onChange={(e) => setRange(e.target.value as TimeRange)}
        aria-label="Time range"
      >
        <option>Last hour</option>
        <option>Last 6 hours</option>
        <option>Last 24 hours</option>
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
