/**
 * HROProcessingTimer — Gen Z MUI redesign
 * Gradient pill badge with spinning clock and monospace elapsed time.
 */

import { useEffect, useRef, useState } from 'react';
import Chip from '@mui/material/Chip';

interface Props {
  /** The wrapper div that contains AgentSurface (surfaceWrapperRef). */
  wrapperRef: React.RefObject<HTMLDivElement>;
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
}

export function HROProcessingTimer({ wrapperRef }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const [active, setActive] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number>(0);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const start = () => {
      if (active) return;             // already running
      startRef.current = Date.now();
      setElapsed(0);
      setActive(true);
      intervalRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);
    };

    const stop = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setActive(false);
    };

    const check = () => {
      const thinking = wrapper.querySelector('.thinking-bubble');
      if (thinking) start(); else stop();
    };

    check();                           // run once on mount
    const obs = new MutationObserver(check);
    obs.observe(wrapper, { childList: true, subtree: true });

    return () => {
      obs.disconnect();
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapperRef]);

  if (!active) return null;

  return (
    <div className="hro-processing-timer" aria-live="off" aria-label={`Processing time: ${fmt(elapsed)}`}>
      <span className="hro-processing-timer-icon" aria-hidden="true">⏱</span>
      <span className="hro-processing-timer-time">{fmt(elapsed)}</span>
      <span className="hro-processing-timer-label">processing…</span>
      <Chip
        label="AI"
        size="small"
        sx={{
          height: 18,
          fontSize: '0.6rem',
          fontWeight: 800,
          background: 'rgba(255,255,255,0.18)',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.25)',
          letterSpacing: '0.05em',
          ml: 0.5,
          '& .MuiChip-label': { px: 0.8 },
        }}
      />
    </div>
  );
}
