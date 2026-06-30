export const meta = {
  name: 'tune-maker-exit',
  description: 'Agent-team coordinate optimization of the maker-exit convergence strategy to maximize net profit (<=3 rounds, early-stop on no-gain)',
  phases: [
    { title: 'Baseline' },
    { title: 'Round 1' },
    { title: 'Round 2' },
    { title: 'Round 3' },
    { title: 'Final' },
  ],
}

const SIM = 'pnpm tsx scripts/research/sim-maker-exit.ts --from-cache'
const REBATE = 0.05
const EPS = 0.001

const COORDS = [
  { key: 'tp', flag: 'tp', vals: [0.04, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20] },
  { key: 'sl', flag: 'sl', vals: [0.08, 0.12, 0.16, 0.20, 0.30, 0.99] },
  { key: 'tstopHours', flag: 'tstop-hours', vals: [3, 6, 9, 12, 18, 24] },
  { key: 'chw', flag: 'chw', vals: [0, 1, 2] },
  { key: 'maxEntry', flag: 'max-entry', vals: [0.18, 0.22, 0.26, 0.30, 0.35] },
  { key: 'depth', flag: 'depth', vals: [25, 50, 75, 100, 150] },
  { key: 'makerWindow', flag: 'maker-window', vals: [15, 30, 45, 60, 90] },
]

const flagsOf = (p) =>
  '--tp ' + p.tp + ' --sl ' + p.sl + ' --tstop-hours ' + p.tstopHours + ' --chw ' + p.chw +
  ' --max-entry ' + p.maxEntry + ' --depth ' + p.depth + ' --maker-window ' + p.makerWindow

const COORD_SCHEMA = {
  type: 'object',
  properties: {
    coord: { type: 'string' },
    bestValue: { type: 'number' },
    bestObjective: { type: 'number' },
    baselineObjective: { type: 'number' },
    atBoundary: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['coord', 'bestValue', 'bestObjective', 'baselineObjective'],
  additionalProperties: true,
}
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          objective: { type: 'number' },
          totalNetUsd: { type: 'number' },
          winFrac: { type: 'number' },
          verdict: { type: 'string' },
        },
        required: ['label', 'objective'],
      },
    },
  },
  required: ['candidates'],
}

const OBJ_RULE =
  'The OBJECTIVE for a run is its meanNetReturn, BUT only when nRealized >= 40 (the gate count floor) — otherwise the objective is -1. Maximize the objective.'
const CWD_NOTE =
  'Run from the repo root (the session cwd; do NOT cd). Each command prints one line per run of the form: RESULT {json}. Parse those JSON objects from stdout. Do not modify files; run only the command(s) given.'

function coordAgent(coord, incumbent, phaseName) {
  const cmd = SIM + ' --rebate ' + REBATE + ' ' + flagsOf(incumbent) + ' --sweep "' + coord.flag + ':' + coord.vals.join(',') + '"'
  const incVal = incumbent[coord.key]
  return agent(
    'Line-search ONE parameter of the maker-exit convergence simulation to maximize net profit. ' + CWD_NOTE + '\n\n' +
      'Run EXACTLY this one command:\n\n' + cmd + '\n\n' +
      'Each RESULT json has: sweepValue, meanNetReturn, totalNetUsd, nRealized, winFrac, verdict. ' + OBJ_RULE + '\n' +
      'The incumbent value of this coordinate is ' + incVal + ' (its objective is the baselineObjective).\n' +
      'Return: coord="' + coord.key + '", bestValue (the sweepValue with the highest objective), bestObjective, ' +
      'baselineObjective (the objective at the value closest to ' + incVal + '), ' +
      'atBoundary (true iff bestValue is the first or last in the swept list ' + JSON.stringify(coord.vals) + '), and a one-line note.',
    { schema: COORD_SCHEMA, label: 'tune:' + coord.key, phase: phaseName },
  )
}

function verifyAgent(candidates, phaseName) {
  const lines = candidates.map((c) => c.label + ': ' + SIM + ' --rebate ' + REBATE + ' ' + flagsOf(c.params)).join('\n')
  return agent(
    'Evaluate these candidate parameter sets by running each command and reading its RESULT {json} stdout line. ' + CWD_NOTE + '\n\n' +
      lines + '\n\n' + OBJ_RULE + '\n' +
      'Return candidates[] in the SAME order, each: label, objective, totalNetUsd, winFrac, verdict.',
    { schema: VERIFY_SCHEMA, label: 'verify:combined', phase: phaseName },
  )
}

