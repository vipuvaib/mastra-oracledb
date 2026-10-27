import type { ServerProcess } from './server-process.ts';
export async function testOperation(server: ServerProcess, path: string, body: unknown) {
  const response = await fetch(server.baseUrl + '/_test/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error('Fixture operation failed: ' + JSON.stringify(data));
  return data;
}
