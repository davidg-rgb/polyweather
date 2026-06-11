import { prodDeps } from '../../../../lib/api/prod.ts';
import { adminVerifyStation } from '../../../../lib/api/routes.ts';

export async function POST(req: Request): Promise<Response> {
  return adminVerifyStation(req, prodDeps(req));
}
