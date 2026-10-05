#!/usr/bin/env node

// Mock TypeSafe API for integration-testing the generated provider without
// an account. Serves the wire shapes the published OpenAPI document
// (https://api.typesafe.ai/openapi.json, pinned in provider-dev/downloaded/)
// and the API reference (https://docs.typesafe.ai/api) describe:
//
//   GET  /v1/models     -> {"models": [{name, description, release_date}]}
//   POST /v1/systemone  -> {"model", "answers": {<question id>: Answer}, "usage"}
//
// Answers are computed deterministically from the request so the runner can
// assert values: a noul answer is 0.95, a choice answer picks the first
// criteria key, a score answer is 1.7 with a legend built from the ordered
// criteria. Every request is appended to `log` (method, path, query,
// headers, body) so the runner can assert the wire call - in particular that
// `questions` arrives as a JSON object and `state` as the string / object /
// array the statement supplied.
//
// Every request must carry `Authorization: Bearer <EXPECTED_TOKEN>`. A
// missing key is rejected 403 and a wrong key 401, each with the body
// api.typesafe.ai returned (captured 2026-10-02 and 2026-10-05). An unknown
// model name and a malformed question are 400 `api_usage_error` bodies, as
// observed live on 2026-10-05 (the spec's 422 HTTPValidationError shape is
// kept for a structurally missing required field, which the live API was
// not probed for).
//
// Transient-failure fixtures for the provider's retry policy: a string
// `state` containing RETRY_ONCE_MARKER is answered 429 (with retry-after) on
// its first call and 200 afterwards; OVERLOADED_ONCE_MARKER does the same
// with 529 (the "overloaded" status the API reference lists).
//
// The live API's x-typesafe-request-id response header is echoed so tests
// see the contract shape. No rate-limit headers are documented.
//
// Exports startMockServer() for the test runner; also runnable standalone:
//   node tests/integration/mock_typesafe_server.mjs [port]

import http from 'http';
import { URL } from 'url';

export const EXPECTED_TOKEN = 'mock-typesafe-key';
export const RETRY_ONCE_MARKER = 'RETRY-ONCE';
export const OVERLOADED_ONCE_MARKER = 'OVERLOADED-ONCE';

// The models catalog as GET /v1/models returned it on 2026-10-05: the two
// aliases, with `release_date` an ISO 8601 timestamp (the spec documents
// YYYY-MM-DD). Versioned ids are accepted by the `model` field whether or
// not they are listed.
export const MODELS = [
  { name: 'jev-latest', description: "The latest iteration of TypeSafe's System One Model: Jev", release_date: '2026-09-10T18:38:01.391457+00:00' },
  { name: 'jev-preview', description: 'A preview version of `jev-latest`: should be better in most ways', release_date: '2026-09-10T18:39:06.057655+00:00' }
];
export const RESOLVED_MODEL = 'jev-1.13.0';
const ACCEPTED_MODELS = new Set([...MODELS.map((m) => m.name), RESOLVED_MODEL]);

let requestCounter = 0;
function requestId() {
  requestCounter++;
  return `req_${String(requestCounter).padStart(32, '0')}`;
}

function makeState() {
  return {
    retryHits: 0,       // 429 fixture calls served
    overloadedHits: 0,  // 529 fixture calls served
    authFailures: 0,
    evaluations: 0,
    inputTokens: 0,
    outputTokens: 0
  };
}

// ---------------------------------------------------------------------------
// Answer synthesis (deterministic)
// ---------------------------------------------------------------------------

const QUESTION_TYPES = new Set(['noul', 'choice', 'score']);

function tokensOf(value) {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function answerFor(question) {
  if (question.type === 'noul') return { type: 'noul', noul: 0.95 };
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria || {});
    const probabilities = {};
    keys.forEach((k, i) => { probabilities[k] = i === 0 ? 0.88 : Number((0.12 / Math.max(1, keys.length - 1)).toFixed(4)); });
    return { type: 'choice', choice: keys[0], probabilities, confidence: 0.9 };
  }
  // score
  const levels = question.criteria || [];
  const legend = {};
  const probabilities = {};
  levels.forEach((level, i) => {
    legend[String(i)] = level;
    probabilities[String(i)] = i === levels.length - 1 ? 0.8 : Number((0.2 / Math.max(1, levels.length - 1)).toFixed(4));
  });
  return { type: 'score', score: 1.7, legend, probabilities, confidence: 0.9 };
}

