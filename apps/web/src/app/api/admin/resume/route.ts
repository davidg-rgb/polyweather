import { prodDeps } from '../../../../lib/api/prod.ts';
import { adminResume } from '../../../../lib/api/routes.ts';

export async function POST(req: Request): Promise<Response> {
  return adminResume(req, prodDeps(req));
}
