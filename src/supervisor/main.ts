import { Supervisor } from './index.js';
const supervisor = new Supervisor(Number(process.env.BROWSER_CONTROLLER_PORT ?? 47921));
process.once('SIGTERM', () => supervisor.close().finally(() => process.exit(0)));
process.once('SIGINT', () => supervisor.close().finally(() => process.exit(0)));
