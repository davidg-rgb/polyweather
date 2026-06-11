/** / — today overview (§6.21 getTodayOverview). */
import type { ReactElement } from 'react';
import { BetCard } from '../../components/BetCard.tsx';
import { ExposureBar } from '../../components/ExposureBar.tsx';
import { JobHealthTable } from '../../components/JobHealthTable.tsx';
import { Spark } from '../../components/Spark.tsx';
import { fmtUsd, num } from '../../lib/format.ts';
import { getTodayOverview } from '../../lib/loaders.ts';
import { serverDb } from '../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

export default async function TodayPage(): Promise<ReactElement> {
  const v = await getTodayOverview(await serverDb());
  const pnl = v.pnlSeries.map((p) => num(p.balance) ?? 0);
  return (
    <div>
      <h1>
        Today{' '}
        <span className={`chip ${v.mode === 'paper' ? 'blue' : 'red'}`}>{v.mode}</span>{' '}
        <span className="chip">champion: {v.championSource}</span>
      </h1>

      <div className="grid cols-3">
        <div className="panel stat">
          <span className="label">bankroll ({v.mode})</span>
          <span className="value">{fmtUsd(v.bankroll)}</span>
        </div>
        <div className="panel stat">
          <span className="label">open recommendations</span>
          <span className="value">{v.openRecs.length}</span>
        </div>
        <div className="panel">
          <span className="stat"><span className="label">P&amp;L (ledger balance)</span></span>
          <Spark values={pnl} width={300} height={48} />
        </div>
      </div>

      {v.breakerStates.length > 0 ? (
        <div className="drift-banner">
          ⛔ active halts:{' '}
          {v.breakerStates.map((b) => (
            <span key={b.key} className="mono" style={{ marginRight: 8 }}>{b.key}</span>
          ))}
          <a href="/admin" className="small">manage on /admin</a>
        </div>
      ) : null}

      <h2>Open recommendations</h2>
      {v.openRecs.length === 0 ? (
        <p className="muted">None right now — poll-markets recommends when edge clears the bar.</p>
      ) : (
        v.openRecs.map((rec) => <BetCard key={rec.betId} rec={rec} />)
      )}

      <h2>Exposure vs caps</h2>
      <div className="panel">
        <ExposureBar exposures={v.exposures} caps={v.caps} />
      </div>

      <h2>Jobs</h2>
      <div className="panel">
        <JobHealthTable jobs={v.jobHealth} />
        <p className="small">
          <a href="/system">full system health →</a>
        </p>
      </div>
    </div>
  );
}
