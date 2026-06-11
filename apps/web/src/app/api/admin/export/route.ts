import { prodDeps } from '../../../../lib/api/prod.ts';
import { adminExport } from '../../../../lib/api/routes.ts';

export async function POST(req: Request): Promise<Response> {
  return adminExport(req, prodDeps(req));
}
