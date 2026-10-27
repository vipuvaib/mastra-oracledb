import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export function recordEvidence(scenario: string, details: Record<string, unknown>) {
  const artifacts = process.env.ORACLE_APP_ARTIFACTS;
  if (!artifacts) throw new Error('Evidence directory was not supplied by the test runner.');
  appendFileSync(
    join(artifacts, 'scenarios.jsonl'),
    JSON.stringify({ scenario, at: new Date().toISOString(), ...details }) + '\n',
  );
}
