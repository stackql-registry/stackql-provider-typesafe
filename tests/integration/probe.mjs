#!/usr/bin/env node

// Developer probe: start the mock API, materialise the test registry (as
// run_integration_tests.mjs does) and run the SQL statements given on the
// command line, printing stackql's stdout/stderr and the wire calls the mock
// saw for each. This is how bindings get debugged.
//
// Usage: npm run probe -- "SELECT ..." [--env KEY=VALUE ...] [--unset KEY]
//
// Example (the flagship binding):
//   npm run probe -- "SELECT model, answers FROM typesafe.systemone.evaluations WHERE state = 'Help! My payouts have been failing for 3 days.' AND model = 'jev-latest' AND questions = '{\"is_urgent\": {\"type\": \"noul\", \"instructions\": \"Does this convey urgency?\"}}'"

import { startMockServer, EXPECTED_TOKEN } from './mock_typesafe_server.mjs';
import { buildTestRegistry, registryArg, makeRunSql, findStackql } from './harness.mjs';

// The environment the provider reads (as in run_integration_tests.mjs): the
// bearer key only - the API has no scoping variable.
const PROVIDER_ENV = { TYPESAFE_API_KEY: EXPECTED_TOKEN };

const args = process.argv.slice(2);
const sqls = [];
const envOverrides = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--env') { const [k, ...v] = args[++i].split('='); envOverrides[k] = v.join('='); }
  else if (args[i] === '--unset') { envOverrides[args[++i]] = undefined; }
  else sqls.push(args[i]);
}
if (sqls.length === 0) {
  console.error('usage: npm run probe -- "SELECT ..." [--env KEY=VALUE] [--unset KEY]');
  process.exit(2);
}

const { server, port, log } = await startMockServer();
const registry = registryArg(buildTestRegistry(port));
const runSql = makeRunSql(registry, PROVIDER_ENV);
console.log(`mock API on localhost:${port}, stackql: ${findStackql()}`);

try {
  for (const sql of sqls) {
    const mark = log.length;
    const { stdout, stderr } = await runSql(sql, envOverrides);
    console.log(`\n=== ${sql}`);
    console.log(`stdout: ${stdout.slice(0, 1200)}`);
    if (stderr) console.log(`stderr: ${stderr.slice(0, 800)}`);
    for (const e of log.slice(mark)) console.log(`wire: ${e.method} ${e.path} query=${JSON.stringify(e.query)} ct=${e.contentType} auth=${e.authorization ? 'bearer' : 'none'} body=${JSON.stringify(e.body)}`);
  }
} finally {
  server.close();
}
