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
import type { BuyTableLiveCycle, BuyTablePriceConfig, CityLiveArm, TradeConfig } from '../lib/loaders.ts';

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

// ─── (a0) the allowlist picker ────────────────────────────────────────────────────────────────────────────

/**
 * The allowlist CHECKBOX PICKER (operator UX rework 2026-07-11): the old single-column 45-checkbox scroll box
 * was unusable at the 0094 full-domain scale. Now: a filter input, a responsive multi-column grid, select-all /
 * clear bulk actions, and a selected-count readout. Options CHECKED AT MOUNT sort first (frozen once, so rows
 * never reshuffle mid-edit as the operator toggles). Pure presentation over the SAME controlled state
 * (allowSel via setSel) — the parent's diff-aware save and POST body are untouched.
 */
function AllowlistPicker({
  options,
  sel,
  setSel,
}: {
  options: { slug: string; label: string }[];
  sel: string[];
  setSel: (update: (prev: string[]) => string[]) => void;
}): ReactElement {
  const [filter, setFilter] = useState('');
  // The checked-first ordering is frozen at mount (a lazy useState initializer) — toggling a box must not
  // reshuffle the grid under the cursor.
  const [checkedAtMount] = useState<ReadonlySet<string>>(() => new Set(sel));
  const ordered = [...options].sort((a, b) => {
    const ca = checkedAtMount.has(a.slug) ? 0 : 1;
    const cb = checkedAtMount.has(b.slug) ? 0 : 1;
    return ca - cb || a.slug.localeCompare(b.slug);
  });
  const f = filter.trim().toLowerCase();
  const visible = f === '' ? ordered : ordered.filter((o) => o.slug.includes(f) || o.label.toLowerCase().includes(f));

  return (
    <div style={{ paddingLeft: 18 }}>
      <div className="form-row" style={{ marginBottom: 6 }}>
        <input
          type="text"
          placeholder="filter cities"
          value={filter}
          onChange={(e) => setFilter(evVal(e))}
          style={{ width: 160 }}
        />
        <button
          type="button"
          title="select every city currently shown (respects the filter)"
          onClick={() => setSel((p) => [...new Set([...p, ...visible.map((o) => o.slug)])])}
        >
          select all
        </button>
        <button type="button" title="clear the whole selection" onClick={() => setSel(() => [])}>
          clear
        </button>
        <span className="muted small">
          {sel.length} of {options.length} selected
        </span>
      </div>
      {options.length === 0 ? (
        <span className="muted small">no enrolled cities to pick from</span>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
            gap: '2px 12px',
            maxHeight: 260,
            overflowY: 'auto',
          }}
        >
          {visible.length === 0 ? (
            <span className="muted small">no city matches the filter</span>
          ) : (
            visible.map((o) => (
              <label key={o.slug} style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <input
                  type="checkbox"
                  checked={sel.includes(o.slug)}
                  onChange={(e) =>
                    setSel((p) => (evChecked(e) ? [...p, o.slug] : p.filter((s) => s !== o.slug)))
                  }
                />{' '}
                {o.label} <span className="muted small mono">{o.slug}</span>
              </label>
            ))
          )}
        </div>
      )}
      {sel.length === 0 ? (
        <span className="form-error small">select at least one city (empty would allow none)</span>
      ) : null}
    </div>
  );
}

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
 * ALLOWLIST SAFEGUARD (0093 + 0094, operator 2026-07-11): the allowlist is a CHECKBOX PICKER over
 * `cityOptions` (the FULL cities.slug domain via dash_city_live().allCities — 0094; the page degrades to the
 * enrolled arms while 0094 is unapplied) ∪ the currently-stored entries — no free text, so a typo'd or
 * wrong-case slug can no longer be entered here at all. The DB is the real guarantee (trade_config_set
 * normalizes + RAISES on unknown slugs); this UI just makes the error unreachable. "All cities" is an
 * explicit radio (posts clearCityAllowlist), never an empty selection — an empty restrict-set is unsaveable.
 */
