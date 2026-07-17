/**
 * GateOverridePanel (WS-A, UI-POLISH-HANDOFF.md) — the override-flow friction fixes, tested at both layers:
 * the pure helpers (the 14-day pre-fill + the optimistic ACTIVE-flip reconciliation — the "after a 200"
 * mechanics a static render cannot exercise) and direct SSR renders of the panel (pre-filled expiry input,
 * the not-ready inline hint, the confirm step rendered BELOW the trigger button, the ACTIVE/none chips).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

import {
  GateOverridePanel,
  defaultOverrideExpiry,
  overridePropsKey,
  shownOverrideState,
  type OverrideShown,
} from '../src/components/trading-controls.tsx';

describe('defaultOverrideExpiry — the WS-A #1 pre-fill', () => {
  it('returns today+14d (UTC) — midnight UTC of that date is always inside the DB now()+14d cap', () => {
    expect(defaultOverrideExpiry(Date.parse('2026-07-17T18:00:00Z'))).toBe('2026-07-31');
    expect(defaultOverrideExpiry(Date.parse('2026-12-31T23:59:00Z'))).toBe('2027-01-14');
  });
});

describe('shownOverrideState — the WS-A #4 optimistic ACTIVE flip', () => {
  const none: OverrideShown = { active: false, reason: null, expiresAt: null };

  it('a 200 on SET flips the shown state to ACTIVE immediately (props still stale)', () => {
    const optimistic = {
      snapshot: overridePropsKey(none),
      state: { active: true, reason: 'first live buy', expiresAt: '2026-07-31' },
    };
    const shown = shownOverrideState(none, optimistic);
    expect(shown.active).toBe(true);
    expect(shown.reason).toBe('first live buy');
    expect(shown.expiresAt).toBe('2026-07-31');
  });

  it('once the SERVER props change (router.refresh landed), the props win over the optimistic state', () => {
    const optimistic = {
      snapshot: overridePropsKey(none),
      state: { active: true, reason: 'first live buy', expiresAt: '2026-07-31' },
    };
    // the refresh returns the REAL row (timestamptz expiry) — different key ⇒ optimistic is dropped.
    const fresh: OverrideShown = { active: true, reason: 'first live buy', expiresAt: '2026-07-31T00:00:00Z' };
    expect(shownOverrideState(fresh, optimistic)).toEqual(fresh);
    // …and if the server later says the override EXPIRED, the stale optimistic ACTIVE can never mask it.
    expect(shownOverrideState(none, { ...optimistic, snapshot: 'stale|x|y' })).toEqual(none);
  });

  it('a 200 on CLEAR flips an ACTIVE panel to none immediately', () => {
    const activeProps: OverrideShown = { active: true, reason: 'window', expiresAt: '2026-07-31T00:00:00Z' };
    const optimistic = { snapshot: overridePropsKey(activeProps), state: none };
    expect(shownOverrideState(activeProps, optimistic).active).toBe(false);
  });
});

describe('GateOverridePanel renders (SSR)', () => {
  it('pre-fills the expiry to the 14-day cap and shows the inline not-ready hint (WS-A #1/#2)', () => {
    const html = renderToStaticMarkup(
      createElement(GateOverridePanel, { active: false, reason: null, expiresAt: null }),
    );
    expect(html).toContain(`value="${defaultOverrideExpiry(Date.now())}"`); // the pre-filled date input
    expect(html).toContain('enter a reason to enable'); // the hint replacing the silent disabled state
    expect(html).toContain('set override'); // the trigger (disabled until ready — but no longer mute)
    expect(html).toContain('id="gate-override"'); // the VerdictBanner CTA's scroll anchor
    expect(html).toContain('>none<'); // the none chip
  });

  it('renders the strong ACTIVE chip + renew/clear affordances when an override is active', () => {
    const html = renderToStaticMarkup(
      createElement(GateOverridePanel, {
        active: true,
        reason: 'first-N live review window',
        expiresAt: '2026-07-31T00:00:00Z',
      }),
    );
    expect(html).toContain('>ACTIVE<');
    expect(html).toContain('chip amber'); // the strong badge, not a plain word
    expect(html).toContain('renew override');
    expect(html).toContain('clear override');
    expect(html).toContain('2026-07-31T00:00:00Z'); // the expiry shown
  });

  it('WS-A #3: the confirm step renders BELOW the trigger button, where the user just clicked', () => {
    const html = renderToStaticMarkup(
      createElement(GateOverridePanel, {
        active: false,
        reason: null,
        expiresAt: null,
        initialConfirming: true,
      }),
    );
    const trigger = html.indexOf('set override');
    const confirm = html.indexOf('Set the gate override?');
    expect(trigger).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(trigger); // below the button — never the off-screen-above position
  });
});
