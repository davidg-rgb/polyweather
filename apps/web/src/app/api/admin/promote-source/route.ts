import { prodDeps } from '../../../../lib/api/prod.ts';
import { adminPromoteSource } from '../../../../lib/api/routes.ts';

export async function POST(req: Request): Promise<Response> {
  return adminPromoteSource(req, prodDeps(req));
}
