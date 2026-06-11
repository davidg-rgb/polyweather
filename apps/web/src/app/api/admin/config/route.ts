import { prodDeps } from '../../../../lib/api/prod.ts';
import { adminUpdateConfig } from '../../../../lib/api/routes.ts';

export async function POST(req: Request): Promise<Response> {
  return adminUpdateConfig(req, prodDeps(req));
}
