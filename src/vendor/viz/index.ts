/**
 * Shared dashboard viz kit: d3-based charts and panel primitives styled
 * with the Cribl Design System tokens (see styles/tokens.css). Consumers
 * need react + d3-array/d3-scale/d3-shape/d3-time-format installed.
 */

export { default as LineChart, type LineSeries } from './LineChart';
export { default as Sparkline } from './Sparkline';
export { default as Panel } from './Panel';
export { default as StatTile } from './StatTile';
export { default as BarList, type BarListItem } from './BarList';
export { default as DataTable, type Column } from './DataTable';
export { SERIES_COLORS, MAX_SERIES, seriesColor, CHART_INK } from './palette';
export {
  formatBytes,
  formatBytesRate,
  formatBitsRate,
  formatCompact,
  formatDuration,
  formatPercent,
  formatSeconds,
  formatDb,
  formatValue,
  type ValueKind,
} from './format';
export { toLineSeries, toBarItems, indexByLabel } from './chartData';
