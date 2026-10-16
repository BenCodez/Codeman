import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Use this checkout's entrypoint, including its loader in a source/tsx run. */
export function supervisorManagerBridgeCommand(moduleUrl = import.meta.url): { command: string; args: string[] } {
  const source = new URL(moduleUrl).pathname.endsWith('.ts');
  const entrypoint = fileURLToPath(new URL(source ? '../index.ts' : '../index.js', moduleUrl));
  return {
    command: process.execPath,
    args: [
      ...(source ? ['--import', createRequire(import.meta.url).resolve('tsx')] : []),
      entrypoint,
      'agent',
      'supervisor-mcp',
    ],
  };
}
