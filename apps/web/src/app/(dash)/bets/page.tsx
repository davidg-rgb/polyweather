/**
 * /bets — the ledger (§6.21 getBetsLedger): totals, equity curve from the
 * window-sum view (§7.16/W10), the §11.4 edge-decile fidelity table
 * (adverse-selection tracker), and the bet rows.
 */
import type { ReactElement } from 'react';
import { Spark } from '../../../components/Spark.tsx';
import { fmtDateTime, fmtPct, fmtProb, fmtUsd, num } from '../../../lib/format.ts';
import { getBetsLedger } from '../../../lib/loaders.ts';
import { serverDb } from '../../../lib/supabase.ts';

export const dynamic = 'force-dynamic';

export default async function BetsPage(): Promise<ReactElement> {
  const v = await getBetsLedger(await serverDb());
  return (
    <div>
      <h1>
        Bets <span className={`chip ${v.mode === 'paper' ? 'blue' : 'red'}`}>{v.mode}</span>
      </h1>

      <div className="grid cols-3">
        <div className="panel stat">
          <span className="label">resolved W / L</span>
          <span className="value">
            {num(v.totals.wins) ?? 0} / {num(v.totals.losses) ?? 0}
          </span>
        </div>
        <div className="panel stat">
          <span className="label">total pnl</span>
          <span className={`value ${(num(v.totals.pnl) ?? 0) >= 0 ? 'pos' : 'neg'}`}>{fmtUsd(v.totals.pnl)}</span>
        </div>
        <div className="panel stat">
          <span className="label">total staked</span>
          <span className="value">{fmtUsd(v.totals.staked)}</span>
        </div>
      </div>

      <h2>Equity curve</h2>
      <div className="panel">
        <Spark values={v.equityCurve.map((p) => num(p.balance) ?? 0)} width={720} height={72} />
      </div>

      <h2>Hit rate by edge decile (§11.4 — does claimed edge convert?)</h2>
      <div className="panel">
        {v.hitRateByEdgeDecile.length === 0 ? (
          <p className="muted">No resolved bets yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="num">decile</th>
                <th className="num">n</th>
                <th className="num">avg edge</th>
                <th className="num">avg q</th>
                <th className="num">hit rate</th>
                <th className="num">q − hit gap</th>
                <th className="num">pnl</th>
              </tr>
            </thead>
            <tbody>
              {v.hitRateByEdgeDecile.map((d) => {
                const gap = (num(d.avgQ) ?? 0) - (num(d.hitRate) ?? 0);
                return (
                  <tr key={d.decile}>
                    <td className="num">{d.decile}</td>
                    <td className="num">{num(d.n) ?? 0}</td>
                    <td className="num">{fmtProb(d.avgEdge)}</td>
                    <td className="num">{fmtProb(d.avgQ)}</td>
                    <td className="num">{fmtPct(d.hitRate, 1)}</td>
                    <td className={`num ${gap > 0.05 ? 'neg' : 'pos'}`}>{fmtProb(gap)}</td>
                    <td className={`num ${(num(d.pnl) ?? 0) >= 0 ? 'pos' : 'neg'}`}>{fmtUsd(d.pnl)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <h2>Ledger (latest 500)</h2>
      <div className="panel">
        {v.bets.length === 0 ? (
          <p className="muted">No bets yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>when</th>
                <th>city</th>
                <th>bucket</th>
                <th>status</th>
                <th className="num">q</th>
                <th className="num">edge</th>
                <th className="num">fill</th>
                <th className="num">stake</th>
                <th className="num">fee</th>
                <th className="num">pnl</th>
              </tr>
            </thead>
            <tbody>
              {v.bets.map((b) => (
                <tr key={b.betId}>
                  <td className="small">{fmtDateTime(b.recommendedAt)}</td>
                  <td>
                    <a href={`/events/${b.eventSlug}`}>{b.city}</a>
                  </td>
                  <td className="mono">{b.label}</td>
                  <td>
                    <span className={`chip ${b.status === 'resolved_win' ? 'green' : b.status === 'resolved_lose' ? 'red' : b.status === 'filled' ? 'blue' : ''}`}>
                      {b.status}
                    </span>
                  </td>
                  <td className="num">{fmtProb(b.q)}</td>
                  <td className="num">{fmtProb(b.edge)}</td>
                  <td className="num">
                    {b.executedPrice !== null ? `${num(b.shares) ?? '?'} @ ${fmtProb(b.executedPrice)}` : '—'}
                  </td>
                  <td className="num">{fmtUsd(b.stake)}</td>
                  <td className="num">{fmtUsd(b.fee)}</td>
                  <td className={`num ${(num(b.pnl) ?? 0) >= 0 ? 'pos' : 'neg'}`}>{fmtUsd(b.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
