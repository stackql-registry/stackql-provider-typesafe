#!/usr/bin/env node

// Local patch for @stackql/provider-utils' docgen, run as the npm postinstall
// hook so a fresh `npm install` / `npm ci` is always patched before
// `make docs`.
//
// Upstream gap (provider-utils 0.7.10, the same in 0.7.7 and 0.7.9): docgen
// builds a method's "Required Params" from `parameters` plus
// requestBody.required, but ONLY for insert / update / replace / exec access
// types (src/docgen/resource/methods.js getRequiredBodyParams), and the
// Parameters table and the SELECT example read `parameters` only. A
// SELECT-routed body-bearing method - here systemone.evaluations.evaluate,
// the anthropic messages.create precedent - therefore documents EMPTY
// required params, an empty Parameters table and a SELECT example with no
// WHERE clause, although the engine requires the body fields (state, model,
// questions) to route the statement. Three minimal, idempotent edits:
//   1. methods.js - include 'select' in the access-type allowlist (and in
//      the data__-prefix branch, which naive translate disables anyway)
//   2. examples/select-example.js - append the body-required fields to the
//      SELECT example's WHERE clause so the sample is routable
//   3. parameters.js - list the body properties of a SELECT-routed naive
//      method in the Parameters table (the Methods table links to them)
//
// Edits 1 and 2 are carried from the anthropic and gemini sibling builds
// (their factory/patch-provider-utils.mjs); edit 3 is this build's. Delete
// this file and the postinstall hook once a provider-utils release contains
// the fix; the script exits non-zero with PATTERN NOT FOUND when the
// upstream source moves, so a toolchain bump surfaces it. The upstream files
// may carry CRLF line endings (npm on Windows), so edit 3 matches with a
// line-ending-tolerant regex.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(path.dirname(here), 'node_modules', '@stackql', 'provider-utils', 'src', 'docgen');

if (!fs.existsSync(base)) {
  console.log('patch-provider-utils: @stackql/provider-utils is not installed yet - nothing to patch');
  process.exit(0);
}

// ---- 1. methods.js -----------------------------------------------------------
const methodsPath = path.join(base, 'resource', 'methods.js');
let methods = fs.readFileSync(methodsPath, 'utf8');
const guardBefore = "if (!['insert', 'update', 'replace', 'exec'].includes(accessType)) {";
const guardAfter = "if (!['insert', 'update', 'replace', 'exec', 'select'].includes(accessType)) {";
const prefixBefore = "if (['insert', 'update', 'replace'].includes(accessType) && !hasNaiveTranslate) {";
const prefixAfter = "if (['insert', 'update', 'replace', 'select'].includes(accessType) && !hasNaiveTranslate) {";
let patched = 0;
if (methods.includes(guardBefore)) { methods = methods.replace(guardBefore, guardAfter); patched++; }
if (methods.includes(prefixBefore)) { methods = methods.replace(prefixBefore, prefixAfter); patched++; }
if (patched) fs.writeFileSync(methodsPath, methods);
const methodsStatus = patched ? `patched (${patched} edits)` : (methods.includes(guardAfter) ? 'already patched' : 'PATTERN NOT FOUND - provider-utils changed, re-verify');
console.log(`patch-provider-utils: methods.js: ${methodsStatus}`);

// ---- 2. select-example.js -----------------------------------------------------
const selPath = path.join(base, 'resource', 'examples', 'select-example.js');
let sel = fs.readFileSync(selPath, 'utf8');
const anchorBefore = `        // Add WHERE clause with parameters
        const requiredParams = Object.keys(methodDetails.requiredParams || {});`;
const anchorAfter = `        // Add WHERE clause with parameters
        // (patched: body-required fields participate in routing for
        // SELECT-mapped body-bearing methods - naive translate exposes them
        // under their native names)
        const bodyRequired = (methodDetails.requestBody && methodDetails.requestBody.required) || [];
        const requiredParams = [...new Set([...Object.keys(methodDetails.requiredParams || {}), ...bodyRequired])];`;
let selStatus;
if (sel.includes(anchorBefore)) {
  sel = sel.replace(anchorBefore, anchorAfter);
  fs.writeFileSync(selPath, sel);
  selStatus = 'patched';
} else {
  selStatus = sel.includes('bodyRequired') ? 'already patched' : 'PATTERN NOT FOUND - provider-utils changed, re-verify';
}
console.log(`patch-provider-utils: select-example.js: ${selStatus}`);

// ---- 3. parameters.js ---------------------------------------------------------
const paramsPath = path.join(base, 'resource', 'parameters.js');
let params = fs.readFileSync(paramsPath, 'utf8');
const paramsBefore = /const allMethods = allMethodTypes\.flatMap\(type =>[ \t]*\r?\n\s*Object\.values\(getSqlMethodsWithOrderedFields\(resourceData, dereferencedAPI, type, casing\)\)[ \t]*\r?\n\s*\);/;
const paramsAfter = `const allMethods = allMethodTypes.flatMap(type =>
        Object.values(getSqlMethodsWithOrderedFields(resourceData, dereferencedAPI, type, casing)).map((method) => {
            // (patched: a SELECT-routed body-bearing method under naive translate
            // takes its body properties as WHERE keys - list them as parameters)
            if (type !== 'select' || method.methodConfig?.requestBodyTranslate?.algorithm !== 'naive') return method;
            const props = method.requestBody?.properties || {};
            const required = new Set(method.requestBody?.required || []);
            const requiredParams = { ...(method.requiredParams || {}) };
            const optionalParams = { ...(method.optionalParams || {}) };
            for (const [name, schema] of Object.entries(props)) {
                if (requiredParams[name] || optionalParams[name]) continue;
                (required.has(name) ? requiredParams : optionalParams)[name] = { type: schema.type || 'object', description: schema.description || '' };
            }
            return { ...method, requiredParams, optionalParams };
        })
    );`;
let paramsStatus;
if (paramsBefore.test(params)) {
  params = params.replace(paramsBefore, paramsAfter);
  fs.writeFileSync(paramsPath, params);
  paramsStatus = 'patched';
} else {
  paramsStatus = params.includes('takes its body properties as WHERE keys') ? 'already patched' : 'PATTERN NOT FOUND - provider-utils changed, re-verify';
}
console.log(`patch-provider-utils: parameters.js: ${paramsStatus}`);

if (/PATTERN NOT FOUND/.test(methodsStatus + selStatus + paramsStatus)) process.exit(1);
