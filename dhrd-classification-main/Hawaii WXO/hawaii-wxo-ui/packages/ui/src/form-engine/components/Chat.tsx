import type { ReactNode } from 'react';
import { formatTimestamp } from '../lib/time';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessageProps {
  role: ChatRole;
  content?: string;
  /** Display name shown above the bubble (e.g. the agent's registry name). */
  author?: string;
  /** Avatar node (icon/initial) shown beside the bubble. */
  avatar?: ReactNode;
  /**
   * Server-record ISO timestamp (message created_on). Always the API value,
   * never a client stamp; formatted browser-local by the engine time policy.
   */
  timestamp?: string;
  /** Streaming in progress: shows a subtle caret after the text. */
  streaming?: boolean;
  children?: ReactNode;
}

/** Minimal markdown: paragraphs, **bold**, `code`. Enough for agent replies. */
function renderMarkdown(text: string): ReactNode {
  return text.split(/\n{2,}/).map((para, pi) => (
    <p key={pi}>
      {para.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={i}>{part.slice(1, -1)}</code>;
        }
        return part;
      })}
    </p>
  ));
}

export function ChatMessage({
  role, content, author, avatar, timestamp, streaming, children,
}: ChatMessageProps) {
  const time = formatTimestamp(timestamp);
  return (
    <div className={`fe-msg fe-msg--${role}`}>
      {avatar !== undefined && <div className="fe-msg-avatar" aria-hidden="true">{avatar}</div>}
      <div className="fe-msg-main">
        {(author || time) && (
          <div className="fe-msg-meta">
            {author && <span className="fe-msg-author">{author}</span>}
            {time && <span className="fe-msg-time">{time}</span>}
          </div>
        )}
        <div className="fe-msg-bubble">
          {content !== undefined ? renderMarkdown(content) : children}
          {streaming && <span className="fe-msg-caret" aria-hidden="true" />}
        </div>
      </div>
    </div>
  );
}

export function ChatStream({ children }: { children: ReactNode }) {
  return <div className="fe-chat-stream">{children}</div>;
}
