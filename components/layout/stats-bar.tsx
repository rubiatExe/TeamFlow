'use client';

import { useEffect, useState } from 'react';
import { Award, Check, Mail, Mic2, Users } from 'lucide-react';

export type DashboardStats = {
  total: number;
  avgScore: number;
  byStatus: {
    pending: number;
    new: number;
    invited: number;
    interviewed: number;
    hired: number;
  };
  topCandidate?: { name: string; score: number };
};

function useCountUp(value: number, duration = 600): number {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const reducedMotionFrame = requestAnimationFrame(() => setDisplayValue(value));
      return () => cancelAnimationFrame(reducedMotionFrame);
    }

    let frame = 0;
    const startedAt = performance.now();
    const tick = (timestamp: number) => {
      const progress = Math.min(1, (timestamp - startedAt) / duration);
      const eased = 1 - ((1 - progress) ** 3);
      setDisplayValue(Math.round(value * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, value]);

  return displayValue;
}

function Divider() {
  return <span aria-hidden="true" className="hidden h-6 w-px shrink-0 bg-[var(--cocoa-200)] sm:block" />;
}

export function StatsBar({ stats, showScores = true }: { stats: DashboardStats; showScores?: boolean }) {
  const total = useCountUp(stats.total);
  const average = useCountUp(stats.avgScore);
  const newCount = useCountUp(stats.byStatus.pending + stats.byStatus.new);
  const invited = useCountUp(stats.byStatus.invited);
  const interviewed = useCountUp(stats.byStatus.interviewed);
  const hired = useCountUp(stats.byStatus.hired);
  const averageColor = stats.avgScore >= 80 ? 'text-[var(--sage-700)]' : stats.avgScore >= 50 ? 'text-amber-700' : 'text-red-700';

  return (
    <section aria-label="Hiring pipeline statistics" className="h-16 border-b border-[var(--cocoa-100)] bg-[var(--cocoa-50)]">
      <div className="mx-auto flex h-full max-w-[1600px] items-center gap-4 overflow-x-auto px-4 text-sm [scrollbar-width:none] md:px-8 [&::-webkit-scrollbar]:hidden">
        <div className="flex shrink-0 items-center gap-2">
          <Users className="size-4 text-[var(--cocoa-600)]" aria-hidden="true" />
          <span className="text-[var(--cocoa-600)]">Applicants</span>
          <strong className="text-[var(--cocoa-800)] tabular-nums">{total}</strong>
        </div>
        {showScores ? <><Divider />
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <span className="text-[var(--cocoa-600)]">Avg Score</span>
          <strong className={`${averageColor} tabular-nums`}>{average}</strong>
        </div></> : null}
        <Divider />
        <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--status-new-bg)] px-2.5 py-1 font-semibold text-[var(--status-new)]">
          <span aria-hidden="true">🆕</span><span>New</span><span className="tabular-nums">{newCount}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--status-invited-bg)] px-2.5 py-1 font-semibold text-[var(--status-invited)]">
          <Mail className="size-3.5" aria-hidden="true" /><span>Invited</span><span className="tabular-nums">{invited}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--status-interviewed-bg)] px-2.5 py-1 font-semibold text-[var(--status-interviewed)]">
          <Mic2 className="size-3.5" aria-hidden="true" /><span>Interviewed</span><span className="tabular-nums">{interviewed}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--status-hired-bg)] px-2.5 py-1 font-semibold text-[var(--status-hired)]">
          <Check className="size-3.5" aria-hidden="true" /><span>Hired</span><span className="tabular-nums">{hired}</span>
        </div>
        {showScores && stats.topCandidate ? (
          <>
            <Divider />
            <div className="hidden min-w-0 shrink-0 items-center gap-2 text-[var(--cocoa-700)] md:flex">
              <Award className="size-4" aria-hidden="true" />
              <span>Best fit: <strong>{stats.topCandidate.name}</strong></span>
              <span className="rounded-full bg-white px-2 py-0.5 font-bold tabular-nums shadow-sm">{stats.topCandidate.score}</span>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
