/**
 * DashNav render smoke test — the shared compact top nav (N6 consistency sweep). Renders the server
 * component to static markup and asserts (a) it never throws, (b) the brand + session email + sign-out
 * form are present, (c) every route in the exported DASH_NAV list reaches the DOM as a link, (d) the ten
 * canonical dash surfaces from the brief are all covered, and (e) /signals stays excluded until lane N1
 * merges (the greppable INCLUDE_SIGNALS toggle). Data-logic-free — the nav takes email as a prop.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DASH_NAV, DashNav } from '../src/components/DashNav.tsx';

describe('DashNav — shared compact dash nav', () => {
  const html = renderToStaticMarkup(DashNav({ email: 'operator@example.com' }));

  it('renders the brand, session email, and sign-out form', () => {
    expect(html).toContain('class="topnav"');
    expect(html).toContain('Weather Edge'); // brand
    expect(html).toContain('operator@example.com'); // session email prop
    expect(html).toContain('/auth/signout'); // sign-out form action
  });

  it('renders every route in DASH_NAV as a link with its label', () => {
    for (const [href, label] of DASH_NAV) {
      expect(html).toContain(`href="${href}"`);
      expect(html).toContain(`>${label}</a>`);
    }
  });

  it('covers all ten canonical dash surfaces from the N6 brief', () => {
    const hrefs = DASH_NAV.map(([h]) => h);
    const brief = [
      '/',
      '/efficiency',
      '/convergence',
      '/maker-exit',
      '/amsterdam',
      '/paper-trade',
      '/data',
      '/sharps',
      '/rewards',
      '/whaletracker',
    ];
    for (const h of brief) expect(hrefs).toContain(h);
    // includes the two reference-idiom pages the trimmed nav had dropped
    expect(hrefs).toContain('/');
    expect(hrefs).toContain('/efficiency');
    expect(hrefs).toContain('/rewards');
  });

  it('excludes /signals until lane N1 merges (greppable INCLUDE_SIGNALS toggle)', () => {
    expect(DASH_NAV.map(([h]) => h)).not.toContain('/signals');
    expect(html).not.toContain('href="/signals"');
  });
});
