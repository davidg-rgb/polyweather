'use client';
/**
 * CITY-LIVE (lane W) operator control widgets for /trading — the two MUTATING flows the read-only 0082 console
 * lacked: (1) the trade_config input table (mode / caps / stake / daily-loss / allowlist / active_until) and
 * (2) the per-city Live arms table (toggle + stake ≤ $5 + entry-hour override). Each is a thin client form over
 * its §8.2 route (/api/admin/trading/config → trade_config_set; /api/admin/trading/city-arm → city_live_arm_set),
 * the SAME idiom as components/controls.tsx: postJson + errText, router.refresh() on success, errors rendered
 * VERBATIM (the route surfaces the DB CHECK / RAISE text — the §9R $25 ceiling, the max-2 hard stop, …).
 *
 * The page stays a server component (reads server-side); only these interactive forms are client. Boundary
 * (CLAUDE.md §9R): Claude builds the software; the operator funds/keys/toggles — enabling a city here only ARMS
 * a $≤5/day live test; nothing trades until the daemon runs live AND trade_live_preflight('city-taker') passes.
 */
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';
import { errText, postJson } from './post.ts';
import type { CityLiveArm, TradeConfig } from '../lib/loaders.ts';

// A local twin of controls.tsx's useAction/Status (kept file-local, like the original) — busy latch + verbatim
// message + router.refresh() on success.
function useAction(): {
  busy: boolean;
  msg: string | null;
  ok: boolean;
  run: (fn: () => Promise<{ ok: boolean; msg: string }>) => Promise<void>;
} {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const run = async (fn: () => Promise<{ ok: boolean; msg: string }>): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      setOk(r.ok);
      setMsg(r.msg);
      if (r.ok) router.refresh();
    } catch (e) {
      setOk(false);
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, msg, ok, run };
}

const Status = ({ msg, ok }: { msg: string | null; ok: boolean }): ReactElement | null =>
  msg ? <span className={ok ? 'form-ok' : 'form-error'}>{msg}</span> : null;

const curStr = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

// DOM-lib-free event readers: the root typecheck pass (tsconfig.json, lib ES2023 — no `dom`) pulls this client
// component into its graph via the /trading page render test, and `HTMLInputElement.value` isn't resolvable there.
// Reading through a structural cast references no DOM element type. (components/controls.tsx's twin escapes the
// root pass only because no root-graph test imports it.)
const evVal = (e: { target: unknown }): string => (e.target as { value: string }).value;
const evChecked = (e: { target: unknown }): boolean => (e.target as { checked: boolean }).checked;

// ─── (a) trade_config input table ─────────────────────────────────────────────────────────────────────────

const NUM_FIELDS: { key: keyof TradeConfig; param: string; label: string; step?: string }[] = [
  { key: 'stake_per_buy_usd', param: 'stakePerBuyUsd', label: 'Stake / buy (USD)', step: '1' },
  { key: 'per_position_cap_usd', param: 'perPositionCapUsd', label: 'Per-position cap (USD)', step: '1' },
  { key: 'per_market_cap_usd', param: 'perMarketCapUsd', label: 'Per-market cap (USD)', step: '1' },
  { key: 'total_concurrent_cap_usd', param: 'totalConcurrentCapUsd', label: 'Total concurrent cap (USD)', step: '1' },
  { key: 'daily_loss_kill_usd', param: 'dailyLossKillUsd', label: 'Daily-loss kill (USD)', step: '1' },
  { key: 'daily_loss_kill_frac', param: 'dailyLossKillFrac', label: 'Daily-loss kill fraction', step: '0.05' },
];

/**
 * The editable trade_config surface. Current value + input per field; a single Save posts ONLY the changed
 * fields to /api/admin/trading/config (null-param = leave unchanged in trade_config_set). Range enforcement is
 * the DB's — the $25 ceiling / positivity / ≤1 fraction / 60-day cap all RAISE and are shown verbatim.
 *
 * ALLOWLIST SAFEGUARD (0093, operator 2026-07-11): the allowlist is a CHECKBOX PICKER over `cityOptions`
 * (the enrolled cities, passed by the page) ∪ the currently-stored entries — no free text, so a typo'd or
 * wrong-case slug can no longer be entered here at all. The DB is the real guarantee (trade_config_set
 * normalizes + RAISES on unknown slugs); this UI just makes the error unreachable. "All cities" is an
 * explicit radio (posts clearCityAllowlist), never an empty selection — an empty restrict-set is unsaveable.
 */
