export interface MetricPoint {
  value: number;
  time?: number;
  /** Labels returned by grouped PromQL results (for example name/port_name). */
  labels?: Record<string, string>;
}

const apiUrl = () => window.CRIBL_API_URL ?? '/api/v1';

export async function queryMetric(query: string, step?: number): Promise<MetricPoint[]> {
  const params = new URLSearchParams({
    query,
    earliest: '-1h',
    latest: 'now',
    searchJobSource: 'metrics',
    datasetId: 'metrics',
  });
  if (step) params.set('step', String(step));
  const response = await fetch(`${apiUrl()}/m/default_search/search/query?${params}`);
  if (!response.ok) throw new Error(`Metric query failed (${response.status})`);
  const text = await response.text();
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const labels = Object.fromEntries(Object.entries(row).filter(([key, value]) => !key.startsWith('_') && !['instance','job','source'].includes(key) && typeof value === 'string'));
      if (row._kind === 'sample' && typeof row._value === 'number') return [{ value: row._value, time: Number(row._time), labels }];
      if (typeof row.value === 'number') return [{ value: row.value, labels }];
      if (typeof row.last === 'number') return [{ value: row.last, labels }];
      if (Array.isArray(row.data)) return row.data.filter((p): p is { value: number; time?: number; labels?: Record<string, string> } => typeof p === 'object' && p !== null && typeof (p as { value?: unknown }).value === 'number').map((p) => ({ ...p, labels }));
    } catch { /* ignore non-JSON response fragments */ }
    return [];
  });
}

export async function latestMetric(query: string, fallback: number): Promise<number> {
  try {
    const points = await queryMetric(query);
    return points.at(-1)?.value ?? fallback;
  } catch { return fallback; }
}
