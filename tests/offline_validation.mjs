#!/usr/bin/env node

// Offline validation of the generated provider against the local file
// registry - no network, no server. Runs SHOW SERVICES / SHOW RESOURCES /
// SHOW METHODS and DESCRIBE EXTENDED over every resource and asserts the
// expected surface: service and resource names, the verb and required
// params of each method (the flagship POST-as-SELECT binding routes on its
// body fields), the projected columns, and that nothing is bound to a
// mutating verb (the API has no mutable resources). Exit 1 on any failure.
//
// Usage: node tests/offline_validation.mjs
// Binary resolution: $STACKQL, ./stackql(.exe), then PATH.
// Note: `--output json` renders scalars as strings.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROVIDER_NAME } from '../provider-dev/scripts/lib/spec_helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const regPath = path.join(repoRoot, 'provider-dev', 'openapi').replace(/\\/g, '/');
const registry = JSON.stringify({ url: `file://${regPath}`, localDocRoot: regPath, verifyConfig: { nopVerify: true } });

// ---------------------------------------------------------------------------
// Expectations. Exact sorted lists - a regeneration that adds or renames a
// resource must update these deliberately (and is a breaking-change review
// of all_services.csv first).
// ---------------------------------------------------------------------------

const EXPECTED_SERVICES = ['models', 'systemone'];
const EXPECTED_RESOURCES = {
  models: ['models'],
  systemone: ['evaluations']
};

// method -> { verb, required: [...] } per resource. The evaluation POST is
// SELECT-routed on its three required body fields (naive body translation):
// a statement without any of them cannot route.
const EXPECTED_METHODS = {
  'models.models': { list: { verb: 'SELECT', required: [] } },
  'systemone.evaluations': { evaluate: { verb: 'SELECT', required: ['model', 'questions', 'state'] } }
};

// Columns each selectable resource projects (DESCRIBE EXTENDED). `answers`
// and `usage` are JSON columns (json_extract), the vendor's wire names are
// already snake_case so no aliases are involved.
const EXPECTED_COLUMNS = {
  'models.models': ['description', 'name', 'release_date'],
  'systemone.evaluations': ['answers', 'model', 'usage']
};

// ---------------------------------------------------------------------------

function findBinary() {
  if (process.env.STACKQL && fs.existsSync(process.env.STACKQL)) return process.env.STACKQL;
  for (const name of ['stackql', 'stackql.exe']) {
    const local = path.join(repoRoot, name);
    if (fs.existsSync(local)) return local;
  }
  return 'stackql'; // PATH
}
const bin = findBinary();

function runSql(sql, envOverrides = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...envOverrides };
    for (const [k, v] of Object.entries(envOverrides)) if (v === undefined) delete env[k];
    const child = spawn(bin, [`--registry=${registry}`, 'exec', sql, '--output', 'json'], { cwd: repoRoot, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      let rows = [];
      try { rows = JSON.parse(stdout) ?? []; } catch { rows = []; }
      resolve({ code, rows, stdout, stderr });
    });
    child.on('error', (err) => resolve({ code: -1, rows: [], stdout: '', stderr: String(err) }));
  });
}

const results = [];
function check(name, cond, note = '') {
  results.push({ name, pass: !!cond, note });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  [${String(note).slice(0, 160)}]`}`);
}
const names = (rows, key = 'name') => rows.map((x) => x[key]).sort();
const methodsByName = (rows) => Object.fromEntries(rows.map((m) => [m.MethodName, m]));
const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const requiredOf = (m) => String(m?.RequiredParams || '').split(',').map((s) => s.trim()).filter(Boolean);

console.log(`stackql: ${bin}`);
console.log(`registry: ${regPath}`);

// --- services
let r = await runSql(`SHOW SERVICES IN ${PROVIDER_NAME}`);
check(`SHOW SERVICES (${EXPECTED_SERVICES.length})`, sameList(names(r.rows), EXPECTED_SERVICES), r.stderr || JSON.stringify(names(r.rows)));

// --- resources per service
for (const [svc, expected] of Object.entries(EXPECTED_RESOURCES)) {
  r = await runSql(`SHOW RESOURCES IN ${PROVIDER_NAME}.${svc}`);
  check(`SHOW RESOURCES IN ${PROVIDER_NAME}.${svc} (${expected.length})`, sameList(names(r.rows), expected), r.stderr || JSON.stringify(names(r.rows)));
}

// --- methods: verb and required params, nothing bound to a mutating verb
for (const [res, expectedMethods] of Object.entries(EXPECTED_METHODS)) {
  r = await runSql(`SHOW EXTENDED METHODS IN ${PROVIDER_NAME}.${res}`);
  const got = methodsByName(r.rows);
  check(`${res} methods are exactly ${Object.keys(expectedMethods).join(', ')}`, sameList(Object.keys(got), Object.keys(expectedMethods)), r.stderr || JSON.stringify(Object.keys(got)));
  for (const [m, exp] of Object.entries(expectedMethods)) {
    check(`${res}.${m} is ${exp.verb}`, got[m]?.SQLVerb === exp.verb, JSON.stringify(got[m]));
    check(`${res}.${m} required params [${exp.required.join(', ')}]`, sameList(requiredOf(got[m]), exp.required), JSON.stringify(got[m]?.RequiredParams));
  }
  check(`${res} has no INSERT / UPDATE / DELETE / REPLACE method`, Object.values(got).every((m) => m.SQLVerb === 'SELECT' || m.SQLVerb === 'EXEC'), JSON.stringify(Object.values(got).map((m) => m.SQLVerb)));
}

// --- columns
for (const [res, expectedCols] of Object.entries(EXPECTED_COLUMNS)) {
  r = await runSql(`DESCRIBE EXTENDED ${PROVIDER_NAME}.${res}`);
  const cols = names(r.rows);
  check(`DESCRIBE EXTENDED ${res} columns [${expectedCols.join(', ')}]`, sameList(cols, expectedCols), r.stderr || JSON.stringify(cols));
  const types = Object.fromEntries(r.rows.map((x) => [x.name, x.type]));
  if (res === 'systemone.evaluations') {
    check('evaluations.answers and usage are object (JSON) columns, model is a string', types.answers === 'object' && types.usage === 'object' && types.model === 'string', JSON.stringify(types));
  }
  if (res === 'models.models') {
    check('models.models columns are strings', Object.values(types).every((t) => t === 'string'), JSON.stringify(types));
  }
}

// --- the flagship binding: the SELECT method documents the vendor's
// operation (description passes through verbatim)
r = await runSql(`SHOW EXTENDED METHODS IN ${PROVIDER_NAME}.systemone.evaluations`);
const evaluate = methodsByName(r.rows).evaluate;
check('evaluations.evaluate carries the vendor operation description', /questions about the content supplied in `state`/.test(String(evaluate?.description || '')), JSON.stringify(evaluate?.description).slice(0, 120));

const failed = results.filter((x) => !x.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
