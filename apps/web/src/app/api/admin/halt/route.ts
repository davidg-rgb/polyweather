import { prodDeps } from '../../../../lib/api/prod.ts';
import { adminHalt } from '../../../../lib/api/routes.ts';

export async function POST(req: Request): Promise<Response> {
  return adminHalt(req, prodDeps(req));
}
