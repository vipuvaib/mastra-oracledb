import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { recordEvidence } from '../helpers/evidence.ts';
import { suite } from '../helpers/suite.ts';
const { server, store } = suite('bounded-soak');

it('S01 sustains four isolated conversations for thirty seconds with bounded connections and consistent data', async () => {
  const durationMs = 30_000;
  const concurrency = 4;
  const pool = await store.getPoolManager().getPool();
  const samples: { open: number; inUse: number }[] = [];
  const timer = setInterval(() => samples.push({ open: pool.connectionsOpen, inUse: pool.connectionsInUse }), 100);
  const latencies: number[] = [];
  const failures: string[] = [];
  const threads = Array.from({ length: concurrency }, () => ({
    thread: randomUUID(),
    resource: randomUUID(),
    code: randomUUID(),
    calls: 0,
  }));
  const started = performance.now();
  try {
    await Promise.all(
      threads.map(async thread => {
        const options = { memory: { thread: thread.thread, resource: thread.resource } };
        await server.client.getAgent('history').generate('PROJECT CODE: ' + thread.code, options);
        while (performance.now() - started < durationMs) {
          const began = performance.now();
          try {
            const result = await server.client.getAgent('history').generate('RECALL PROJECT CODE', options);
            expect(result.text).toBe('CODE=' + thread.code);
            thread.calls++;
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
          }
          latencies.push(performance.now() - began);
          // Eight turns per conversation avoids evicting the initial fact from lastMessages:20.
          if (thread.calls >= 8) {
            await delay(Math.max(0, durationMs - (performance.now() - started)));
            break;
          }
          await delay(3000);
        }
      }),
    );
    await server.settle();
    const memory = (await store.getStore('memory'))!;
    const consistency = [];
    for (const thread of threads) {
      const { messages } = await memory.listMessages({ threadId: thread.thread, perPage: false });
      consistency.push({
        threadId: thread.thread,
        calls: thread.calls,
        messages: messages.length,
        uniqueIds: new Set(messages.map(row => row.id)).size,
      });
      expect(messages).toHaveLength((thread.calls + 1) * 2);
      expect(new Set(messages.map(row => row.id)).size).toBe(messages.length);
      expect(messages.every(row => row.resourceId === thread.resource)).toBe(true);
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
    const fixturePools = await fetch(server.baseUrl + '/_test/pools').then(response => response.json());
    recordEvidence('S01', {
      requestedDurationMs: durationMs,
      elapsedMs: performance.now() - started,
      concurrency,
      requests: latencies.length,
      errors: failures,
      latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
      assertionPool: {
        maximumOpen: Math.max(...samples.map(sample => sample.open)),
        maximumInUse: Math.max(...samples.map(sample => sample.inUse)),
        maximumConfigured: 4,
      },
      fixturePools,
      consistency,
    });
    expect(failures).toEqual([]);
    expect(latencies.length).toBeGreaterThanOrEqual(24);
    expect(samples.every(sample => sample.open <= 4 && sample.inUse <= 4)).toBe(true);
    expect(fixturePools.storage.connectionsOpen).toBeLessThanOrEqual(4);
  } finally {
    clearInterval(timer);
  }
}, 90_000);
