import { fork, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MastraClient } from '@mastra/client-js';

export class ServerProcess {
  child?: ChildProcess;
  baseUrl = '';
  client!: MastraClient;
  private generation = 0;
  private exit?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  constructor(private readonly name: string) {}
  async start() {
    if (this.child) throw new Error('Old server must exit before starting a replacement.');
    const artifacts = process.env.ORACLE_APP_ARTIFACTS;
    if (!artifacts) throw new Error('Use the test runner so logs and run identity are captured.');
    const log = createWriteStream(join(artifacts, `${this.name}-${++this.generation}.log`));
    const child = fork(
      process.env.ORACLE_APP_SERVER_ENTRY ?? fileURLToPath(new URL('../fixture/server.ts', import.meta.url)),
      [],
      {
        execArgv: process.env.ORACLE_APP_SERVER_COMPILED === 'true' ? [] : ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: process.env,
      },
    );
    this.child = child;
    child.stdout!.pipe(log, { end: false });
    child.stderr!.pipe(log, { end: false });
    this.exit = new Promise(resolve =>
      child.once('exit', (code, signal) => {
        log.end();
        resolve({ code, signal });
      }),
    );
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Server readiness timed out; inspect server log.')), 60_000);
        const finish = () => clearTimeout(timeout);
        child.once('error', error => {
          finish();
          reject(error);
        });
        child.once('exit', code => {
          finish();
          reject(new Error(`Server exited before readiness: ${code}. Inspect server log.`));
        });
        child.on('message', message => {
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'ready' &&
            'port' in message &&
            typeof message.port === 'number'
          ) {
            finish();
            resolve(message.port);
          }
        });
      });
      this.baseUrl = `http://127.0.0.1:${port}`;
      this.client = new MastraClient({ baseUrl: this.baseUrl, retries: 0 });
      const ready = await fetch(`${this.baseUrl}/_test/ready`, { signal: AbortSignal.timeout(5000) });
      if (!ready.ok || (await ready.json()).runId !== process.env.ORACLE_APP_RUN_ID)
        throw new Error('Readiness run identity mismatch.');
    } catch (error) {
      await this.stop(true);
      throw error;
    }
  }
  async settle() {
    const result = await fetch(`${this.baseUrl}/_test/settled`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    });
    if (!result.ok) throw new Error(`Memory/tracing settle failed: ${result.status}`);
  }
  async stop(force = false) {
    const child = this.child;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill(force ? 'SIGKILL' : 'SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const result = await this.exit!;
    clearTimeout(timeout);
    this.child = undefined;
    if (!force && (result.code !== 0 || result.signal))
      throw new Error(`Server did not shut down cleanly: ${JSON.stringify(result)}`);
  }
  async restart(force = false) {
    await this.stop(force);
    await this.start();
  }
}
