/* Icons are inline SVG (no icon dependency) and inherit currentColor. */

export function NewChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 0 0-13.7-5.7L3 8.5" />
      <path d="M4 13a8 8 0 0 0 13.7 5.7L21 15.5" />
      <polyline points="3 4 3 8.5 7.5 8.5" />
      <polyline points="21 20 21 15.5 16.5 15.5" />
    </svg>
  );
}

export function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M3.2 20.4 21 12 3.2 3.6l.1 6.5L15 12 3.3 13.9z" />
    </svg>
  );
}
