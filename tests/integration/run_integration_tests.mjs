#!/usr/bin/env node

// Integration tests: run the generated provider (local file registry)
// against the mock TypeSafe API and assert row-level results and wire calls
// for every archetype the provider has:
//   - the models catalog: {models: [...]} envelope unwrapped (objectKey),
//     bearer header sent, a wrong key -> 401 surfaced, no key -> 403
//   - the flagship POST-as-SELECT binding: WHERE state / model / questions
//     become the JSON body under naive translation - `questions` arrives as
//     a JSON object (not a string), a plain-text `state` stays a string, a
//     JSON object or array `state` is sent as that object or array
//   - one row per evaluation: model, answers (JSON), usage (JSON);
//     json_extract over answers and usage
//   - mixed question types, a versioned model id passed through
//   - the provider-level retry policy: a 429 and a 529 on the first attempt
//     are retried (POST is in retryable_methods) and the row still comes back
//   - a malformed question and an unknown model surfaced as the vendor's
//     400 api_usage_error (live-verified 2026-10-05)
//   - a statement missing a required body field cannot route
//
// The vendor server is https-only and cannot address the mock, so
// harness.mjs materialises a TEST COPY of provider-dev/openapi in
// tests/integration/.registry-tmp (gitignored, recreated each run) with the
// server URL rewritten to the mock, and spawns stackql asynchronously (the
// mock runs on this process's event loop, so a synchronous wait deadlocks).
//
// Requires a stackql binary: $STACKQL, ./stackql, or `stackql` on PATH.
// Usage: node tests/integration/run_integration_tests.mjs [--verbose]

import { startMockServer, EXPECTED_TOKEN, MODELS, RESOLVED_MODEL, RETRY_ONCE_MARKER, OVERLOADED_ONCE_MARKER } from './mock_typesafe_server.mjs';
import { buildTestRegistry, registryArg, makeRunSql, findStackql } from './harness.mjs';
import { PROVIDER_NAME } from '../../provider-dev/scripts/lib/spec_helpers.mjs';

const verbose = process.argv.includes('--verbose');
const t0 = Date.now();

// The environment the provider reads: the bearer key only (no scoping
// variable - the API is a fixed host).
const PROVIDER_ENV = { TYPESAFE_API_KEY: EXPECTED_TOKEN };

const results = [];
function check(name, cond, note = '') {
  results.push({ name, pass: !!cond, note });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && note ? `  [${String(note).slice(0, 220)}]` : ''}`);
}

const { server, port, log, state } = await startMockServer();
const registry = registryArg(buildTestRegistry(port));
const runSql = makeRunSql(registry, PROVIDER_ENV, { verbose });
console.log(`mock API on localhost:${port}, stackql: ${findStackql()}`);

// wire calls since `mark` matching method + path
const calls = (mark, method, p) => log.slice(mark).filter((e) => e.method === method && e.path === p);
// `--output json` renders object columns as JSON text; accept either form
const asJson = (v) => { if (v == null) return v; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const sqlStr = (v) => `'${(typeof v === 'string' ? v : JSON.stringify(v)).replace(/'/g, "''")}'`;