// Returns null when the body validates, else { status, body }: a 400
// api_usage_error for an unknown model or a malformed question (the live
// API's behaviour, 2026-10-05), or a 422 detail list for a structurally
// missing field (the spec's HTTPValidationError shape).
function validateRequest(body) {
  const detail = [];
  const usageError = (message) => ({ status: 400, body: { detail: { error_type: 'api_usage_error', message } } });
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 422, body: { detail: [{ loc: ['body'], msg: 'Input should be a valid dictionary', type: 'dict_type' }] } };
  }
  if (body.state === undefined || body.state === null) detail.push({ loc: ['body', 'state'], msg: 'Field required', type: 'missing' });
  if (typeof body.model !== 'string') detail.push({ loc: ['body', 'model'], msg: 'Field required', type: 'missing' });
  if (!body.questions || typeof body.questions !== 'object' || Array.isArray(body.questions)) {
    detail.push({ loc: ['body', 'questions'], msg: 'Field required', type: 'missing' });
  } else if (Object.keys(body.questions).length === 0) {
    detail.push({ loc: ['body', 'questions'], msg: 'Dictionary should have at least 1 item after validation, not 0', type: 'too_short' });
  } else {
    for (const [id, q] of Object.entries(body.questions)) {
      if (!q || typeof q !== 'object') { detail.push({ loc: ['body', 'questions', id], msg: 'Input should be a valid dictionary', type: 'dict_type' }); continue; }
      if (!QUESTION_TYPES.has(q.type)) return usageError('Invalid request.');
      if (q.type === 'choice' && (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria))) return usageError('Invalid request.');
      if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 1)) return usageError('Invalid request.');
    }
  }
  if (detail.length) return { status: 422, body: { detail } };
  if (typeof body.model === 'string' && !ACCEPTED_MODELS.has(body.model)) return usageError(`Unknown model: ${body.model}`);
  return null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function send(res, code, body, extraHeaders = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'x-typesafe-request-id': requestId(), ...extraHeaders });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
function ok(res, body) { send(res, 200, body); }
function authError(res, code, message) { send(res, code, { detail: { error_type: 'authentication_error', message } }); }
function notFound(res) { send(res, 404, { detail: 'Not Found' }); }
function methodNotAllowed(res) { send(res, 405, { detail: 'Method Not Allowed' }); }

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { resolve({ _raw: data }); }
    });
  });
}

export function startMockServer(port = 0) {
  const state = makeState();
  const log = [];
  const authOf = (h) => {
    const m = /^bearer\s+(\S+)$/i.exec(h || '');
    if (!m) return 'missing';
    return m[1] === EXPECTED_TOKEN ? 'ok' : 'wrong';
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const body = await readBody(req);
    const entry = {
      method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
      authorization: req.headers['authorization'] || '', contentType: req.headers['content-type'] || '',
      headers: req.headers, body
    };
    log.push(entry);

    const auth = authOf(req.headers['authorization']);
    if (auth === 'missing') {
      state.authFailures++;
      return authError(res, 403, 'Must supply an API key! Check your request and try again.');
    }
    if (auth === 'wrong') {
      state.authFailures++;
      return authError(res, 401, 'Cannot authenticate with the server. Please check your API key and try again.');
    }

    const p = url.pathname;
    const m = req.method;

    // --- the models catalog (control plane)
    if (p === '/v1/models') {
      if (m === 'GET') return ok(res, { models: MODELS.map((x) => ({ ...x })) });
      return methodNotAllowed(res);
    }

    // --- the System One evaluation endpoint (inference plane)
    if (p === '/v1/systemone') {
      if (m !== 'POST') return methodNotAllowed(res);
      const invalid = validateRequest(body);
      if (invalid) return send(res, invalid.status, invalid.body);

      // transient-failure fixtures (first call only)
      if (typeof body.state === 'string' && body.state.includes(RETRY_ONCE_MARKER) && state.retryHits === 0) {
        state.retryHits++;
        return send(res, 429, { detail: { error_type: 'rate_limit_error', message: 'Rate limit exceeded. Back off and retry after a short delay.' } }, { 'retry-after': '1' });
      }
      if (typeof body.state === 'string' && body.state.includes(OVERLOADED_ONCE_MARKER) && state.overloadedHits === 0) {
        state.overloadedHits++;
        return send(res, 529, { detail: { error_type: 'overloaded_error', message: 'Service overloaded. Retry with backoff.' } });
      }

      const answers = {};
      let outputTokens = 0;
      for (const [id, q] of Object.entries(body.questions)) {
        answers[id] = answerFor(q);
        outputTokens += 20;
      }
      const inputTokens = tokensOf(body.state) + tokensOf(body.questions);
      state.evaluations++;
      state.inputTokens += inputTokens;
      state.outputTokens += outputTokens;
      return ok(res, { model: RESOLVED_MODEL, answers, usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
    }

    if (p === '/health') return ok(res, { status: 'ok' });
    return notFound(res);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, log, state });
    });
  });
}

if (process.argv[1] && /mock_[a-z0-9_]+_server\.mjs$/.test(process.argv[1])) {
  const p = Number(process.argv[2] || 0);
  const { port } = await startMockServer(p);
  console.log(`mock TypeSafe API listening on http://127.0.0.1:${port}`);
  console.log(`expects: Authorization: Bearer ${EXPECTED_TOKEN}`);
}
