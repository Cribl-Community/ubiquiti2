import './viz.css';
import { SERIES_COLORS } from './palette';

export interface BarListItem {
  label: string;
  value: number;
}

interface Props {
  items: BarListItem[];
  format?: (v: number) => string;
  /** Single hue — a bar list encodes magnitude of one measure. */
  color?: string;
  maxItems?: number;
  /** Makes rows interactive — drill into the category behind a bar. */
  onItemClick?: (item: BarListItem) => void;
}

/**
 * Horizontal category bars (a stand-in for pie charts — magnitudes across
 * categories compare far better on a common baseline).
 */
export default function BarList({
  items,
  format = (v) => String(v),
  color = SERIES_COLORS[0],
  maxItems = 10,
  onItemClick,
}: Props) {
  const shown = [...items].sort((a, b) => b.value - a.value).slice(0, maxItems);
  const max = shown.length > 0 ? Math.max(...shown.map((i) => i.value)) : 1;
  const RowTag = onItemClick ? 'button' : 'div';
  return (
    <div className={"barList"}>
      {shown.map((item) => (
        <RowTag
          key={item.label}
          {...(onItemClick ? { type: 'button' as const } : {})}
          className={`${"barRow"} ${onItemClick ? "barRowClickable" : ''}`}
          title={`${item.label}: ${format(item.value)}${onItemClick ? ' — click for details' : ''}`}
          onClick={onItemClick ? () => onItemClick(item) : undefined}
        >
          <span className={"barLabel"}>{item.label}</span>
          <span className={"barTrack"}>
            <span
              className={"barFill"}
              style={{ width: `${Math.max((item.value / max) * 100, 1)}%`, background: color }}
            />
          </span>
          <span className={"barValue"}>{format(item.value)}</span>
        </RowTag>
      ))}
    </div>
  );
}
