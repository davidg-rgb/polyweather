/**
 * The dashboard shell (§5 layout.tsx): nav + the session/allow-list guard —
 * every page below this layout requires the single OPERATOR_EMAIL session
 * (requireOperator redirects to /login otherwise). A route group keeps
 * /login outside the guard at unchanged URLs.
 */
import type { ReactElement, ReactNode } from 'react';
import { DashNav } from '../../components/DashNav.tsx';
import { requireOperator } from '../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

// The nav is now the shared, compact <DashNav> (components/DashNav.tsx) — one component, rendered once here,
// so every (dash) island page carries the same bar covering all ten active analytics surfaces (N6 sweep,
// 2026-07-04). The route list + the /signals toggle live in DashNav (grep INCLUDE_SIGNALS). Data fetching is
// unchanged: this layout still owns requireOperator() and passes the email into the nav as a prop.

export default async function DashLayout({ children }: { children: ReactNode }): Promise<ReactElement> {
  const email = await requireOperator();
  return (
    <div className="shell">
      <DashNav email={email} />
      <main>{children}</main>
    </div>
  );
}