const STATE = 'Help! My payouts have been failing for 3 days.';
const Q_NOUL = { is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' } };
const Q_CHOICE = { department: { type: 'choice', instructions: 'Which team should handle this?', criteria: { billing: 'Payments, invoicing, refunds', technical: 'Bugs, outages, integrations', sales: 'Pricing, upgrades, new accounts' } } };
const Q_SCORE = { frustration: { type: 'score', instructions: 'How frustrated is the customer?', criteria: ['Calm', 'Frustrated', 'Very angry'] } };
const EVAL = `${PROVIDER_NAME}.systemone.evaluations`;
const evalSql = (cols, stateValue, questions, model = 'jev-latest') =>
  `SELECT ${cols} FROM ${EVAL} WHERE state = ${sqlStr(stateValue)} AND model = ${sqlStr(model)} AND questions = ${sqlStr(questions)}`;

try {
  // --- meta sanity
  let r = await runSql(`SHOW SERVICES IN ${PROVIDER_NAME}`);
  check('show services returns models and systemone', r.rows && r.rows.map((x) => x.name).sort().join(',') === 'models,systemone', r.err || JSON.stringify(r.rows));

  // --- the models catalog (control plane)
  let mark = log.length;
  r = await runSql(`SELECT name, description, release_date FROM ${PROVIDER_NAME}.models.models ORDER BY name`);
  check(`models list unwraps $.models (${MODELS.length} rows)`, r.rows && r.rows.length === MODELS.length && r.rows[0].name === 'jev-latest' && r.rows[0].release_date === MODELS[0].release_date, r.err || JSON.stringify(r.rows));
  const modelCalls = calls(mark, 'GET', '/v1/models');
  check('models list is one GET /v1/models with the bearer key', modelCalls.length === 1 && new RegExp(`^bearer\\s+${EXPECTED_TOKEN}$`, 'i').test(modelCalls[0].authorization), JSON.stringify(modelCalls.map((c) => c.authorization)));
  r = await runSql(`SELECT name FROM ${PROVIDER_NAME}.models.models`, { TYPESAFE_API_KEY: 'wrong-key' });
  check('wrong key -> 401 authentication_error surfaced', r.err && /401/.test(r.err) && /authentication_error/.test(r.err), r.err || 'no error');

  // --- the flagship: POST /v1/systemone as SELECT
  mark = log.length;
  r = await runSql(evalSql('model, answers, usage', STATE, Q_NOUL));
  check('noul evaluation returns one row', r.rows && r.rows.length === 1, r.err || JSON.stringify(r.rows));
  const row = r.rows?.[0] || {};
  check(`row.model is the versioned id the API answered with (${RESOLVED_MODEL})`, row.model === RESOLVED_MODEL, JSON.stringify(row.model));
  const answers = asJson(row.answers);
  check('row.answers is the answers map keyed by question id', answers && answers.is_urgent && answers.is_urgent.type === 'noul' && answers.is_urgent.noul === 0.95, JSON.stringify(row.answers));
  const usage = asJson(row.usage);
  check('row.usage carries input_tokens and output_tokens', usage && Number.isInteger(usage.input_tokens) && usage.output_tokens === 20, JSON.stringify(row.usage));
  const post = calls(mark, 'POST', '/v1/systemone');
  check('evaluation is one POST /v1/systemone, application/json, bearer key', post.length === 1 && /application\/json/.test(post[0].contentType) && new RegExp(`^bearer\\s+${EXPECTED_TOKEN}$`, 'i').test(post[0].authorization), JSON.stringify(post.map((c) => [c.contentType, c.authorization])));
  const body = post[0]?.body || {};
  check('wire body: state is the plain string, model the alias', body.state === STATE && body.model === 'jev-latest', JSON.stringify(body));
  check('wire body: questions is a JSON object (naive translation fans the string out)', body.questions && typeof body.questions === 'object' && !Array.isArray(body.questions) && body.questions.is_urgent?.type === 'noul' && body.questions.is_urgent?.instructions === Q_NOUL.is_urgent.instructions, JSON.stringify(body.questions));
  check('wire body carries exactly state, model, questions', Object.keys(body).sort().join(',') === 'model,questions,state', JSON.stringify(Object.keys(body)));

  // json_extract over the JSON columns (the docs idiom)
  r = await runSql(`SELECT json_extract(answers, '$.is_urgent.noul') AS p_urgent, json_extract(usage, '$.input_tokens') AS input_tokens FROM ${EVAL} WHERE state = ${sqlStr(STATE)} AND model = 'jev-latest' AND questions = ${sqlStr(Q_NOUL)}`);
  check('json_extract(answers, $.is_urgent.noul) = 0.95', r.rows && r.rows.length === 1 && Number(r.rows[0].p_urgent) === 0.95, r.err || JSON.stringify(r.rows));
  check('json_extract(usage, $.input_tokens) is an integer', r.rows && /^\d+$/.test(String(r.rows[0]?.input_tokens)), JSON.stringify(r.rows?.[0]));

  // mixed question types in one request, versioned model id passed through
  mark = log.length;
  const mixed = { ...Q_NOUL, ...Q_CHOICE, ...Q_SCORE };
  r = await runSql(evalSql('model, answers', STATE, mixed, RESOLVED_MODEL));
  const mixedAnswers = asJson(r.rows?.[0]?.answers) || {};
  check('mixed noul + choice + score: one answer per question', Object.keys(mixedAnswers).sort().join(',') === 'department,frustration,is_urgent', r.err || JSON.stringify(r.rows));
  check('choice answer: choice, probabilities, confidence', mixedAnswers.department?.choice === 'billing' && mixedAnswers.department?.probabilities?.billing === 0.88 && mixedAnswers.department?.confidence === 0.9, JSON.stringify(mixedAnswers.department));
  check('score answer: score, legend, probabilities, confidence', mixedAnswers.frustration?.score === 1.7 && mixedAnswers.frustration?.legend?.['2'] === 'Very angry' && mixedAnswers.frustration?.probabilities?.['2'] === 0.8, JSON.stringify(mixedAnswers.frustration));
  const mixedPost = calls(mark, 'POST', '/v1/systemone');
  check('wire body: three questions as an object, criteria map and criteria array intact', mixedPost.length === 1 && Object.keys(mixedPost[0].body?.questions || {}).length === 3 && Array.isArray(mixedPost[0].body.questions.frustration.criteria) && typeof mixedPost[0].body.questions.department.criteria === 'object', JSON.stringify(mixedPost[0]?.body?.questions));
  check(`wire body: versioned model id ${RESOLVED_MODEL} passed through`, mixedPost[0]?.body?.model === RESOLVED_MODEL, JSON.stringify(mixedPost[0]?.body?.model));

  // structured state: a JSON object and a JSON array
  mark = log.length;
  const structured = { subject: 'Duplicate charge', message: 'I was charged twice for order A-104.' };
  r = await runSql(evalSql('model', structured, Q_NOUL));
  let sPost = calls(mark, 'POST', '/v1/systemone');
  check('object state: the JSON string is sent as a JSON object', !r.err && sPost.length === 1 && sPost[0].body?.state?.subject === 'Duplicate charge' && typeof sPost[0].body.state === 'object', r.err || JSON.stringify(sPost[0]?.body?.state));
  mark = log.length;
  const arrayState = ['Hi', 'My customer number is TS1337.', 'My card was charged twice.'];
  r = await runSql(evalSql('model', arrayState, Q_NOUL));
  sPost = calls(mark, 'POST', '/v1/systemone');
  check('array state: the JSON string is sent as a JSON array', !r.err && sPost.length === 1 && Array.isArray(sPost[0].body?.state) && sPost[0].body.state.length === 3, r.err || JSON.stringify(sPost[0]?.body?.state));

  // retry policy: 429 then 200, 529 then 200 (POST is retryable in provider_config.json)
  mark = log.length;
  r = await runSql(evalSql('model', `${RETRY_ONCE_MARKER} ${STATE}`, Q_NOUL));
  let retryPosts = calls(mark, 'POST', '/v1/systemone');
  check('429 on the first attempt is retried and the row returned (2 POSTs)', !r.err && r.rows?.length === 1 && retryPosts.length === 2 && state.retryHits === 1, r.err || `posts=${retryPosts.length} hits=${state.retryHits}`);
  mark = log.length;
  r = await runSql(evalSql('model', `${OVERLOADED_ONCE_MARKER} ${STATE}`, Q_NOUL));
  retryPosts = calls(mark, 'POST', '/v1/systemone');
  check('529 (overloaded) on the first attempt is retried and the row returned (2 POSTs)', !r.err && r.rows?.length === 1 && retryPosts.length === 2 && state.overloadedHits === 1, r.err || `posts=${retryPosts.length} hits=${state.overloadedHits}`);

  // negative paths
  r = await runSql(evalSql('model', STATE, { q: { type: 'essay' } }));
  check('malformed question -> 400 api_usage_error surfaced (live-verified shape)', r.err && /400/.test(r.err) && /api_usage_error/.test(r.err) && /Invalid request/.test(r.err), r.err || 'no error');
  r = await runSql(evalSql('model', STATE, Q_NOUL, 'jev-typo'));
  check('unknown model -> 400 api_usage_error "Unknown model" surfaced', r.err && /400/.test(r.err) && /Unknown model: jev-typo/.test(r.err), r.err || 'no error');
  r = await runSql(`SELECT model FROM ${EVAL} WHERE state = ${sqlStr(STATE)} AND model = 'jev-latest'`);
  check('missing `questions` cannot route (required body field)', r.err && /cannot find matching operation|no appropriate method/.test(r.err), r.err || 'no error');
  r = await runSql(`SELECT name FROM ${PROVIDER_NAME}.models.models`, { TYPESAFE_API_KEY: undefined });
  check('TYPESAFE_API_KEY unset -> no row, error surfaced (403 or credential error)', r.err || !(r.rows && r.rows.length), JSON.stringify(r.rows));

  // nothing in the suite created anything: the mock has no mutable state
  check(`mock served ${state.evaluations} evaluations and ${state.authFailures} auth failures, no other state`, state.evaluations >= 7 && state.authFailures >= 1, JSON.stringify(state));
} finally {
  server.close();
}

const failed = results.filter((x) => !x.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failed.length) {
  console.log('failed:');
  for (const f of failed) console.log(`  - ${f.name}${f.note ? `: ${String(f.note).slice(0, 300)}` : ''}`);
  process.exit(1);
}
