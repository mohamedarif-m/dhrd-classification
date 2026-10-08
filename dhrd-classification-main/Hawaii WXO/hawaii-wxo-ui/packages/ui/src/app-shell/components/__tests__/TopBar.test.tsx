import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { configureBranding } from '../../lib/view/branding';
import { TopBar } from '../TopBar';

describe('TopBar branding slot', () => {
  it('renders the app title from branding when no logo is configured', () => {
    const html = renderToStaticMarkup(<TopBar branding={{ appTitle: 'Acme Connect' }} />);
    expect(html).toContain('Acme Connect');
    expect(html).toContain('wordmark-tick');
    expect(html).not.toContain('<img');
  });

  it('falls back to the package wordmark without branding', () => {
    expect(renderToStaticMarkup(<TopBar />)).toContain('Agent Workspace');
  });

  it('lets the host configure the fallback wordmark', () => {
    configureBranding({ wordmark: 'ACME CONNECT' });
    expect(renderToStaticMarkup(<TopBar />)).toContain('ACME CONNECT');
    configureBranding({ wordmark: 'Agent Workspace' });
  });

  it('renders the logo instead of the title when logoUrl is set', () => {
    const html = renderToStaticMarkup(
      <TopBar branding={{ appTitle: 'Acme Connect', logoUrl: '/logo.svg' }} />);
    expect(html).toContain('class="topbar-logo"');
    expect(html).toContain('src="/logo.svg"');
    expect(html).toContain('alt="Acme Connect"');
    expect(html).not.toContain('wordmark-tick');
  });

  it('no longer renders the workspace label', () => {
    expect(renderToStaticMarkup(<TopBar />)).not.toContain('HR Agent Workspace');
  });
});
