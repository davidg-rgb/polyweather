import { prodDeps } from '../../../lib/api/prod.ts';
import { healthCheck } from '../../../lib/api/routes.ts';

export async function GET(req: Request): Promise<Response> {
  return healthCheck(req, prodDeps(req));
}
