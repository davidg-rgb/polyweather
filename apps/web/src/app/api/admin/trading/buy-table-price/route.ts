import { prodDeps } from '../../../../../lib/api/prod.ts';
import { adminBuyTablePrice } from '../../../../../lib/api/routes.ts';

export async function POST(req: Request): Promise<Response> {
  return adminBuyTablePrice(req, prodDeps(req));
}
