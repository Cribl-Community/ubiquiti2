import s from './EmptyTableRows.module.css';

export default function EmptyTableRows({ columns, rows = 4, loading = true, emptyMessage = 'No data available' }: { columns: number; rows?: number; loading?: boolean; emptyMessage?: string }) {
  if (!loading) return <tr className={s.empty}><td colSpan={columns}>{emptyMessage}</td></tr>;
  return <>{Array.from({ length: rows }, (_, row) => <tr key={`empty-${row}`} aria-hidden="true" className={s.row}>{Array.from({ length: columns }, (_, column) => <td key={`empty-${row}-${column}`}><span className={column === 0 ? s.lineWide : s.line} /></td>)}</tr>)}</>;
}
