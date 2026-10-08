import { useCallback, useEffect, useState } from 'react';
import {
  TopBar,
  applyBranding,
  getRegistry,
  type LiveRegistry,
} from 'wxo-custom-ui';
import { liveConfigured } from './config';
import { hawaiiFormTokensFor } from './theme.hawaii';
import { HROWorkspace } from './HROWorkspace';

/**
 * Hawaii DHRD HRO — custom UI shell.
 *
 * Live mode only: requires VITE_HAWAII_API_BASE to reach the proxy on :8081.
 * Routing: /a/<key> = focus view for one agent; / = workspace.
 *
 * To differentiate from the base TKO version:
 *   Base TKO  → localhost:5173  proxied to :8080
 *   Hawaii UI → localhost:5174  proxied to :8081
 */
export function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    window.history.pushState(null, '', to);
    setPath(to);
  }, []);

  if (!liveConfigured) return <NotConfigured />;
  return <LiveRoot path={path} onNavigate={navigate} />;
}

function NotConfigured() {
  return (
    <div className="shell">
      <TopBar />
      <div className="coming-soon">
        <h2>Hawaii DHRD HRO — not configured</h2>
        <p>
          Set <code>VITE_HAWAII_API_BASE=/api</code> and start the Hawaii proxy
          on <code>:8081</code>.
        </p>
        <pre style={{ fontSize: '0.85em', marginTop: '1rem' }}>
{`# Terminal 1 — proxy
cd hawaii-wxo-ui/server
TKO_ENV_FILE=../../.env uvicorn app.main:app --port 8081

# Terminal 2 — UI
VITE_HAWAII_API_BASE=/api npm run dev`}
        </pre>
      </div>
    </div>
  );
}

function LiveRoot({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (p: string) => void;
}) {
  const [registry, setRegistry] = useState<LiveRegistry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getRegistry()
      .then(setRegistry)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Could not reach the proxy'),
      );
  }, []);
  useEffect(load, [load]);

  // Apply Hawaii branding as soon as the registry arrives.
  useEffect(() => {
    if (registry) applyBranding(registry.branding);
  }, [registry]);

  if (error) {
    return (
      <div className="shell">
        <TopBar />
        <div className="coming-soon">
          <h2>Cannot reach the Hawaii proxy</h2>
          <p>
            {error}. Start it with:{' '}
            <code>uvicorn app.main:app --port 8081</code>
          </p>
          <p>
            <button type="button" className="chat-send" onClick={load}>
              Retry
            </button>
          </p>
        </div>
      </div>
    );
  }
  if (!registry) {
    return (
      <div className="shell">
        <TopBar />
        <div className="coming-soon">
          <p>Connecting to Hawaii proxy...</p>
        </div>
      </div>
    );
  }

  const focusMatch = path.match(/^\/a\/([A-Za-z0-9_-]+)/);
  const focusKey =
    focusMatch &&
    registry.agents.some((a) => a.key === focusMatch[1] && !a.comingSoon)
      ? focusMatch[1]
      : undefined;

  return (
    <HROWorkspace
      registry={registry}
      focusAgentKey={focusKey}
      formTokensFor={hawaiiFormTokensFor}
      onNavigate={onNavigate}
    />
  );
}
