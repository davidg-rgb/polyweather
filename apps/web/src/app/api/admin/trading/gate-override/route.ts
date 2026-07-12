import { prodDeps } from '../../../../../lib/api/prod.ts';
import { adminGateOverride } from '../../../../../lib/api/routes.ts';

export async function POST(req: Request): Promise<Response> {
  return adminGateOverride(req, prodDeps(req));
}
