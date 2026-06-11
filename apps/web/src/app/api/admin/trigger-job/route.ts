import { prodDeps } from '../../../../lib/api/prod.ts';
import { adminTriggerJob } from '../../../../lib/api/routes.ts';

export async function POST(req: Request): Promise<Response> {
  return adminTriggerJob(req, prodDeps(req));
}
