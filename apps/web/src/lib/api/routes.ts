/**
 * §8.2 operator API route handlers — contracts verbatim (ARCHITECTURE.md
 * §8.2, §6.21). Framework-free: every handler is (Request, ApiDeps[, id]) →
 * Response so the suite drives them against PGlite + the REAL execute-bet
 * handler. Mutations go through the 0021 SECURITY DEFINER operator_* RPCs
 * (is_operator() SQL guard = defense-in-depth behind the session check here);
 * the service-role key never ships to the web tier (§11.5).
 */
import { ConfigError, ConfigSchema, parseConfigRows, pairedBootstrapPValue } from '@weather-edge/core';
import { json, type ApiDeps } from './deps.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Session + allow-listed email gate — null when authorized, the 401 otherwise. */
export async function requireOperator(deps: ApiDeps): Promise<Response | null> {
  const email = await deps.getSessionEmail();
  if (!email || email !== deps.operatorEmail) {
    return json(401, { error: 'ERR_AUTH' });
  }
  return null;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown;
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Relay a proxied Edge Function response verbatim (status + JSON body). */
async function relay(res: Response): Promise<Response> {
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// --- [POST] /api/bets/{id}/approve — THIN PROXY to execute-bet (ADR-10) -------
export async function approveBet(req: Request, deps: ApiDeps, betId: string): Promise<Response> {
  const denied = await requireOperator(deps);
  if (denied) return denied;
  if (!UUID_RE.test(betId)) return json(404, { error: 'ERR_NOT_FOUND' });

  // fast 404 pre-check (§6.21) before the function round trip
  const [row] = await deps.db.rpc<{ bet_for_execution: unknown }>('bet_for_execution', {
    p_bet_id: betId,
  });
  if (!row?.bet_for_execution) return json(404, { error: 'ERR_NOT_FOUND' });

  return relay(await deps.proxyExecuteBet({ betId }));
}

// --- [POST] /api/bets/{id}/skip ------------------------------------------------
export async function skipBet(req: Request, deps: ApiDeps, betId: string): Promise<Response> {
  const denied = await requireOperator(deps);
  if (denied) return denied;
  if (!UUID_RE.test(betId)) return json(404, { error: 'ERR_NOT_FOUND' });
  const body = await readBody(req);

  const [r] = await deps.db.rpc<{ operator_skip_bet: string }>('operator_skip_bet', {
    p_bet_id: betId,
    p_reason: typeof body['reason'] === 'string' ? body['reason'] : '',
  });
  switch (r?.operator_skip_bet) {
    case 'ok':
      return json(200, { ok: true });
    case 'bad_status':
      return json(409, { error: 'ERR_BAD_STATUS' });
    default:
      return json(404, { error: 'ERR_NOT_FOUND' });
  }
}

// --- [POST] /api/admin/halt ------------------------------------------------------
export async function adminHalt(req: Request, deps: ApiDeps): Promise<Response> {
  const denied = await requireOperator(deps);
  if (denied) return denied;
  const body = await readBody(req);
  const scope = body['scope'];
  const city = body['city'];
  const lead = body['lead'];
  const reason = body['reason'];

  const details: string[] = [];
  if (scope !== 'global' && scope !== 'city' && scope !== 'city_lead') {
    details.push(`scope must be global|city|city_lead, got '${String(scope)}'`);
  }
  if ((scope === 'city' || scope === 'city_lead') && (typeof city !== 'string' || city.length === 0)) {
    details.push('city required for city/city_lead scope');
  }
  if (scope === 'city_lead' && (typeof lead !== 'number' || !Number.isInteger(lead) || lead < 0)) {
    details.push('lead must be a non-negative integer for city_lead scope');
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    details.push('reason required');
  }
  if (details.length > 0) return json(400, { error: 'ERR_VALIDATION', details });

  const haltScope =
    scope === 'global' ? 'global' : scope === 'city' ? `city:${String(city)}` : `city_lead:${String(city)}:${String(lead)}`;
  const [r] = await deps.db.rpc<{ operator_halt: string }>('operator_halt', {
    p_scope: haltScope,
    p_reason: reason,
  });
  const haltKey = r!.operator_halt;
  await deps.notify({
    kind: 'OPERATOR_HALT',
    severity: 'CRITICAL',
    title: `Operator halt applied: ${haltKey}`,
    body: String(reason),
    dedupeKey: `operator-halt:${haltKey}`,
  });
  return json(200, { ok: true, haltKey });
}

// --- [POST] /api/admin/resume (typed confirmation) -------------------------------
export async function adminResume(req: Request, deps: ApiDeps): Promise<Response> {
  const denied = await requireOperator(deps);
  if (denied) return denied;
  const body = await readBody(req);
  const haltKey = body['haltKey'];
  const confirm = body['confirm'];
  if (typeof haltKey !== 'string' || confirm !== haltKey) {
    return json(400, { error: 'ERR_CONFIRM_MISMATCH' });
  }
  const [r] = await deps.db.rpc<{ operator_resume: boolean }>('operator_resume', {
    p_halt_key: haltKey,
  });
  return r?.operator_resume ? json(200, { ok: true }) : json(404, { error: 'ERR_NOT_FOUND' });
}

// --- [POST] /api/admin/config — validate MERGED config, then write + audit -------
const WARN_KEYS = new Set(['bankrollUsd', 'kellyFraction', 'perTradeCapPct', 'perEventCapPct', 'clusterCapPct', 'dailyCapPct']);

export async function adminUpdateConfig(req: Request, deps: ApiDeps): Promise<Response> {
  const denied = await requireOperator(deps);
  if (denied) return denied;
  const body = await readBody(req);
  const changes = body['changes'];
  if (!Array.isArray(changes) || changes.length === 0) {
    return json(400, { error: 'ERR_VALIDATION', details: [{ key: 'changes', message: 'non-empty array required' }] });
  }

  const schemaKeys = new Set(Object.keys(ConfigSchema.shape));
  const details: { key: string; message: string }[] = [];
  const typed: { key: string; value: string }[] = [];
  for (const c of changes as unknown[]) {
    const key = (c as Record<string, unknown>)?.['key'];
    const value = (c as Record<string, unknown>)?.['value'];
    if (typeof key !== 'string' || typeof value !== 'string') {
      details.push({ key: String(key), message: 'key and value must be strings' });
    } else if (!schemaKeys.has(key)) {
      details.push({ key, message: 'unknown config key' });
    } else {
      typed.push({ key, value });
    }
  }
  if (typed.length > 0) {
    // Validate the MERGED result exactly as every job will parse it (§6.11) —
    // run it even when unknown keys were already flagged, so the operator
    // sees EVERY problem in one shot.
    const merged = new Map((await deps.db.getConfigRows()).map((r) => [r.key, r.value]));
    for (const c of typed) merged.set(c.key, c.value);
    try {
      parseConfigRows([...merged.entries()].map(([key, value]) => ({ key, value })));
    } catch (e) {
      if (e instanceof ConfigError) {
        const invalid = (e.details?.['invalid'] as { key: string; reason: string }[] | undefined) ?? [];
        details.push(...invalid.map((i) => ({ key: i.key, message: i.reason })));
      } else {
        throw e;
      }
    }
  }
  if (details.length > 0) return json(400, { error: 'ERR_VALIDATION', details });

  const [r] = await deps.db.rpc<{ operator_update_config: number }>('operator_update_config', {
    p_changes: typed,
  });
  const warnChanges = typed.filter((c) => WARN_KEYS.has(c.key));
  if (warnChanges.length > 0) {
    await deps.notify({
      kind: 'CONFIG_CHANGE',
      severity: 'WARN',
      title: `Bankroll/caps config changed (${warnChanges.length} key(s))`,
      body: warnChanges.map((c) => `${c.key} → ${c.value}`).join('\n'),
      dedupeKey: `config-change:${deps.now().toISOString().slice(0, 10)}`,
    });
  }
  return json(200, { ok: true, applied: Number(r?.operator_update_config ?? 0) });
}

// --- [POST] /api/admin/verify-station --------------------------------------------
export async function adminVerifyStation(req: Request, deps: ApiDeps): Promise<Response> {
  const denied = await requireOperator(deps);
  if (denied) return denied;
  const body = await readBody(req);
  const id = body['cityStationId'];
  if (typeof id !== 'string' || !UUID_RE.test(id)) return json(404, { error: 'ERR_NOT_FOUND' });
  const [r] = await deps.db.rpc<{ operator_verify_station: string }>('operator_verify_station', {
    p_city_station_id: id,
  });
  switch (r?.operator_verify_station) {
    case 'ok':
      return json(200, { ok: true });
    case 'not_current':
      return json(409, { error: 'ERR_NOT_CURRENT' });
    default:
      return json(404, { error: 'ERR_NOT_FOUND' });
  }
}

// --- [POST] /api/admin/trigger-job — server-side CRON_SECRET proxy ----------------
const KNOWN_JOBS = new Set([
  'discover-markets', 'snapshot-forecasts', 'snapshot-ensembles', 'fetch-actuals',
  'metar-nowcast', 'build-distributions', 'poll-markets', 'run-calibration',
  'grade-bets', 'daily-digest', 'health-monitor',
]);

export async function adminTriggerJob(req: Request, deps: ApiDeps): Promise<Response> {
  const denied = await requireOperator(deps);
  if (denied) return denied;
  const body = await readBody(req);
  const job = body['job'];
  if (typeof job !== 'string' || !KNOWN_JOBS.has(job)) {
    return json(400, { error: 'ERR_UNKNOWN_JOB' });
  }
  const periodKey = `${job}:manual:${deps.now().toISOString()}`;
  let res: Response;
  try {
    res = await deps.proxyTriggerJob(job, periodKey);
  } catch {
    return json(502, { error: 'ERR_JOB_UNREACHABLE' });
  }
  if (res.status === 202) return json(200, { accepted: true, periodKey });
  if (res.status === 409) return relay(res); // already ran — idempotency surfaced honestly
  return json(502, { error: 'ERR_JOB_UNREACHABLE' });
}

// --- [POST] /api/admin/promote-source — F-019 re-checked SERVER-SIDE --------------
export async function adminPromoteSource(req: Request, deps: ApiDeps): Promise<Response> {
  const denied = await requireOperator(deps);
  if (denied) return denied;
  const body = await readBody(req);
  const source = body['source'];

  const reasons: string[] = [];
  if (source !== 'house_gaussian' && source !== 'house_ensemble') {
    reasons.push(`unknown source '${String(source)}'`);
    return json(409, { error: 'ERR_GATE_FAILED', reasons });
  }
  const cfg = parseConfigRows(await deps.db.getConfigRows());
  if (cfg.championSource === source) {
    return json(409, { error: 'ERR_GATE_FAILED', reasons: [`'${source}' is already the champion`] });
  }

  // F-019: ≥60 out-of-sample days ∧ paired bootstrap p < 0.05 vs market_consensus
  // ∧ ≥5% better point estimate — never trusting the UI's claim.
  const [r] = await deps.db.rpc<{
    promotion_check_rows: { days: number; pairs: { cand: number; market: number }[] };
  }>('promotion_check_rows', { p_candidate: source });
  const check = r!.promotion_check_rows;
  const pairs = check.pairs.map((p) => ({ cand: Number(p.cand), market: Number(p.market) }));

  if (check.days < 60) reasons.push(`only ${check.days} distinct out-of-sample days (need ≥60)`);
  if (pairs.length === 0) {
    reasons.push('no time-matched (event, lead) pairs vs market_consensus in 60d');
  } else {
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const candMean = mean(pairs.map((p) => p.cand));
    const marketMean = mean(pairs.map((p) => p.market));
    if (!(candMean <= 0.95 * marketMean)) {
      reasons.push(`point estimate ${candMean.toFixed(4)} not ≤ 0.95× market (${(0.95 * marketMean).toFixed(4)})`);
    }
    // n < 30 pairs ⇒ pairedBootstrapPValue returns 1.0 ⇒ fails here by design.
    const p = pairedBootstrapPValue(pairs.map((x) => x.cand - x.market));
    if (!(p < 0.05)) {
      reasons.push(`paired bootstrap p ${p.toFixed(4)} not < 0.05`);
    }
  }
  if (reasons.length > 0) return json(409, { error: 'ERR_GATE_FAILED', reasons });

  await deps.db.rpc('operator_set_champion', { p_source: source });
  return json(200, { ok: true, champion: source });
}

// --- [POST] /api/admin/manual-bet (F-035) ------------------------------------------
export async function adminManualBet(req: Request, deps: ApiDeps): Promise<Response> {
  const denied = await requireOperator(deps);
  if (denied) return denied;
  const body = await readBody(req);

  const details: string[] = [];
  const eventSlug = body['eventSlug'];
  const bucketLabel = body['bucketLabel'];
  const side = body['side'] ?? 'YES';
  const shares = body['shares'];
  const price = body['price'];
  const mode = body['mode'];
  const executedExternally = body['executedExternally'] === true;
  if (typeof eventSlug !== 'string' || eventSlug.length === 0) details.push('eventSlug required');
  if (typeof bucketLabel !== 'string' || bucketLabel.length === 0) details.push('bucketLabel required');
  if (side !== 'YES' && side !== 'NO') details.push("side must be 'YES'|'NO'");
  if (typeof shares !== 'number' || !(shares > 0) || shares !== Math.floor(shares)) {
    details.push('shares must be a positive whole number');
  }
  // §8.2 marks price optional; the standard fill path needs a stored executable
  // ask to be pessimistic against, so it is required here (BUILD-STATE deviation).
  if (typeof price !== 'number' || !(price > 0 && price < 1)) details.push('price required, in (0,1)');
  if (mode !== 'paper' && mode !== 'live') details.push("mode must be 'paper'|'live'");
  if (details.length > 0) return json(400, { error: 'ERR_VALIDATION', details });

  const [r] = await deps.db.rpc<{ operator_manual_bet: { outcome: string; betId?: string } }>(
    'operator_manual_bet',
    {
      p_event_slug: eventSlug, p_bucket_label: bucketLabel, p_side: side,
      p_shares: shares, p_price: price, p_mode: mode, p_actor: deps.operatorEmail,
    },
  );
  const out = r!.operator_manual_bet;
  if (out.outcome === 'not_found') return json(404, { error: 'ERR_NOT_FOUND' });
  if (out.outcome === 'open_rec_exists') {
    return json(409, { error: 'ERR_BAD_STATUS', status: 'open_rec_exists' });
  }
  const betId = out.betId!;

  if (executedExternally) {
    // live external fill: record executed_* verbatim (the order already happened).
    await deps.db.rpc('operator_record_external_fill', {
      p_bet_id: betId, p_price: price, p_shares: shares,
    });
    return json(200, { betId });
  }
  // standard fill path through the chokepoint (paper, or gated live)
  const res = await deps.proxyExecuteBet({ betId });
  if (res.status !== 200) return relay(res);
  const fill = ((await res.json()) as { fill: Record<string, unknown> }).fill;
  return json(200, { betId, fill });
}

// --- [POST] /api/admin/export — K4-ready CSV (R-16) ---------------------------------
const CSV_COLUMNS = ['type', 'date', 'event', 'bucket', 'side', 'mode', 'shares', 'price', 'amount_usd', 'fee_usd', 'pnl_usd'] as const;

export async function adminExport(req: Request, deps: ApiDeps): Promise<Response> {
  const denied = await requireOperator(deps);
  if (denied) return denied;
  const body = await readBody(req);
  const from = body['from'];
  const to = body['to'];
  const mode = body['mode'];
  if (
    typeof from !== 'string' || !DATE_RE.test(from) ||
    typeof to !== 'string' || !DATE_RE.test(to) || from > to ||
    (mode !== undefined && mode !== 'paper' && mode !== 'live')
  ) {
    return json(400, { error: 'ERR_VALIDATION' });
  }

  const lines = await deps.db.rpc<{ line: Record<string, unknown> }>('operator_export_rows', {
    p_from: from, p_to: to, p_mode: mode ?? null,
  });
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const keyOf: Record<(typeof CSV_COLUMNS)[number], string> = {
    type: 'type', date: 'date', event: 'event', bucket: 'bucket', side: 'side', mode: 'mode',
    shares: 'shares', price: 'price', amount_usd: 'amountUsd', fee_usd: 'feeUsd', pnl_usd: 'pnlUsd',
  };
  const csv = [
    CSV_COLUMNS.join(','),
    ...lines.map((r) => CSV_COLUMNS.map((c) => esc(r.line[keyOf[c]])).join(',')),
  ].join('\n');
  return new Response(csv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
}

// --- [GET] /api/health — the out-of-band uptime probe (R-18); NO auth ---------------
export async function healthCheck(_req: Request, deps: ApiDeps): Promise<Response> {
  try {
    const [r] = await deps.db.rpc<{ health_check: { newestJobRun: string | null } }>('health_check', {});
    return json(200, { db: 'ok', newestJobRun: r?.health_check?.newestJobRun ?? null });
  } catch {
    return json(503, { db: 'down' });
  }
}
