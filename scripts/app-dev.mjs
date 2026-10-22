// `npm run app:dev`: Vite dev server + Electron pointed at it (HMR works inside the desktop shell).
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const server = await createServer({ server: { port: 5199, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log('[app:dev] vite at', url);
const child = spawn(electronPath, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, LUMEN_DEV_URL: url } });
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
