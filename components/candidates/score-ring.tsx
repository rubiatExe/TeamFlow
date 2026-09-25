'use client';

import { useEffect, useState } from 'react';

interface ScoreRingProps {
  score: number;
  size?: number;
  animated?: boolean;
  tone?: 'fit' | 'query';
  ariaLabel?: string;
  expanded?: boolean;
  controls?: string;
  onScoreClick?: () => void;
  onScoreFocus?: () => void;
}

const RADIUS = 22;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function scoreColor(score: number, tone: ScoreRingProps['tone']): string {
  if (tone === 'query') return 'var(--cocoa-600)';
  if (score >= 80) return 'var(--score-high)';
  if (score >= 50) return 'var(--score-mid)';
  return 'var(--score-low)';
}

export function ScoreRing({
  score,
  size = 56,
  animated = true,
  tone = 'fit',
  ariaLabel,
  expanded,
  controls,
  onScoreClick,
  onScoreFocus,
}: ScoreRingProps) {
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  const [drawnScore, setDrawnScore] = useState(0);

  useEffect(() => {
    if (!animated) return;
    const frame = requestAnimationFrame(() => setDrawnScore(boundedScore));
    return () => cancelAnimationFrame(frame);
  }, [animated, boundedScore]);

  const color = scoreColor(boundedScore, tone);
  const renderedScore = animated ? drawnScore : boundedScore;
  const offset = CIRCUMFERENCE - (renderedScore / 100) * CIRCUMFERENCE;

  return (
    <button
      type="button"
      aria-label={ariaLabel ?? `Fit score: ${boundedScore}. Click to see breakdown.`}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onScoreClick}
      onFocus={onScoreFocus}
      className="group relative inline-flex shrink-0 items-center justify-center rounded-full bg-white transition-transform hover:animate-[gentle-pulse_300ms_ease]"
      style={{ width: size, height: size }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 56 56"
        className="absolute inset-0 size-full -rotate-90"
      >
        <circle
          cx="28"
          cy="28"
          r={RADIUS}
          fill="none"
          stroke="var(--cocoa-100)"
          strokeWidth="5"
        />
        <circle
          cx="28"
          cy="28"
          r={RADIUS}
          fill="none"
          stroke={color}
          strokeLinecap="round"
          strokeWidth="5"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          className="score-ring-progress"
        />
      </svg>
      <span className="relative text-sm font-bold tabular-nums" style={{ color }}>
        {boundedScore}
      </span>
    </button>
  );
}
