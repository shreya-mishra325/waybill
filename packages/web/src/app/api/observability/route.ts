import 'server-only';
import { createMonitoringHandler } from '../../../server/observability';

export const dynamic = 'force-dynamic';
const handle = createMonitoringHandler();
export function GET(request: Request) { return handle(request, process.env); }
