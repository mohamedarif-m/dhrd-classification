import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { SendIcon } from './icons';

/** How tall the composer may grow before it starts scrolling internally. */
export const CHAT_INPUT_MAX_ROWS = 8;

/**
 * Size a composer textarea to its content, from one row up to `maxRows`, then
 * let it scroll. Measured from the element's own computed style so a host
 * restyling `.chat-input` (font, padding, border) still gets the right cap.
 * Exported for hosts that build their own composer around the same behavior.
 */
export function autoGrowTextarea(
  el: HTMLTextAreaElement,
  maxRows = CHAT_INPUT_MAX_ROWS,
): void {
  const style = typeof globalThis.getComputedStyle === 'function'
    ? globalThis.getComputedStyle(el)
    : null;
  const px = (v: string | undefined) => {
    const n = Number.parseFloat(v ?? '');
    return Number.isFinite(n) ? n : 0;
  };
  // 'normal' line-height parses to NaN; fall back to a sane row height.
  const lineHeight = px(style?.lineHeight) || 19;
  const frame = px(style?.paddingTop) + px(style?.paddingBottom);
  const border = px(style?.borderTopWidth) + px(style?.borderBottomWidth);
  const max = lineHeight * maxRows + frame + border;
  // Collapse first so scrollHeight reports the content height, not the
  // height this element already has (box-sizing is border-box, so the
  // border has to be added back on).
  el.style.height = 'auto';
  const content = el.scrollHeight + border;
  el.style.height = `${Math.min(content, max)}px`;
  el.style.overflowY = content > max ? 'auto' : 'hidden';
}

/**
 * Should this keypress send the turn? Standard chat convention: Enter sends,
 * Shift+Enter (and any IME composition keystroke) inserts a newline. Pure so
 * the convention is testable without a DOM.
 */
export function sendsOnKey(
  e: { key: string; shiftKey?: boolean; isComposing?: boolean },
): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing;
}

/**
 * The chat composer. A textarea, not a single-line input: readers paste
 * multi-line blocks (labeled "dump" text) and the newlines are load-bearing
 * for the agents' line-based parsers - a single-line input collapsed them and
 * corrupted what the agent parsed. The value travels to `onSend` with its
 * `\n` characters intact; only the leading/trailing whitespace is trimmed.
 */
export function ChatInput({ disabled, onSend }: {
  disabled: boolean;
  onSend: (t: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const resize = useCallback(() => {
    const el = areaRef.current;
    if (el) autoGrowTextarea(el);
  }, []);
  // Runs on every value change, so pasting a block grows the box in the same
  // frame the text lands, and sending shrinks it back to one row.
  useLayoutEffect(resize, [draft, resize]);

  const send = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft('');
  };
  return (
    <div className="chat-input-row">
      <textarea
        ref={areaRef}
        className="chat-input"
        rows={1}
        placeholder="Message the agent..."
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (!sendsOnKey({
            key: e.key,
            shiftKey: e.shiftKey,
            isComposing: (e.nativeEvent as KeyboardEvent).isComposing,
          })) return;
          // Without this the newline lands in the box before it clears.
          e.preventDefault();
          send();
        }}
      />
      <button
        type="button"
        className="chat-send"
        onClick={send}
        disabled={disabled}
        aria-label="Send"
        title="Send"
      >
        <SendIcon />
      </button>
    </div>
  );
}
