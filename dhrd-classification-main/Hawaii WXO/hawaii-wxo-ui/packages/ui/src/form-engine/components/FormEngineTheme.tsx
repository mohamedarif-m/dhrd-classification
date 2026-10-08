import type { CSSProperties, ReactNode } from 'react';
import { mergeTokens, themeVars, type ThemeOverride } from '../lib/theme';

interface Props {
  tokens?: ThemeOverride;
  children: ReactNode;
}

/** Applies theme tokens as CSS variables; wrap any engine components in one of these. */
export function FormEngineTheme({ tokens, children }: Props) {
  const style = themeVars(mergeTokens(tokens)) as CSSProperties;
  return (
    <div className="fe-root" style={style}>
      {children}
    </div>
  );
}
