import type { FileStatus } from '@interview/shared';

const TONE: Record<FileStatus, string> = {
  queued: 'bg-slate-100 text-slate-600',
  processing: 'bg-sky-100 text-sky-700',
  done: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-rose-100 text-rose-700',
};

const DEFAULT_LABELS: Record<FileStatus, string> = {
  queued: '대기',
  processing: '변환 중…',
  done: '완료 ✓',
  failed: '실패',
};

export default function StatusBadge({
  status,
  labels,
}: {
  status: FileStatus;
  /** 기능별로 진행 중 문구만 바꾸고 싶을 때. */
  labels?: Partial<Record<FileStatus, string>>;
}) {
  const label = labels?.[status] ?? DEFAULT_LABELS[status];
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE[status]}`}
    >
      {label}
    </span>
  );
}
