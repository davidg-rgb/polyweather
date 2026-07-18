/**
 * clob-egress-probe — KEYLESS diagnostic for the C44 live-post transport failure (EDGE-WATCH-LOOP.md).
 *
 * Answers ONE question from inside the SAME runtime buy-table-tick executes in: can this Edge runtime's
 * egress REACH Polymarket's order-placement endpoint at all?
 *
 *   1. cf-trace  — https://www.cloudflare.com/cdn-cgi/trace → the egress ip/loc/colo EXACTLY as Cloudflare
 *                  (Polymarket's edge) sees this runtime.
 *   2. clob GET  — GET /time (the C44 known-good control: market-data GETs work from Edge).
 *   3. order POST — POST /order with an EMPTY unauthenticated JSON body. This CANNOT place an order (no
 *                  signature, no auth headers — the venue rejects it); what matters is the SHAPE of the
 *                  rejection: a JSON CLOB error ⇒ the endpoint is reachable and the C44 failure is NOT
 *                  transport; a Cloudflare HTML block page (403/1020) ⇒ the egress is blocked for trading
 *                  writes — the deterministic "shapeless response" root cause.
 *
 * NO secrets read, NO order signed, NO DB access. Body snippets are capped and only the first bytes of
 * text are returned (never long enough to matter — there are no credentials anywhere in this flow).
 * Standing instrument (BUY-TABLE-LIVE.md §3): run it FIRST if live posts ever fail "shapeless" again.
 */

const CLOB = 'https://clob.polymarket.com';
const CAP = 400;

async function probe(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    return {
      status: r.status,
      contentType: r.headers.get('content-type'),
      cfRay: r.headers.get('cf-ray'),
      server: r.headers.get('server'),
      bodyHead: text.slice(0, CAP),
    };
  } catch (e) {
    return { threw: true, error: String(e).slice(0, CAP) };
  }
}

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async () => {
  const traceRaw = await probe('https://www.cloudflare.com/cdn-cgi/trace');
  // parse ip/loc/colo out of the trace body for a readable headline
  const traceBody = String((traceRaw as { bodyHead?: unknown }).bodyHead ?? '');
  const trace: Record<string, string> = {};
  for (const line of traceBody.split('\n')) {
    const [k, v] = line.split('=');
    if (k && v && ['ip', 'loc', 'colo', 'warp'].includes(k)) trace[k] = v;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    egress: trace, // { ip, loc, colo } — what Polymarket's Cloudflare sees
    clobGet: await probe(`${CLOB}/time`),
    orderPost: await probe(`${CLOB}/order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  };
  return new Response(JSON.stringify(out, null, 2), {
    headers: { 'content-type': 'application/json' },
  });
});
