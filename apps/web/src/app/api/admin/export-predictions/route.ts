import { prodDeps } from '../../../../lib/api/prod.ts';
import { adminExportPredictions } from '../../../../lib/api/routes.ts';

export async function POST(req: Request): Promise<Response> {
  return adminExportPredictions(req, prodDeps(req));
}