export function TradeConfigEditor({
  config,
  cityOptions = [],
}: {
  config: TradeConfig;
  /** Valid allowlist targets (enrolled cities): slug + display label. */
  cityOptions?: { slug: string; label: string }[];
}): ReactElement {
  const a = useAction();
  const c = config as unknown as Record<string, unknown>;
  const [mode, setMode] = useState<string>(config.mode);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const curAllowArr = (config.city_allowlist ?? []).map((s) => s.toLowerCase());
  const [allowAll, setAllowAll] = useState<boolean>(config.city_allowlist == null);
  const [allowSel, setAllowSel] = useState<string[]>(curAllowArr);
  // Options = the page-supplied enrolled cities ∪ whatever is currently stored (a stored slug outside the
  // enrolled set must stay visible/uncheckable, never silently dropped by the picker).
  const allowOptions: { slug: string; label: string }[] = [
    ...cityOptions,
    ...curAllowArr
      .filter((s) => !cityOptions.some((o) => o.slug === s))
      .map((s) => ({ slug: s, label: s })),
  ];

  const curActive = config.active_until ?? '';
  const inputOf = (key: string, fallback: string): string => edits[key] ?? fallback;
  const set = (key: string, v: string): void => setEdits((p) => ({ ...p, [key]: v }));

  const sameSet = (x: string[], y: string[]): boolean =>
    x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);

  // Build the diff body — only fields whose input differs from the current DB value.
  const buildBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    if (mode !== config.mode) body['mode'] = mode;
    for (const f of NUM_FIELDS) {
      const cur = curStr(c[f.key]);
      const val = edits[f.key as string];
      if (val !== undefined && val.trim() !== '' && val.trim() !== cur) body[f.param] = Number(val);
    }
    if (allowAll) {
      if (config.city_allowlist != null) body['clearCityAllowlist'] = true;
    } else if (allowSel.length > 0 && !sameSet(allowSel, curAllowArr)) {
      body['cityAllowlist'] = [...allowSel].sort();
    }
    const activeInput = edits['active_until'];
    if (activeInput !== undefined && activeInput.trim() !== curActive) {
      if (activeInput.trim() === '') {
        if (config.active_until != null) body['clearActiveUntil'] = true;
      } else {
        body['activeUntil'] = activeInput.trim();
      }
    }
    return body;
  };
  const changeCount = Object.keys(buildBody()).length;

  return (
    <div className="panel">
      <p className="muted small" style={{ marginTop: 0 }}>
        Editable <span className="mono">trade_config</span> (operator RPC <span className="mono">trade_config_set</span>).
        Enter a new value and Save — only changed fields are written. Range guardrails are enforced by the database
        (the §9R <strong>$25</strong> stake/position ceiling, positivity, the ≤1 kill fraction, the 60-day run-window
        cap) and any rejection is shown <strong>verbatim</strong>.
      </p>
      <div className="tbl-scroll">
        <table>
          <thead>
            <tr>
              <th>field</th>
              <th>current</th>
              <th>new value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Mode</td>
              <td className="mono">{config.mode}</td>
              <td>
                <select value={mode} onChange={(e) => setMode(evVal(e))}>
                  <option value="off">off</option>
                  <option value="dry-run">dry-run</option>
                  <option value="live">live</option>
                </select>
              </td>
            </tr>
            {NUM_FIELDS.map((f) => (
              <tr key={f.key as string}>
                <td>{f.label}</td>
                <td className="mono">{curStr(c[f.key])}</td>
                <td>
                  <input
                    className="mono"
                    type="number"
                    step={f.step}
                    style={{ width: 120 }}
                    value={inputOf(f.key as string, curStr(c[f.key]))}
                    onChange={(e) => set(f.key as string, evVal(e))}
                  />
                </td>
              </tr>
            ))}
            <tr>
              <td>City allowlist</td>
              <td className="mono">{config.city_allowlist == null ? 'all cities' : curAllowArr.join(', ')}</td>
              <td>
                <label style={{ display: 'block', marginBottom: 4 }}>
                  <input
                    type="radio"
                    name="allowlist-scope"
                    checked={allowAll}
                    onChange={() => setAllowAll(true)}
                  />{' '}
                  all cities
                </label>
                <label style={{ display: 'block', marginBottom: 4 }}>
                  <input
                    type="radio"
                    name="allowlist-scope"
                    checked={!allowAll}
                    onChange={() => setAllowAll(false)}
                  />{' '}
                  restrict to:
                </label>
                {!allowAll ? (
                  <div style={{ paddingLeft: 18 }}>
                    {allowOptions.length === 0 ? (
                      <span className="muted small">no enrolled cities to pick from</span>
                    ) : (
                      allowOptions.map((o) => (
                        <label key={o.slug} style={{ display: 'block' }}>
                          <input
                            type="checkbox"
                            checked={allowSel.includes(o.slug)}
                            onChange={(e) =>
                              setAllowSel((p) =>
                                evChecked(e) ? [...p, o.slug] : p.filter((s) => s !== o.slug),
                              )
                            }
                          />{' '}
                          {o.label} <span className="muted small mono">{o.slug}</span>
                        </label>
                      ))
                    )}
                    {allowSel.length === 0 ? (
                      <span className="form-error small">select at least one city (empty would allow none)</span>
                    ) : null}
                  </div>
                ) : null}
              </td>
            </tr>
            <tr>
              <td>Run window (active_until)</td>
              <td className="mono">{config.active_until ?? 'off'}</td>
              <td>
                <input
                  className="mono"
                  type="date"
                  style={{ width: 160 }}
                  value={inputOf('active_until', curActive)}
                  onChange={(e) => set('active_until', evVal(e))}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="form-row">
        <button
          className="primary"
          disabled={a.busy || changeCount === 0}
          onClick={() =>
            void a.run(async () => {
              const r = await postJson('/api/admin/trading/config', buildBody());
              if (r.status === 200) {
                setEdits({});
                return { ok: true, msg: 'config saved' };
              }
              return { ok: false, msg: errText(r) };
            })
          }
        >
          save {changeCount} change{changeCount === 1 ? '' : 's'}
        </button>
        <Status msg={a.msg} ok={a.ok} />
      </div>
    </div>
  );
}