phase('Baseline')
let incumbent = { tp: 0.10, sl: 0.20, tstopHours: 12, chw: 0, maxEntry: 0.30, depth: 100, makerWindow: 15 }
const base = await agent(
  'Establish the baseline objective for the maker-exit convergence simulation. ' + CWD_NOTE + '\n\n' +
    'Run EXACTLY:\n\n' + SIM + ' --rebate ' + REBATE + ' ' + flagsOf(incumbent) + '\n\n' +
    'Read the RESULT {json} stdout line. ' + OBJ_RULE + '\n' +
    'Return: coord="baseline", bestValue=0, bestObjective=<the objective>, baselineObjective=<the same objective>, ' +
    'note=<short summary: realized, winFrac, meanNetReturn, total, verdict>.',
  { schema: COORD_SCHEMA, label: 'baseline', phase: 'Baseline' },
)
let incumbentObjective = base && Number.isFinite(base.bestObjective) ? base.bestObjective : -1
log('baseline objective (rebate ' + REBATE + ', incumbent): ' + incumbentObjective.toFixed(4) + ' — ' + (base ? base.note : ''))

const trajectory = [{ round: 0, params: { ...incumbent }, objective: incumbentObjective }]

for (let round = 1; round <= 3; round++) {
  const phaseName = 'Round ' + round
  phase(phaseName)
  log('Round ' + round + ': incumbent ' + JSON.stringify(incumbent) + ' obj ' + incumbentObjective.toFixed(4))

  const results = (await parallel(COORDS.map((c) => () => coordAgent(c, incumbent, phaseName)))).filter(Boolean)

  const improving = results
    .filter((r) => Number.isFinite(r.bestObjective) && r.bestObjective > incumbentObjective + EPS)
    .sort((a, b) => b.bestObjective - a.bestObjective)
  log('Round ' + round + ': ' + improving.length + ' coordinates improved — ' +
    (improving.map((r) => r.coord + '=' + r.bestValue + '(' + r.bestObjective.toFixed(4) + ')').join(', ') || 'none'))

  const applyTop = (n) => {
    const p = { ...incumbent }
    for (const r of improving.slice(0, n)) p[r.coord] = r.bestValue
    return p
  }
  const candidates = []
  if (improving.length >= 2) candidates.push({ label: 'all-improving', params: applyTop(improving.length) })
  if (improving.length >= 3) candidates.push({ label: 'top3', params: applyTop(3) })
  if (improving.length >= 2) candidates.push({ label: 'top2', params: applyTop(2) })

  const pool = []
  if (improving.length >= 1) pool.push({ label: 'single:' + improving[0].coord, params: applyTop(1), objective: improving[0].bestObjective })
  if (candidates.length) {
    const verified = await verifyAgent(candidates, phaseName)
    const vlist = verified && Array.isArray(verified.candidates) ? verified.candidates : []
    for (const v of vlist) {
      const c = candidates.find((x) => x.label === v.label)
      if (c && Number.isFinite(v.objective)) pool.push({ label: v.label, params: c.params, objective: v.objective, totalNetUsd: v.totalNetUsd, winFrac: v.winFrac, verdict: v.verdict })
    }
  }

  pool.sort((a, b) => b.objective - a.objective)
  const roundBest = pool[0]
  if (!roundBest || roundBest.objective <= incumbentObjective + EPS) {
    log('Round ' + round + ': NO GAIN (best ' + (roundBest ? roundBest.objective.toFixed(4) : 'none') + ' <= incumbent ' + incumbentObjective.toFixed(4) + ') — STOP.')
    trajectory.push({ round, params: { ...incumbent }, objective: incumbentObjective, stopped: 'no_gain' })
    break
  }
  incumbent = { ...roundBest.params }
  incumbentObjective = roundBest.objective
  log('Round ' + round + ': NEW incumbent (' + roundBest.label + ') obj ' + incumbentObjective.toFixed(4) + ' — ' + JSON.stringify(incumbent))
  trajectory.push({ round, params: { ...incumbent }, objective: incumbentObjective, via: roundBest.label })
}

phase('Final')
const finalEval = await agent(
  'Produce the FINAL evaluation of the tuned maker-exit strategy. ' + CWD_NOTE + '\n\n' +
    'Run BOTH commands (the second writes the per-trade ledger to out/):\n\n' +
    SIM + ' --rebate ' + REBATE + ' ' + flagsOf(incumbent) + '\n' +
    SIM + ' --rebate 0 ' + flagsOf(incumbent) + '\n\n' +
    'Read each RESULT {json} stdout line. ' + OBJ_RULE + '\n' +
    'Return candidates[] with TWO entries: label="rebate_0.05" and label="rebate_0", each with objective, totalNetUsd, winFrac, verdict.',
  { schema: VERIFY_SCHEMA, label: 'final:eval', phase: 'Final' },
)

return {
  finalParams: incumbent,
  finalObjective: incumbentObjective,
  trajectory,
  finalEval: finalEval && Array.isArray(finalEval.candidates) ? finalEval.candidates : [],
  rebateScenario: REBATE,
  note: 'objective = meanNetReturn over realized markets, credited only when nRealized >= 40. rebate 0.05 = the measured weather maker-rebate scenario; rebate 0 = the conservative no-rebate sensitivity.',
}
