import { prodDeps } from '../../../../lib/api/prod.ts';
import { adminManualBet } from '../../../../lib/api/routes.ts';

export const maxDuration = 90; // standard fill path proxies to execute-bet (§6.21)

export async function POST(req: Request): Promise<Response> {
  return adminManualBet(req, prodDeps(req));
}
