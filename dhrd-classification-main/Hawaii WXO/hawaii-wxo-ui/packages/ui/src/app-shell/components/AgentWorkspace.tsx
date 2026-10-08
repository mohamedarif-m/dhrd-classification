import { useEffect, useState } from 'react';
import type { ThemeOverride } from '../../form-engine';
import { currentSearch, parseDeepLink } from '../lib/view/deepLink';
import { lastAgent, rememberAgent } from '../lib/view/lastSession';
import type { LiveRegistry } from '../lib/chat/liveTypes';
import { AgentSurface } from './AgentSurface';
import { TopBar } from './TopBar';

interface Props {
  registry: LiveRegistry;
  /** Set in focus mode (/a/<key>): single agent, no workspace sidebar. */
  focusAgentKey?: string;
  onNavigate: (path: string) => void;
  /** Host's form-engine tokens for the configured brand accent (optional). */
  formTokensFor?: (accent?: string | null) => ThemeOverride;
}

export function AgentWorkspace({ registry, focusAgentKey, onNavigate, formTokensFor }: Props) {
  const agents = registry.agents.filter((a) => !a.comingSoon);
  const fallbackAgent = agents[0] ?? registry.agents[0];
  // ?agent=<key>&focus=1 seeds the initial view only (see lib/deepLink).
  // Read once, on mount, so later navigation is never overridden by the URL.
  const [deepLink] = useState(() =>
    parseDeepLink(currentSearch(), agents.map((a) => a.key)));
  // Boot order: the host's route wins, then the deep link, then the agent this
  // browser was last on, then the registry's first agent. The remembered key
  // sits ABOVE the registry default because that default is nothing but array
  // order - leaving focus mode used to land on whichever agent happened to be
  // listed first, which then listed threads for the wrong agent and showed
  // none (browser suite, persona F).
  const [agentKey, setAgentKey] = useState(
    focusAgentKey ?? deepLink.agentKey
    ?? lastAgent(agents.map((a) => a.key)) ?? fallbackAgent?.key ?? '');
  const agent = registry.agents.find((a) => a.key === (focusAgentKey ?? agentKey))
    ?? fallbackAgent;
  // Remember whatever is actually on screen, including the focus-mode agent:
  // a reader who reloads out of /a/<key> should come back to that agent.
  useEffect(() => {
    if (agent?.key) rememberAgent(agent.key);
  }, [agent?.key]);
  // Focus is prop-driven when the host routes (/a/<key>); the deep-link flag
  // is the fallback for hosts that do not, and clears when the user leaves.
  const [deepFocus, setDeepFocus] = useState(deepLink.focus);
  const focus = Boolean(focusAgentKey) || deepFocus;
  // Remount the chat surface per agent so state never bleeds across agents.
  const [chatEpoch, setChatEpoch] = useState(0);

  if (!agent) return <div className="coming-soon"><h2>No agents configured</h2></div>;

  return (
    <div className="shell">
      <TopBar
        branding={registry.branding}
        action={
          <button
            type="button"
            className="topbar-action"
            onClick={() => {
              if (focus) setDeepFocus(false);
              onNavigate(focus ? '/' : `/a/${agent.key}`);
            }}
          >
            {focus ? 'Workspace view' : 'Focus view'}
          </button>
        }
      />
      <AgentSurface
        key={`${agent.key}-${chatEpoch}`}
        agent={agent}
        registry={registry}
        focus={focus}
        formTokensFor={formTokensFor}
        onSelectAgent={(k) => { setAgentKey(k); setChatEpoch((e) => e + 1); }}
        onReset={() => setChatEpoch((e) => e + 1)}
      />
    </div>
  );
}

/** The name this component carried while it lived in the TKO app. */
export const LiveApp = AgentWorkspace;