// ─── (c) City Live arms table ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-city Live toggle surface. Enabling a city ARMS real capital ($≤5/day) once the daemon runs live, so a
 * flip to ON opens a confirmation dialog before it ever posts enabled=true; a flip to OFF is safe and posts
 * immediately. With 2 cities already enabled the unchecked toggles are disabled (the envelope's hard cap — the DB
 * constraint trigger is the real hard stop and its RAISE is shown verbatim). Stake ≤ $5 and the entry-hour
 * override are per-row edits saved through the same route; the ≤5 envelope is the DB CHECK.
 */
export function CityArmsTable({ arms }: { arms: CityLiveArm[] }): ReactElement {
  const a = useAction();
  const [edits, setEdits] = useState<Record<string, { stake: string; hour: string }>>({});
  const [confirming, setConfirming] = useState<
    { cityId: string; slug: string; name: string; stake: number; hour: number | null } | null
  >(null);

  const enabledCount = arms.filter((x) => x.enabled).length;
  const atCap = enabledCount >= 2;

  const stakeOf = (arm: CityLiveArm): string =>
    edits[arm.cityId]?.stake ?? (arm.stakeUsd == null ? '5' : String(arm.stakeUsd));
  const hourOf = (arm: CityLiveArm): string =>
    edits[arm.cityId]?.hour ?? (arm.entryHourOverride == null ? '' : String(arm.entryHourOverride));
  const patch = (arm: CityLiveArm, key: 'stake' | 'hour', v: string): void =>
    setEdits((p) => ({
      ...p,
      [arm.cityId]: {
        stake: key === 'stake' ? v : (p[arm.cityId]?.stake ?? stakeOf(arm)),
        hour: key === 'hour' ? v : (p[arm.cityId]?.hour ?? hourOf(arm)),
      },
    }));

  const post = (cityId: string, slug: string, enabled: boolean, stakeUsd: number, entryHour: number | null): Promise<void> =>
    a.run(async () => {
      const r = await postJson('/api/admin/trading/city-arm', { cityId, enabled, stakeUsd, entryHour });
      if (r.status === 200) {
        setConfirming(null);
        return { ok: true, msg: `${slug} ${enabled ? 'ARMED' : 'disabled'}` };
      }
      return { ok: false, msg: errText(r) };
    });

  const hourNum = (arm: CityLiveArm): number | null => {
    const h = hourOf(arm).trim();
    return h === '' ? null : Number(h);
  };

  if (arms.length === 0) return <p className="muted">No enrolled cities in the paper-trade race yet.</p>;

  return (
    <div className="panel">
      <p className="muted small" style={{ marginTop: 0 }}>
        Enabling a city arms up to <strong>$5/day</strong> of real capital when the daemon runs live — max{' '}
        <strong>2 cities</strong> enabled (SQL-enforced). Each enable is confirmed first. The Live toggle is the{' '}
        <strong>authorization</strong>; promotion status is advisory (operator sovereignty). Nothing trades until the
        daemon runs <span className="mono">TRADE_MODE=live</span> and{' '}
        <span className="mono">trade_live_preflight(&apos;city-taker&apos;)</span> passes.
      </p>
      {confirming ? (
        <div className="info-banner" role="dialog" aria-modal="true" style={{ borderLeftColor: 'var(--ams-amber)' }}>
          <strong style={{ color: 'var(--ams-amber)' }}>Enable {confirming.name}?</strong> This arms{' '}
          <strong>${confirming.stake.toFixed(2)}/day</strong> of real capital when the daemon runs live (entry{' '}
          {confirming.hour == null ? 'auto — recommended hour' : `${confirming.hour}:00 local`}). Faithful TAKER
          replication of the tested sim: buy the predicted bucket at the ask, hold to resolution.
          <div className="form-row">
            <button
              className="primary"
              disabled={a.busy}
              onClick={() => void post(confirming.cityId, confirming.slug, true, confirming.stake, confirming.hour)}
            >
              Confirm enable
            </button>
            <button disabled={a.busy} onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <div className="tbl-scroll">
        <table>
          <thead>
            <tr>
              <th>city</th>
              <th>status</th>
              <th>live</th>
              <th className="num">stake $/day</th>
              <th className="num">entry hour</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {arms.map((arm) => {
              const locked = !arm.enabled && atCap;
              return (
                <tr key={arm.cityId}>
                  <td>
                    {arm.displayName} <span className="muted small mono">{arm.icao}</span>
                  </td>
                  <td>
                    <span className="chip small">{arm.promotedStatus ?? '—'}</span>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={arm.enabled}
                      disabled={a.busy || locked}
                      title={locked ? '2 cities already enabled — disable one first' : undefined}
                      onChange={(e) => {
                        if (evChecked(e)) {
                          setConfirming({
                            cityId: arm.cityId,
                            slug: arm.slug,
                            name: arm.displayName,
                            stake: Number(stakeOf(arm)),
                            hour: hourNum(arm),
                          });
                        } else {
                          void post(arm.cityId, arm.slug, false, Number(stakeOf(arm)), hourNum(arm));
                        }
                      }}
                    />
                  </td>
                  <td className="num">
                    <input
                      className="mono"
                      type="number"
                      min="0"
                      max="5"
                      step="0.5"
                      style={{ width: 80 }}
                      value={stakeOf(arm)}
                      onChange={(e) => patch(arm, 'stake', evVal(e))}
                    />
                  </td>
                  <td className="num">
                    <input
                      className="mono"
                      type="number"
                      min="0"
                      max="23"
                      step="1"
                      placeholder="auto"
                      style={{ width: 70 }}
                      value={hourOf(arm)}
                      onChange={(e) => patch(arm, 'hour', evVal(e))}
                    />
                  </td>
                  <td>
                    <button
                      disabled={a.busy}
                      onClick={() => void post(arm.cityId, arm.slug, arm.enabled, Number(stakeOf(arm)), hourNum(arm))}
                    >
                      save
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Status msg={a.msg} ok={a.ok} />
    </div>
  );
}
