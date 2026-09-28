export default function ProgressBar({
  percent,
  tone = 'sky',
}: {
  percent: number;
  tone?: 'sky' | 'emerald';
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const fill = tone === 'emerald' ? 'bg-emerald-500' : 'bg-sky-500';
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200"
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${fill}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
