'use client';

import { useEffect, useState } from 'react';
import { Award, Check, Inbox, Mail, Mic2, Users } from 'lucide-react';

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

type Tile = {
  key: string;
  label: string;
  value: number;
  icon: typeof Users;
  tone: string;
  bg: string;
  glow: string;
};

export function StatsBar({ stats, showScores = true }: { stats: DashboardStats; showScores?: boolean }) {
  const total = useCountUp(stats.total);
  const average = useCountUp(stats.avgScore);
  const newCount = useCountUp(stats.byStatus.pending + stats.byStatus.new);
  const invited = useCountUp(stats.byStatus.invited);
  const interviewed = useCountUp(stats.byStatus.interviewed);
  const hired = useCountUp(stats.byStatus.hired);
  const averageColor = stats.avgScore >= 80 ? 'text-[var(--sage-700)]' : stats.avgScore >= 50 ? 'text-amber-700' : 'text-red-700';

  const tiles: Tile[] = [
    { key: 'new', label: 'To review', value: newCount, icon: Inbox, tone: 'text-[var(--status-new)]', bg: 'bg-[var(--status-new-bg)]', glow: 'rgba(29, 78, 216, 0.14)' },
    { key: 'invited', label: 'Invited', value: invited, icon: Mail, tone: 'text-[var(--status-invited)]', bg: 'bg-[var(--status-invited-bg)]', glow: 'rgba(180, 83, 9, 0.16)' },
    { key: 'interviewed', label: 'Interviewed', value: interviewed, icon: Mic2, tone: 'text-[var(--status-interviewed)]', bg: 'bg-[var(--status-interviewed-bg)]', glow: 'rgba(109, 40, 217, 0.14)' },
    { key: 'hired', label: 'Hired', value: hired, icon: Check, tone: 'text-[var(--status-hired)]', bg: 'bg-[var(--status-hired-bg)]', glow: 'rgba(94, 155, 94, 0.2)' },
  ];

  const funnelTotal = Math.max(1, stats.total);
  const segments = [
    { key: 'new', count: stats.byStatus.pending + stats.byStatus.new, color: 'var(--status-new)' },
    { key: 'invited', count: stats.byStatus.invited, color: '#d97706' },
    { key: 'interviewed', count: stats.byStatus.interviewed, color: 'var(--status-interviewed)' },
    { key: 'hired', count: stats.byStatus.hired, color: 'var(--sage-500)' },
  ];

  return (
    <section aria-label="Hiring pipeline statistics" className="border-b border-[var(--cocoa-100)]/80">
      <div className="mx-auto max-w-[1600px] px-4 py-4 md:px-8">
        <div className={`grid grid-cols-2 gap-3 md:grid-cols-3 ${showScores ? 'xl:grid-cols-6' : 'xl:grid-cols-5'}`}>
          <div className="kpi-tile col-span-2 flex items-center gap-4 p-4 md:col-span-1" style={{ '--kpi-glow': 'rgba(186, 120, 64, 0.22)' } as React.CSSProperties}>
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--cocoa-100)] text-[var(--cocoa-700)]">
              <Users className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-xs font-semibold text-[var(--cocoa-600)]">Applicants</p>
              <p className="font-display text-3xl font-semibold leading-none tabular-nums text-[var(--cocoa-900)]"><strong className="font-semibold">{total}</strong></p>
            </div>
          </div>

          {tiles.map(tile => {
            const Icon = tile.icon;
            return (
              <div key={tile.key} className="kpi-tile flex items-center gap-3 p-4" style={{ '--kpi-glow': tile.glow } as React.CSSProperties}>
                <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${tile.bg} ${tile.tone}`}>
                  <Icon className="size-[18px]" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-xs font-semibold text-[var(--cocoa-600)]">{tile.label}</p>
                  <p className={`font-display text-2xl font-semibold leading-none tabular-nums ${tile.tone}`}><span>{tile.value}</span></p>
                </div>
              </div>
            );
          })}

          {showScores ? (
            <div className="kpi-tile col-span-2 flex items-center gap-3 p-4 md:col-span-1" style={{ '--kpi-glow': 'rgba(94, 155, 94, 0.2)' } as React.CSSProperties}>
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--sage-50)] text-[var(--sage-700)]">
                <Award className="size-[18px]" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[var(--cocoa-600)]">Avg score</p>
                <p className="flex items-baseline gap-2">
                  <strong className={`font-display text-2xl font-semibold leading-none tabular-nums ${averageColor}`}>{average}</strong>
                  {stats.topCandidate ? <span className="truncate text-xs text-[var(--cocoa-600)]">Best fit: <strong className="text-[var(--cocoa-800)]">{stats.topCandidate.name}</strong> · {stats.topCandidate.score}</span> : null}
                </p>
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex items-center gap-3" role="img" aria-label={`Pipeline funnel: ${stats.total} applicants`}>
          <span className="hidden text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--cocoa-500)] sm:block">Funnel</span>
          <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-[var(--cocoa-100)]">
            {segments.map(segment => (
              <span
                key={segment.key}
                className="h-full transition-[width] duration-700 ease-out"
                style={{ width: `${(segment.count / funnelTotal) * 100}%`, background: segment.color }}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
