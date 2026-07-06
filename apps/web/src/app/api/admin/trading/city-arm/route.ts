import { prodDeps } from '../../../../../lib/api/prod.ts';
import { adminCityArm } from '../../../../../lib/api/routes.ts';

export async function POST(req: Request): Promise<Response> {
  return adminCityArm(req, prodDeps(req));
}
