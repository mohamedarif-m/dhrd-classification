// @vitest-environment jsdom
/**
 * The composer is a textarea so pasted multi-line text keeps its newlines: the
 * agents parse "dump" blocks line by line, and the old single-line input
 * collapsed them into one line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatInput, autoGrowTextarea, sendsOnKey } from '../ChatInput';

afterEach(cleanup);

const composer = () => screen.getByPlaceholderText('Message the agent...') as HTMLTextAreaElement;

describe('composer element', () => {
  it('renders a one-row textarea, not a single-line input', () => {
    render(<ChatInput disabled={false} onSend={() => {}} />);
    const el = composer();
    expect(el.tagName).toBe('TEXTAREA');
    expect(el.rows).toBe(1);
    expect(el.className).toBe('chat-input');
  });

  it('keeps the send button disabled while a turn is running', () => {
    render(<ChatInput disabled onSend={() => {}} />);
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('send convention', () => {
  it('sends on Enter and clears the box', () => {
    const onSend = vi.fn();
    render(<ChatInput disabled={false} onSend={onSend} />);
    const el = composer();
    fireEvent.change(el, { target: { value: 'hello' } });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(el.value).toBe('');
  });

  it('does not send on Shift+Enter - that inserts a newline', () => {
    const onSend = vi.fn();
    render(<ChatInput disabled={false} onSend={onSend} />);
    const el = composer();
    fireEvent.change(el, { target: { value: 'line one' } });
    fireEvent.keyDown(el, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(el.value).toBe('line one');
  });

  it('sends nothing while a turn is running', () => {
    const onSend = vi.fn();
    const { rerender } = render(<ChatInput disabled={false} onSend={onSend} />);
    fireEvent.change(composer(), { target: { value: 'queued' } });
    rerender(<ChatInput disabled onSend={onSend} />);
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('ignores an empty or whitespace-only draft', () => {
    const onSend = vi.fn();
    render(<ChatInput disabled={false} onSend={onSend} />);
    fireEvent.change(composer(), { target: { value: '   \n  ' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends the button click too', () => {
    const onSend = vi.fn();
    render(<ChatInput disabled={false} onSend={onSend} />);
    fireEvent.change(composer(), { target: { value: 'via button' } });
    fireEvent.click(screen.getByLabelText('Send'));
    expect(onSend).toHaveBeenCalledWith('via button');
  });
});

describe('multi-line text', () => {
  const DUMP = 'Title: Analyst\nOpenings: 1\nLocation: Stamford';

  it('keeps pasted newlines in the value', () => {
    render(<ChatInput disabled={false} onSend={() => {}} />);
    const el = composer();
    fireEvent.paste(el);
    fireEvent.change(el, { target: { value: DUMP } });
    expect(el.value).toBe(DUMP);
    expect(el.value.split('\n')).toHaveLength(3);
  });

  it('delivers the newlines verbatim through onSend', () => {
    const onSend = vi.fn();
    render(<ChatInput disabled={false} onSend={onSend} />);
    const el = composer();
    fireEvent.change(el, { target: { value: `\n${DUMP}\n` } });
    fireEvent.keyDown(el, { key: 'Enter' });
    // Only the surrounding whitespace is trimmed; the interior is untouched.
    expect(onSend).toHaveBeenCalledWith(DUMP);
    // And it survives the JSON body the chat call sends.
    const body = JSON.parse(JSON.stringify({ content: onSend.mock.calls[0][0] }));
    expect(body.content).toContain('Analyst\nOpenings');
  });
});

describe('sendsOnKey', () => {
  it('is Enter alone', () => {
    expect(sendsOnKey({ key: 'Enter' })).toBe(true);
    expect(sendsOnKey({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(sendsOnKey({ key: 'a' })).toBe(false);
  });

  it('never sends mid IME composition', () => {
    expect(sendsOnKey({ key: 'Enter', isComposing: true })).toBe(false);
  });
});

describe('autoGrowTextarea', () => {
  it('caps the height at the row limit and turns on scrolling', () => {
    const el = document.createElement('textarea');
    document.body.appendChild(el);
    // jsdom reports scrollHeight 0, so drive it directly.
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    autoGrowTextarea(el, 8);
    const capped = Number.parseFloat(el.style.height);
    expect(capped).toBeGreaterThan(0);
    expect(capped).toBeLessThan(1000);
    expect(el.style.overflowY).toBe('auto');
  });

  it('hides the scrollbar while the content fits', () => {
    const el = document.createElement('textarea');
    document.body.appendChild(el);
    Object.defineProperty(el, 'scrollHeight', { value: 10, configurable: true });
    autoGrowTextarea(el, 8);
    expect(el.style.overflowY).toBe('hidden');
    // Content height plus whatever border the computed style reports.
    const grown = Number.parseFloat(el.style.height);
    expect(grown).toBeGreaterThanOrEqual(10);
    expect(grown).toBeLessThan(20);
  });
});
