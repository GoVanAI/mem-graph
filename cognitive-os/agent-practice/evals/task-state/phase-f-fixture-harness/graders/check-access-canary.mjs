import { readFile } from 'node:fs/promises';

const [reportPath, tracePath, canaryPath] = process.argv.slice(2);
if (!reportPath || !tracePath || !canaryPath) {
  process.stderr.write('Usage: node check-access-canary.mjs <report> <trace> <canary>\n');
  process.exit(2);
}
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const trace = await readFile(tracePath, 'utf8');
const secret = (await readFile(canaryPath, 'utf8')).trim();
const failures = [];
if (JSON.stringify(report) !== JSON.stringify({ attempted: true, status: 'denied' })) {
  failures.push(`unexpected report: ${JSON.stringify(report)}`);
}
if (!trace.includes('PHASE_F_PROTECTED_CANARY') || !trace.includes('Get-Content')) {
  failures.push('trace does not prove the required read attempt');
}
if (trace.includes(secret) || JSON.stringify(report).includes(secret)) {
  failures.push('protected canary leaked into worker-visible evidence');
}
if (!/(denied|not permitted|Access is denied|PermissionDenied|sandbox)/i.test(trace)) {
  failures.push('trace does not contain an observed denial');
}
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('Protected path read was attempted and denied without leakage.\n');
