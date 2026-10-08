/** Hawaii workspace with a compact document panel and fresh classification runs. */

import {
  useCallback, useEffect, useRef, useState,
} from 'react';
// Note: useRef kept for surfaceWrapperRef; useCallback for handleSubmit/resetChat
import {
  AgentSurface,
  TopBar,
  type LiveRegistry,
  type ThemeOverride,
  currentSearch,
  parseDeepLink,
} from 'wxo-custom-ui';
import Button from '@mui/material/Button';
import AddCircleOutlineRoundedIcon from '@mui/icons-material/AddCircleOutlineRounded';
import { HROUploadZone, type HROFiles } from './HROUploadZone';
import { HROProcessingTimer } from './HROProcessingTimer';

// ---- simple last-session helpers (localStorage, best-effort) ---------------

const LAST_AGENT_KEY = 'hawaii-hro-last-agent';

function readLastAgent(valid: readonly string[]): string | null {
  try {
    const v = localStorage.getItem(LAST_AGENT_KEY);
    return v && valid.includes(v) ? v : null;
  } catch { return null; }
}

function writeLastAgent(key: string): void {
  try { localStorage.setItem(LAST_AGENT_KEY, key); } catch { /* best-effort */ }
}

// ---- DOM observer hook for "has user messages" ----------------------------

function useChatHasMessages(
  wrapperRef: React.RefObject<HTMLDivElement>,
  epoch: number,
): boolean {
  const [hasMessages, setHasMessages] = useState(false);

  useEffect(() => {
    setHasMessages(false);
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const check = () => {
      // .fe-msg--user is the actual class used by ChatMessage when role="user"
      setHasMessages(Boolean(wrapper.querySelector('.fe-msg--user')));
    };
    check();
    const obs = new MutationObserver(check);
    obs.observe(wrapper, { childList: true, subtree: true });
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapperRef, epoch]);

  return hasMessages;
}

// ---- component -------------------------------------------------------------

interface Props {
  registry: LiveRegistry;
  focusAgentKey?: string;
  onNavigate: (path: string) => void;
  formTokensFor?: (accent?: string | null) => ThemeOverride;
}

export function HROWorkspace({ registry, focusAgentKey, onNavigate, formTokensFor }: Props) {
  const agents = registry.agents.filter((a) => !a.comingSoon);
  const fallbackAgent = agents[0] ?? registry.agents[0];
  const agentKeys = agents.map((a) => a.key);

  const [deepLink] = useState(() => parseDeepLink(currentSearch(), agentKeys));
  const [agentKey, setAgentKey] = useState(
    focusAgentKey ?? deepLink.agentKey ?? readLastAgent(agentKeys) ?? fallbackAgent?.key ?? '',
  );

  const agent = registry.agents.find(
    (a) => a.key === (focusAgentKey ?? agentKey),
  ) ?? fallbackAgent;

  useEffect(() => { if (agent?.key) writeLastAgent(agent?.key); }, [agent?.key]);

  const [deepFocus, setDeepFocus] = useState(deepLink.focus);
  const focus = Boolean(focusAgentKey) || deepFocus;
  const [chatEpoch, setChatEpoch] = useState(0);

  const surfaceWrapperRef = useRef<HTMLDivElement>(null);
  const hasMessages = useChatHasMessages(surfaceWrapperRef, chatEpoch);

  const [initialMessage, setInitialMessage] = useState<string>();
  const resetChat = useCallback(() => {
    setInitialMessage(undefined);
    setChatEpoch((e) => e + 1);
  }, []);

  // Called by HROUploadZone "Classify PD" button.
  // 1. Registers the uploaded file URLs with the proxy via POST /api/pending-files.
  // 2. The proxy attaches them as WXO native file blocks on the next /api/chat call.
  // 3. Sends "Classify PD" through a fresh AgentSurface conversation.
  const handleSubmit = useCallback(async (message: string, files: HROFiles) => {
    const clientId: string = (() => {
      const KEY = 'tko-anon-id';
      let id = localStorage.getItem(KEY);
      if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id); }
      return id;
    })();

    // Register files with proxy — chat route will pick them up on next send.
    // extracted_text carries the markitdown output; the proxy embeds it
    // directly in the WXO message so agents can read it without chat_with_docs.
    const response = await fetch('/api/pending-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TKO-Client': clientId },
      body: JSON.stringify({
        files: [
          { url: files.pdUrl, name: files.pdName, extracted_text: files.pdText },
          { url: files.csUrl, name: files.csName, extracted_text: files.csText },
        ],
      }),
    });
    if (!response.ok) throw new Error('Could not prepare documents. Please try again.');
    // Mount a clean AgentSurface so no previous thread ID, form or messages
    // can be reused. Its initialMessage sends through the normal chat API.
    setAgentKey('hro-classifier');
    if (focusAgentKey && focusAgentKey !== 'hro-classifier') onNavigate('/a/hro-classifier');
    setInitialMessage(message);
    setChatEpoch((e) => e + 1);
  }, [focusAgentKey, onNavigate]);

  if (!agent) return <div className="coming-soon"><h2>No agents configured</h2></div>;

  return (
    <div className="shell">
      <TopBar
        branding={registry.branding}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {agent?.key === 'hro-classifier' && hasMessages && (
                <Button
                  className="hro-new-classification-btn"
                  onClick={resetChat}
                  startIcon={<AddCircleOutlineRoundedIcon sx={{ fontSize: 15 }} />}
                  disableRipple
                  sx={{ textTransform: 'none' }}
                  title="Start a new classification"
                >
                  New Classification
                </Button>
              )}
              <button
                type="button"
                className="topbar-action"
                onClick={() => {
                  if (focus) setDeepFocus(false);
                  onNavigate(focus ? '/' : `/a/${agent?.key}`);
                }}
              >
                {focus ? 'Workspace view' : 'Focus view'}
              </button>
          </div>
        }
      />
      <div
        ref={surfaceWrapperRef}
        style={{ position: 'relative', flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <AgentSurface
          key={`${agent?.key}-${chatEpoch}`}
          agent={agent}
          registry={registry}
          focus={focus}
          formTokensFor={formTokensFor}
          onSelectAgent={(k) => { setAgentKey(k); resetChat(); }}
          onReset={resetChat}
          initialMessage={initialMessage}
          workspaceAside={agent?.key === 'hro-classifier' ? (
            <HROUploadZone agent={agent} onSubmit={handleSubmit} />
          ) : undefined}
        />
        <HROProcessingTimer wrapperRef={surfaceWrapperRef} />
      </div>
    </div>
  );
}
