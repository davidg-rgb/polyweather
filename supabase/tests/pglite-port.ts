/**
 * PGlite-backed DbPort — the test twin of functions/_shared/db.ts supabasePort.
 * rpc() calls the SAME 0011 SQL functions production calls via PostgREST, so
 * the race-critical semantics are tested against the real implementation.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { DbPort } from '../functions/_shared/db.ts';

/** Positional arg order per SQL function (PostgREST passes by name; PGlite needs positions). */
const FN_ARGS: Record<string, string[]> = {
  claim_job_run: ['p_job', 'p_period_key', 'p_wall_limit_sec'],
  complete_job_run: ['p_run_id', 'p_attempt', 'p_status', 'p_stats', 'p_error', 'p_duration_ms'],
  claim_alert: ['p_kind', 'p_severity', 'p_dedupe_key', 'p_title', 'p_body'],
  mark_alert_sent: ['p_alert_id'],
  get_city_state: ['p_slug'],
  upsert_city: ['p_slug', 'p_display_name', 'p_country_code', 'p_unit', 'p_tz', 'p_region'],
  ensure_station: ['p_icao', 'p_country_code', 'p_tz'],
  swap_station: ['p_city_id', 'p_icao', 'p_wu_cc', 'p_source_url'],
  upsert_event: [
    'p_poly_event_id', 'p_slug', 'p_kind', 'p_city_id', 'p_icao', 'p_target_date', 'p_unit',
    'p_neg_risk_market_id', 'p_accepting', 'p_volume24h', 'p_liquidity', 'p_ladder_ok', 'p_ladder_problems',
  ],
  upsert_bucket: [
    'p_event_id', 'p_bucket_idx', 'p_label', 'p_low', 'p_high', 'p_poly_market_id',
    'p_condition_id', 'p_token_yes', 'p_token_no', 'p_tick', 'p_min_order', 'p_fee_rate',
  ],
  close_stale_events: ['p_seen_poly_ids'],
  get_grading_context: ['p_event_id'],
  claim_event_winner: ['p_event_id', 'p_winner_idx'],
  flag_grading_mismatch: ['p_event_id'],
  settle_bets: ['p_event_id', 'p_winner_idx', 'p_resolution_native'],
  score_distributions: ['p_event_id', 'p_winner_idx', 'p_cutoff_lead0', 'p_cutoff_lead1'],
  city_loss_streaks: [],
  apply_halt: ['p_scope', 'p_reason'],
  list_active_stations: [],
  list_enabled_models: ['p_is_ensemble'],
  upsert_forecast_rows: ['p_rows'],
  forecast_gap_matrix: ['p_days'],
  bump_model_null_streak: ['p_model', 'p_was_null'],
  upsert_ensemble_rows: ['p_rows'],
  list_truth_stations: [],
  finalized_dates: ['p_icao', 'p_from', 'p_to'],
  upsert_observation: ['p_icao', 'p_date', 'p_tmax', 'p_unit', 'p_n_obs'],
  finalize_observation: ['p_icao', 'p_date', 'p_metar_tenths', 'p_metar_native', 'p_iem_f', 'p_era5_c', 'p_divergence'],
  set_config_value: ['p_key', 'p_value'],
  events_for_grading: ['p_icao', 'p_date'],
  upsert_intraday: ['p_icao', 'p_date', 'p_max_tenths', 'p_max_native', 'p_n_obs'],
  nowcast_targets: [],
  list_buildable_events: [],
  get_build_inputs: ['p_event_id'],
  upsert_distribution: [
    'p_event_id', 'p_source', 'p_lead', 'p_nowcast', 'p_inputs_hash',
    'p_probs', 'p_mu', 'p_sigma', 'p_stats_version',
  ],
};

export function pglitePort(db: PGlite): DbPort {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
      const order = FN_ARGS[fn];
      if (!order) throw new Error(`pglitePort: unknown rpc '${fn}' — add it to FN_ARGS`);
      const params = order.map((name) => {
        const v = args[name];
        if (Array.isArray(v)) {
          // arrays of primitives → PG array literal (text[]/uuid[] params);
          // arrays of objects → jsonb payload (e.g. upsert_*_rows p_rows)
          if (v.every((x) => x === null || typeof x !== 'object')) {
            return `{${v.map((x) => `"${String(x).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
          }
          return JSON.stringify(v);
        }
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
      });
      const placeholders = order.map((_, i) => `$${i + 1}`).join(', ');
      const res = await db.query<T>(`select * from public.${fn}(${placeholders})`, params);
      return res.rows;
    },
    async getConfigRows(): Promise<{ key: string; value: string }[]> {
      const res = await db.query<{ key: string; value: string }>('select key, value from config');
      return res.rows;
    },
  };
}
