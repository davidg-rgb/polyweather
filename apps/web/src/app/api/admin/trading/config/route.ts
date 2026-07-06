import { prodDeps } from '../../../../../lib/api/prod.ts';
import { adminTradingConfig } from '../../../../../lib/api/routes.ts';

export async function POST(req: Request): Promise<Response> {
  return adminTradingConfig(req, prodDeps(req));
}
