import type { ReactNode } from 'react';
import { appTitle } from '../lib/view/branding';
import type { Branding } from '../lib/chat/liveTypes';

/**
 * Brand slot + one action. With branding.logoUrl set the slot is the host's
 * logo (drop the file into the host app's public/ directory and configure
 * "/logo.svg", or point at an absolute URL); otherwise it is the accent bar
 * + app title.
 */
export function TopBar({ action, branding }: { action?: ReactNode; branding?: Branding }) {
  const title = appTitle(branding);
  const logoUrl = branding?.logoUrl?.trim();
  return (
    <header className="topbar">
      <div className="wordmark">
        {logoUrl ? (
          <img className="topbar-logo" src={logoUrl} alt={title} />
        ) : (
          <>
            <span className="wordmark-tick" aria-hidden="true" />
            <span className="wordmark-text">{title}</span>
          </>
        )}
      </div>
      <div className="topbar-right">{action}</div>
    </header>
  );
}
