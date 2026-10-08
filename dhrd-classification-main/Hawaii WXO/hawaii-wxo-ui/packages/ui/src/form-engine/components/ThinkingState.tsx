import { useEffect, useState } from 'react';
import { resolveThinkingCopy, type ThinkingCopyInput } from '../lib/thinkingCopy';
import { THINKING_ROTATE_INTERVAL_MS, THINKING_STAGE_INTERVAL_MS } from '../lib/config';

export interface ThinkingStage {
  label: string;
  /** Show a skeleton form under the label (for form-loading stages). */
  skeleton?: boolean;
}

export interface ThinkingStateProps extends ThinkingCopyInput {
  /** Explicit stage script (demo / multi-step runs). Overrides copy resolution. */
  stages?: ThinkingStage[];
  /** Auto-advance interval; omit with `stages` to control activeIndex externally. */
  intervalMs?: number;
  activeIndex?: number;
  loop?: boolean;
}

/**
 * Stage-aware progress: a narrated label instead of an anonymous spinner.
 * Copy is resolved from data (registry copy > tool name > rotating fallbacks).
 */
export function ThinkingState(props: ThinkingStateProps) {
  const { stages, intervalMs, activeIndex, loop } = props;

  let effective: ThinkingStage[];
  let effectiveLoop = loop ?? false;
  let effectiveInterval = intervalMs;
  let showStep = Boolean(stages && stages.length > 1);

  if (stages) {
    effective = stages;
  } else {
    const copy = resolveThinkingCopy(props);
    if (copy.mode === 'fixed') {
      effective = [{ label: copy.label }];
    } else if (copy.mode === 'staged') {
      // Staged registry copy: advance through the phrases and HOLD the last.
      effective = copy.phrases.map((label) => ({ label }));
      effectiveLoop = false;
      effectiveInterval = intervalMs ?? THINKING_STAGE_INTERVAL_MS;
    } else {
      effective = copy.phrases.map((label) => ({ label }));
      effectiveLoop = true;
      effectiveInterval = intervalMs ?? THINKING_ROTATE_INTERVAL_MS;
    }
  }

  const [internal, setInternal] = useState(0);
  const index = activeIndex ?? internal;
  const stage = effective[Math.min(index, effective.length - 1)];

  useEffect(() => {
    if (!effectiveInterval || activeIndex !== undefined || effective.length < 2) return;
    const t = setInterval(() => {
      setInternal((i) => {
        if (i + 1 < effective.length) return i + 1;
        return effectiveLoop ? 0 : i;
      });
    }, effectiveInterval);
    return () => clearInterval(t);
  }, [effectiveInterval, activeIndex, effective.length, effectiveLoop]);

  if (!stage) return null;

  return (
    <div className="fe-thinking" role="status" aria-live="polite">
      <div className="fe-thinking-line">
        <span className="fe-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="fe-thinking-label">{stage.label}</span>
        {showStep && (
          <span className="fe-thinking-step">
            {Math.min(index, effective.length - 1) + 1} / {effective.length}
          </span>
        )}
      </div>
      {stage.skeleton && (
        <div className="fe-skeleton" aria-hidden="true">
          <div className="fe-skel fe-skel--title" />
          <div className="fe-skel-grid">
            <div className="fe-skel" /><div className="fe-skel" />
            <div className="fe-skel" /><div className="fe-skel" />
            <div className="fe-skel fe-skel--wide" />
          </div>
        </div>
      )}
    </div>
  );
}