export function TradeConfigEditor({
  config,
  cityOptions = [],
}: {
  config: TradeConfig;
  /** Valid allowlist targets (the trade_config_set slug domain): slug + display label. */
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
                  <AllowlistPicker options={allowOptions} sel={allowSel} setSel={setAllowSel} />
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

// ─── (a1) Gate-override control ───────────────────────────────────────────────────────────────────────────

/**
 * The trade_gate_override control (built 2026-07-12 — remote-renewal gap): the interlock's gate branch is
 * satisfied by a forward-paper PASS or an ACTIVE ≤14-day override row; the RPCs (trade_gate_override_set /
 * _clear, 0082 §3, operator_guard inside) existed but had NO route/UI, so an expiring override could only be
 * renewed at a keyboard with DB access. Same §8.2 idiom as the config editor: TYPE validation in the route,
 * every VALUE constraint (future expiry, ≤14-day cap) is a DB RAISE shown VERBATIM. Setting/renewing an
 * override ARMS live entries (with mode=live + an open run window), so the set path fronts a confirmation;
 * clearing blocks live entries and posts immediately (the safe direction).
 */
export function GateOverridePanel({
  active,
  reason,
  expiresAt,
}: {
  /** preflight.checks.override — an ACTIVE (unexpired) override row exists. */
  active: boolean;
  /** preflight.checks.overrideReason (null when none). */
  reason?: string | null;
  /** preflight.checks.overrideExpiresAt (null when none). */
  expiresAt?: string | null;
}): ReactElement {
  const a = useAction();
  const [reasonEdit, setReasonEdit] = useState('');
  const [expiryEdit, setExpiryEdit] = useState('');
  const [noteEdit, setNoteEdit] = useState('');
  const [confirming, setConfirming] = useState(false);

  const ready = reasonEdit.trim() !== '' && expiryEdit.trim() !== '';

  const post = (body: Record<string, unknown>, okMsg: string): Promise<void> =>
    a.run(async () => {
      const r = await postJson('/api/admin/trading/gate-override', body);
      if (r.status === 200) {
        setConfirming(false);
        setReasonEdit('');
        setExpiryEdit('');
        setNoteEdit('');
        return { ok: true, msg: okMsg };
      }
      return { ok: false, msg: errText(r) };
    });

  return (
    <div className="panel">
      <p className="muted small" style={{ marginTop: 0 }}>
        The gate branch needs a forward-paper PASS <strong>or</strong> an ACTIVE operator override (RPC{' '}
        <span className="mono">trade_gate_override_set</span>, ≤14 days by DB RAISE — renewing simply adds a new
        expiring row; the audit trail keeps every row). Without either, live posting stops even inside an open
        run window. Currently:{' '}
        {active ? (
          <>
            <strong>ACTIVE</strong>
            {reason ? <> — &ldquo;{reason}&rdquo;</> : null}
            {expiresAt ? (
              <>
                {' '}
                · expires <span className="mono">{expiresAt}</span>
              </>
            ) : null}
          </>
        ) : (
          <strong>none</strong>
        )}
        .
      </p>
      {confirming ? (
        <div className="info-banner" role="dialog" aria-modal="true" style={{ borderLeftColor: 'var(--ams-amber)' }}>
          <strong style={{ color: 'var(--ams-amber)' }}>Set the gate override?</strong> With mode{' '}
          <span className="mono">live</span> and an open run window this PERMITS real-money entries until{' '}
          <span className="mono">{expiryEdit}</span> (midnight UTC). Reason: &ldquo;{reasonEdit.trim()}&rdquo;.
          <div className="form-row">
            <button
              className="primary"
              disabled={a.busy}
              onClick={() =>
                void post(
                  { reason: reasonEdit.trim(), expiresAt: expiryEdit.trim(), note: noteEdit.trim() || undefined },
                  `override set — expires ${expiryEdit.trim()}`,
                )
              }
            >
              Confirm override
            </button>
            <button disabled={a.busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <div className="form-row">
        <input
          type="text"
          placeholder="reason (required, audited)"
          value={reasonEdit}
          onChange={(e) => setReasonEdit(evVal(e))}
          style={{ width: 280 }}
        />
        <input
          className="mono"
          type="date"
          title="expires at this date's midnight UTC — the DB caps it at 14 days out"
          value={expiryEdit}
          onChange={(e) => setExpiryEdit(evVal(e))}
          style={{ width: 160 }}
        />
        <input
          type="text"
          placeholder="note (optional)"
          value={noteEdit}
          onChange={(e) => setNoteEdit(evVal(e))}
          style={{ width: 220 }}
        />
        <button className="primary" disabled={a.busy || !ready} onClick={() => setConfirming(true)}>
          {active ? 'renew override' : 'set override'}
        </button>
        {active ? (
          <button
            disabled={a.busy}
            title="expires every active override in place — live posting blocks on the next preflight"
            onClick={() => void post({ clear: true }, 'override cleared — live posting blocked')}
          >
            clear override
          </button>
        ) : null}
      </div>
      <Status msg={a.msg} ok={a.ok} />
    </div>
  );
}

// ─── (b) Buy-table price ranges panel (0097) ──────────────────────────────────────────────────────────────

/**
 * The BUY-TABLE lane's purchase-price-range editor (migration 0097): the GLOBAL max (buy_table.price_cap →
 * buy_table_price_cap_set) plus a per-city [min, max] override table over the allowlist ∪ overridden cities
 * (buy_table.city_price_ranges → buy_table_price_range_set; clear = back to the global default). Same §8.2
 * contract as the config editor: the route TYPE-validates only; the slug/range VALUE constraints RAISE in the
 * DB and are shown VERBATIM. Data comes from dash_trading().buyTable.priceConfig — null (pre-0097) renders the
 * staged-dark note, never a false empty editor.
 *
 * 0098→0099/0100 (operator directive 2026-07-12): the table additionally carries one head-column per LIVE
 * date cycle, each cell stacking the city's LOGGED lo/hi — the min/max the lane's gate price (the predicted
 * bucket's executable ask) has recorded over that cycle's entire live period — so the operator sets
 * [min, max] against observed reality. Data rides the SEPARATE fail-soft buy_table_live_cycles() RPC (the
 * 0098 inline read timed the whole console out); null (absent OR failed) hides the columns + notes it.
 */
const cents = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n * 100)}¢` : '—';
};

export function BuyTablePriceRangesPanel({
  priceConfig,
  allowlist,
  cityOptions = [],
  liveCycles,
}: {
  /** dash_trading().buyTable.priceConfig — null while migration 0097 is unapplied. */
  priceConfig: BuyTablePriceConfig | null;
  /** trade_config.city_allowlist (null = all cities) — the base row set of the per-city table. */
  allowlist: string[] | null;
  /** Valid override targets (the buy_table_price_range_set slug domain): slug + display label. */
  cityOptions?: { slug: string; label: string }[];
  /** dash_trading().buyTable.liveCycles (0098) — null while migration 0098 is unapplied. */
  liveCycles?: BuyTableLiveCycle[] | null;
}): ReactElement {
  const a = useAction();
  const [edits, setEdits] = useState<Record<string, { min: string; max: string }>>({});
  const [globalEdit, setGlobalEdit] = useState<string>('');
  const [added, setAdded] = useState<string[]>([]);
  const [addSel, setAddSel] = useState<string>('');

  if (!priceConfig) {
    return (
      <div className="panel">
        <div className="cap" style={{ marginBottom: '0.25rem' }}>Buy-table price ranges</div>
        <p className="muted small" style={{ marginTop: 0 }}>
          <strong style={{ color: 'var(--ams-amber)' }}>0097 not applied</strong> — the{' '}
          <span className="mono">dash_trading()</span> payload carries no{' '}
          <span className="mono">buyTable.priceConfig</span> yet. The per-city purchase-price ranges (global cap +{' '}
          <span className="mono">buy_table.city_price_ranges</span> overrides) unlock the moment the operator
          applies migration <span className="mono">0097_buy_table_price_ranges.sql</span>. Until then the lane
          trades on the global <span className="mono">buy_table.price_cap</span> alone.
        </p>
      </div>
    );
  }

  const ranges = priceConfig.cityRanges ?? {};
  const globalCur = curStr(priceConfig.globalMax);
  const labelOf = (slug: string): string => cityOptions.find((o) => o.slug === slug)?.label ?? slug;

  // Rows = allowlist ∪ overridden ∪ locally-added (the add-row below), lower-cased + deduped + sorted.
  const rowSlugs = [
    ...new Set([...(allowlist ?? []).map((s) => s.toLowerCase()), ...Object.keys(ranges).map((s) => s.toLowerCase()), ...added]),
  ].sort();
  const addable = cityOptions.filter((o) => !rowSlugs.includes(o.slug));

  // 0098: pivot liveCycles into per-date head-columns (dates unioned across cities, ascending); each city row
  // stacks the cycle's logged lo / hi — the min/max of the lane's gate price over the cycle's live period.
  const cycles = liveCycles ?? [];
  const cycleDates = [...new Set(cycles.map((c) => c.targetDate))].sort();
  const cycleBy = new Map(cycles.map((c) => [`${c.city}|${c.targetDate}`, c]));

  const minOf = (slug: string): string => edits[slug]?.min ?? curStr(ranges[slug]?.min);
  const maxOf = (slug: string): string => edits[slug]?.max ?? curStr(ranges[slug]?.max);
  const patch = (slug: string, key: 'min' | 'max', v: string): void =>
    setEdits((p) => ({
      ...p,
      [slug]: {
        min: key === 'min' ? v : (p[slug]?.min ?? minOf(slug)),
        max: key === 'max' ? v : (p[slug]?.max ?? maxOf(slug)),
      },
    }));

  const post = (body: Record<string, unknown>, okMsg: string): Promise<void> =>
    a.run(async () => {
      const r = await postJson('/api/admin/trading/buy-table-price', body);
      if (r.status === 200) {
        setEdits({});
        setGlobalEdit('');
        return { ok: true, msg: okMsg };
      }
      return { ok: false, msg: errText(r) };
    });

  return (
    <div className="panel">
      <div className="cap" style={{ marginBottom: '0.25rem' }}>Buy-table price ranges</div>
      <p className="muted small" style={{ marginTop: 0 }}>
        The BUY-TABLE lane enters only while the predicted bucket&apos;s executable ask sits inside the city&apos;s{' '}
        <strong>[min, max]</strong> purchase range. No override = the global default{' '}
        <span className="mono">[0, {globalCur || '0.15'}]</span>. Range guardrails are the database&apos;s
        (slug must exist, 0 ≤ min &lt; max ≤ 0.99, cap in (0, 0.99]) and any rejection is shown{' '}
        <strong>verbatim</strong>. Date columns show each <strong>live cycle&apos;s logged lo / hi</strong> — the
        lowest and highest the lane&apos;s gate price (the predicted bucket&apos;s ask) has been over that
        cycle&apos;s entire live period so far — so ranges are set against observed reality.
      </p>
      <div className="form-row" style={{ marginBottom: 8 }}>
        <span>Global max</span>
        <span className="mono">{globalCur || '—'}</span>
        <input
          className="mono"
          type="number"
          min="0.01"
          max="0.99"
          step="0.01"
          style={{ width: 90 }}
          placeholder={globalCur}
          value={globalEdit}
          onChange={(e) => setGlobalEdit(evVal(e))}
        />
        <button
          className="primary"
          disabled={a.busy || globalEdit.trim() === '' || globalEdit.trim() === globalCur}
          onClick={() => void post({ globalMax: Number(globalEdit) }, `global max set to ${globalEdit}`)}
        >
          save global max
        </button>
      </div>
      {rowSlugs.length === 0 ? (
        <p className="muted small">
          No allowlist cities and no overrides yet — restrict the allowlist above or add a city override below.
        </p>
      ) : (
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>city</th>
                <th>current range</th>
                {cycleDates.map((d) => (
                  <th
                    key={d}
                    className="num"
                    title={`live cycle ${d} — the logged lo / hi of the lane's gate price over the cycle's live period so far`}
                  >
                    {d.slice(5)}
                    <div className="muted small" style={{ fontWeight: 'normal' }}>
                      lo / hi
                    </div>
                  </th>
                ))}
                <th className="num">min</th>
                <th className="num">max</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rowSlugs.map((slug) => {
                const r = ranges[slug];
                const minStr = minOf(slug);
                const maxStr = maxOf(slug);
                return (
                  <tr key={slug}>
                    <td>
                      {labelOf(slug)} <span className="muted small mono">{slug}</span>
                    </td>
                    <td className="mono small" title={`no override = the global [0, ${globalCur || '0.15'}]`}>
                      {r ? `[${curStr(r.min)}, ${curStr(r.max)}]` : 'default'}
                    </td>
                    {cycleDates.map((d) => {
                      const cyc = cycleBy.get(`${slug}|${d}`);
                      return (
                        <td key={d} className="num mono small">
                          {cyc ? (
                            <div
                              title={`${labelOf(slug)} ${d}: gate price logged over ${curStr(cyc.nTicks)} capture ticks (${curStr(cyc.firstAt).slice(0, 16)} → ${curStr(cyc.lastAt).slice(0, 16)} UTC)`}
                            >
                              <div>{cents(cyc.minAsk)}</div>
                              <div>{cents(cyc.maxAsk)}</div>
                            </div>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="num">
                      <input
                        className="mono"
                        type="number"
                        min="0"
                        max="0.99"
                        step="0.01"
                        placeholder="0"
                        style={{ width: 80 }}
                        value={minStr}
                        onChange={(e) => patch(slug, 'min', evVal(e))}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="mono"
                        type="number"
                        min="0"
                        max="0.99"
                        step="0.01"
                        placeholder={globalCur}
                        style={{ width: 80 }}
                        value={maxStr}
                        onChange={(e) => patch(slug, 'max', evVal(e))}
                      />
                    </td>
                    <td>
                      <button
                        disabled={a.busy || minStr.trim() === '' || maxStr.trim() === ''}
                        onClick={() =>
                          void post(
                            { city: slug, min: Number(minStr), max: Number(maxStr) },
                            `${slug} range set to [${minStr}, ${maxStr}]`,
                          )
                        }
                      >
                        save
                      </button>{' '}
                      {r ? (
                        <button
                          disabled={a.busy}
                          title="remove the override — back to the global [0, max] default"
                          onClick={() => void post({ city: slug, clear: true }, `${slug} override cleared`)}
                        >
                          clear
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {liveCycles == null ? (
        <p className="muted small">
          <strong style={{ color: 'var(--ams-amber)' }}>live-cycle columns unavailable</strong> — the{' '}
          <span className="mono">buy_table_live_cycles()</span> read (migration{' '}
          <span className="mono">0099</span>/<span className="mono">0100</span>) is not applied or failed this
          load. The console renders without the <span className="mono">lo / hi</span> date columns by design —
          they can never take this page down.
        </p>
      ) : cycleDates.length === 0 ? (
        <p className="muted small">No live date cycles with logged gate prices right now.</p>
      ) : null}
      {addable.length > 0 ? (
        <div className="form-row">
          <span className="muted small">add override for</span>
          <select value={addSel} onChange={(e) => setAddSel(evVal(e))}>
            <option value="">— pick a city —</option>
            {addable.map((o) => (
              <option key={o.slug} value={o.slug}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={addSel === ''}
            onClick={() => {
              if (addSel !== '') {
                setAdded((p) => (p.includes(addSel) ? p : [...p, addSel]));
                setAddSel('');
              }
            }}
          >
            add
          </button>
        </div>
      ) : null}
      <Status msg={a.msg} ok={a.ok} />
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
