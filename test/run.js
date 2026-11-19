import { runAll } from './generator.js';

const ok = await runAll();
process.exit(ok ? 0 : 1);
