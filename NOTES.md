# Engineering Notes

The memory of the build: numbered findings with evidence (what was measured, against what, what was decided and why), the blockers only a live run can resolve, and the testing requirements. A future refresh reads this before touching a rule. Cross-build findings from the sibling providers (see the skill's reference-repos.md) are reused, not re-derived - cited by repo rather than restated.

Sources: the pinned spec snapshot (`provider-dev/downloaded/typesafe-v1.json`, upstream sha256 `a191f8a7df6b...`, fetched 2026-10-02), the vendor documentation (`https://docs.typesafe.ai/llms.txt` is the index; every page serves markdown at its `.md` URL), unauthenticated probes of `api.typesafe.ai` (2026-10-02, before an account existed), the first live run against a dev account with purchased credits (2026-10-05, finding 12), the mock API in `tests/integration/`, stackql v0.12.732 (any-sdk v0.6.0-alpha01) under WSL, `@stackql/provider-utils` 0.7.11, and the anthropic, gemini, openai and supabase sibling builds.

## Findings

In the order they were established; each ends with where the decision lives.

### 1. The spec: FastAPI-published, two operations, not linked from the docs

**Question.** Does TypeSafe publish a machine-readable API definition, and what does it contain?

**Evidence.** The documentation site (Mintlify) links no OpenAPI file, but the API host serves one: `GET https://api.typesafe.ai/openapi.json` returns 200 (14158 bytes; `/docs` and `/redoc` serve the Swagger UI and ReDoc pages for it; `/openapi.yaml` and `/v1/openapi.json` are 404). It is OpenAPI 3.1.0, `info.title` TypeSafe, `info.version` 0.2.0, 2 paths and 2 operations (`POST /v1/systemone`, `GET /v1/models`), one security scheme (`HTTPBearer`), no `servers`, no tags, no path or query parameters anywhere, no pagination fields. JSON Schema 2020-12 constructs: 7 `{type: "null"}` union members and 6 `const` discriminator values; `record_spec_pin.mjs` lowers them (`type_null_to_nullable=7`, `const_to_enum=6`) and `@apidevtools/swagger-parser` 13.1.0 validates the result. No credential-shaped example values to redact. The document is unversioned and unauthenticated, so the pin is the upstream sha256 and the weekly drift job compares against it.

**Decision.** Direct archetype; `SPEC_URL` in `lib/spec_helpers.mjs`; the snapshot is committed. The vendor SDKs (`typesafe-sdk` on PyPI, `@typesafe-ai/sdk` on npm) are generated from this document (the SDK docs say the raw client is regenerated from the official OpenAPI definition), so there is nothing to derive from SDK source.

### 2. There is no admin or usage control plane

**Question.** The brief asked for the admin / usage control plane as well as the inference plane. Does one exist?

**Evidence.** Three independent checks on 2026-10-02:

- The documentation index (`llms.txt`, 60 pages) and the full text (`llms-full.txt`) contain no organization, project, workspace, key-management, usage-report or billing endpoint. Key management is described once, as the console: "create an API key" at `https://console.typesafe.ai/keys`. Usage is described as the per-request `usage` object (`input_tokens`, `output_tokens`).
- The API host discriminates missing routes from protected ones: `GET /v1/models` without a key returns 403 with an `authentication_error` body, while `/v1/usage`, `/v1/usage/summary`, `/v1/keys`, `/v1/api-keys`, `/v1/api_keys`, `/v1/organizations`, `/v1/organization`, `/v1/projects`, `/v1/me`, `/v1/account`, `/v1/billing`, `/v1/credits`, `/v1/limits`, `/v1/rate-limits`, `/v1/batches`, `/v1/evaluations`, `/v1/models/jev-latest` and `/v2/models` all return 404 `{"detail":"Not Found"}`. Only `/health` (200 `{"status":"ok"}`) exists outside the spec.
- The published OpenAPI document lists exactly the two operations.

**Decision.** The provider maps what exists: `models` (the control plane the API exposes - which model names the key may use) and `systemone` (the inference plane). The getting-started page says so plainly, including where keys are managed and that usage is per request. If TypeSafe publishes an admin API, the `openai` / `openai_admin` precedent applies (a separate key class gets a sibling provider; the same key class gets a service here), decided on the evidence then.

### 3. Authentication, env var parity and the fixed host

**Question.** Which env var, which auth type, and is there a scoping variable or a host override to model?

**Evidence.** No TypeSafe provider exists on registry.terraform.io (searched 2026-10-02), so parity falls to the vendor SDKs and CLI examples: the Python SDK reads `TYPESAFE_API_KEY` (required), `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`), `TYPESAFE_DEFAULT_MODEL` (default `jev-latest`) and `TYPESAFE_LOG_LEVEL`; every docs curl example uses `Authorization: Bearer $TYPESAFE_API_KEY`. The spec's only security scheme is `http` / `bearer`. An unauthenticated `POST /v1/systemone` returns 403 `{"detail":{"error_type":"authentication_error","message":"Must supply an API key! Check your request and try again."}}`; a wrong key returns 401 `{"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server. Please check your API key and try again."}}` (live, 2026-10-05; the API reference table paraphrases it as "Missing or invalid API key"). Responses carry an `x-typesafe-request-id` header. There is no organization, project or workspace path parameter, so there is no scoping server variable. `TYPESAFE_BASE_URL` exists to route through OpenRouter, Vercel AI Gateway or Pydantic AI Gateway, each of which needs a different key and different model identifiers.

**Decision.** `provider_config.json`: `{"auth": {"type": "bearer", "credentialsenvvar": "TYPESAFE_API_KEY"}}`; `servers.json`: the fixed host `https://api.typesafe.ai`; no `x-stackQL-envVar`. Gateway routing is not modelled: a server template with a defaulted `base_url` variable would put that variable in every generated example and still not cover the gateway's key and model-id changes. The mock enforces the bearer key and returns the captured 403 body for a missing key and the captured 401 body for a wrong one. `TYPESAFE_DEFAULT_MODEL` is not mirrored: `model` stays a required WHERE key (the versioned id in the response is what makes an evaluation reproducible, and the docs recommend pinning it).

### 4. The flagship mapping: POST /v1/systemone as SELECT

**Question.** The brief named two inference archetypes - POST as SELECT (anthropic `messages.create`) and POST as INSERT ... RETURNING (supabase `database.queries.run`). Which fits System One?

**Evidence.** An evaluation creates nothing: there is no id in the response, no list or get of past evaluations, nothing to delete. The response (`model`, `answers`, `usage`) is the result the caller wants, exactly the anthropic case ("the result IS a result set"). The supabase shape is for a statement that mutates the database it runs against. The gemini build applied the same rule to `generateContent`, `countTokens` and `embedContent`. Mechanically the mapper would have produced `systemones.create` as INSERT; `RESOURCE_RULES` and `METHOD_RULES` in `map_operations.mjs` name it `evaluations.evaluate` as `select`.

Wire-verified against the mock with `probe.mjs` (stackql v0.12.732):

- `SHOW EXTENDED METHODS IN typesafe.systemone.evaluations` lists `evaluate`, `SELECT`, required params `model, questions, state` (the body's `required` list surfaces as routing requirements under naive translation).
- `WHERE state = '...' AND model = 'jev-latest' AND questions = '{"is_urgent": {"type": "noul", ...}}'` is sent as `{"model":"jev-latest","questions":{"is_urgent":{...}},"state":"..."}`: the questions string fans out to a JSON object, the plain-text state stays a string, and a state given as a JSON object or JSON array string is sent as that object or array. Nothing else is in the body.
- The row comes back as `model`, `answers` (the answers map, rendered as JSON text by `--output json`) and `usage`; `json_extract(answers, '$.is_urgent.noul')` and `json_extract(usage, '$.input_tokens')` work directly.
- Omitting `questions` fails to route ("cannot find matching operation ... no appropriate method = 'select'"), so the required-field contract is enforced before any request is made.
- A 422 from the API surfaces with the vendor's `detail` list verbatim in the stackql error.

**Decision.** `evaluations.evaluate` SELECT with `requestBodyTranslate: naive` (the generator's `--naive-req-body-translate`); `models.list` SELECT with `objectKey: $.models` (from the CSV; the only array property of `ModelMetadataList`). One shape per resource holds: each resource has one method.

### 5. Normalize and the free-form content unions

**Question.** What does provider-utils normalize do to the spec's `anyOf` unions, and does the generated schema need help?

**Evidence.** The vendor types `state`, every `instructions`, the Noul criteria descriptions, the Choice criteria values, the Score criteria levels and the Score answer legend as `anyOf: [string, object (additionalProperties: true), array (items: {})]`, some with a null member. Run straight through normalize, each became `type: string` with a stray `additionalProperties: true` and `items: {}` beside it (the union members merged into one schema). `Question` and `Answer` are discriminated `oneOf` unions; normalize merges them into a single schema that keeps the first member's description and the union of the members' `required` lists (harmless: both sit under JSON columns - `questions` is a request string, `answers` a JSON column - and the per-type schemas are still present by name). `ValidationError.ctx` (an untyped object) is converted to an opaque string.

**Decision.** `pre_normalize.mjs` pass 2 lowers the nine string | object | array (| null) unions to `string` (nullable where a null member existed), keeping the vendor's title, description and examples, before normalize runs. Normalize then reports `oneOfRenamed: 2, anyOfRenamed: 1` (the remaining `anyOf` is `ValidationError.loc` items, string | integer, untouched by design). The generated `state` is a clean `type: string`. The docgen output shows the vendor's descriptions unchanged.

### 6. Columns, output rendering and the SELECT-only surface

**Question.** What does the user see?

**Evidence.** `DESCRIBE EXTENDED typesafe.systemone.evaluations`: `answers` (object), `model` (string), `usage` (object). `DESCRIBE EXTENDED typesafe.models.models`: `name`, `description`, `release_date` (strings). Live, `release_date` is an ISO 8601 timestamp (`2026-09-10T18:38:01.391457+00:00`), not the `YYYY-MM-DD` the spec's description promises; the column type is string either way and the vendor description passes through unchanged. `SHOW METHODS` on both resources lists only SELECT methods; the meta-route walk reports 2 services, 2 resources, 2 methods, 2 selectable, 0 non-selectable. The wire is snake_case already, so `snake_case_aliases` is not set and no `nativeCasing` is needed. Object columns render as JSON text under `--output json` (and as JSON in pystackql dict output), which `json_extract` reads.

**Decision.** No response transform: flattening `usage` into `input_tokens` / `output_tokens` columns or exploding `answers` into one row per question would hide the per-request shape the vendor documents and would complicate the single-row contract; `json_extract` is the idiom the docs teach. No views: with two resources there is no posture query a view would simplify.

### 7. Retry policy: service level works, provider level does not

**Question.** The API reference tells clients to back off and retry on 429 (rate limit, with `retry-after`) and 529 (overloaded), and the vendor SDKs retry by default. Can the provider carry that?

**Evidence.** any-sdk v0.6.0-alpha01 (the version stackql v0.12.732 pins) has a policy-based retry (`internal/anysdk/retry.go`, `client.go doWithRetry`): exponential backoff, defaults of 3 attempts / 500 ms / 10 s / 2.0 / no jitter, retryable methods GET and HEAD only, retryable status codes 408, 429, 502, 503, 504; it does not read `retry-after`. `operation_store.go GetRetryPolicy` walks method -> resource -> service -> providerService -> provider. On the mock (a 429 then 200 on the same `state`, likewise 529):

- with the block only in `provider.yaml` `config.retry`: one POST, the 429 surfaced as an error;
- with the block as the service document's `x-stackQL-config.retry`: two POSTs, the row returned, for both 429 and 529.

So at this engine version the provider-level block is not consulted (the provider document's `config` does not reach the walk), while the service level is. The vendor limits for Jev 1.13 are 80 requests per second and 100K tokens per second, "adjusting dynamically" during early access (docs.typesafe.ai/models).

**Decision.** `provider-dev/config/service_config.json` carries the policy and `generate` passes it as `--service-config`, which provider-utils writes as the document-level `x-stackQL-config` of every service: exponential, `max_attempts: 3`, `initial_delay_ms: 500`, `max_delay_ms: 10000`, `multiplier: 2.0`, `jitter_fraction: 0.1`, `retryable_methods: [GET, HEAD, POST]` (an evaluation has no side effects, so retrying the POST is safe and is what the SDKs do), `status_codes: [408, 429, 502, 503, 504, 529]`. `post_process.mjs` validates the block is present with POST on every service so a Makefile change cannot drop it silently. `provider_config.json` carries auth only. The integration suite asserts the two-attempt behaviour for 429 and 529. The retry means a single 429 under the smoke suite's pacing is absorbed; a 429 that survives three attempts fails the run and is a harness bug.

### 8. Pricing, budget and pacing

**Question.** What does the smoke suite cost, and how fast may it go?

**Evidence.** docs.typesafe.ai/models (2026-10-02): Jev 1.13 is `$0.042` per million input tokens; output tokens are free; context 64k tokens per request. The docs' own examples report 296 to 392 input tokens for a one-sentence support message with one question. The suite issues nine evaluations (noul, choice, score, the three mixed, a structured state, a pinned model id, a `json_extract` read) plus the free catalog read. Measured on 2026-10-05: 2485 input tokens and 217 output tokens for the full run (17 checks over 9 statements), about `$0.0001`; the docs' one-question support-ticket example costs 302 input tokens. The suite sums the `usage` column and prints the token total and cost.

**Decision.** `INTER_REQUEST_DELAY_S = 1.0` (two orders of magnitude under 80 requests per second). `--read-only` runs the catalog only and spends nothing. No gated lifecycle and no breadcrumb sweep exist because the API creates nothing; the corresponding Makefile targets were removed rather than left as no-ops.

### 9. Docgen: required params on a SELECT-routed body method

**Question.** Does the generated documentation show `state`, `model` and `questions` as required for `evaluate`?

**Evidence.** provider-utils 0.7.10 `src/docgen/resource/methods.js getRequiredBodyParams` builds required params from `requestBody.required` only for insert / update / replace / exec access types, and `examples/select-example.js` builds the SELECT example's WHERE from `parameters` only. The anthropic build (`factory/patch-provider-utils.mjs`) and the gemini build hit the same gap on 0.7.7 and 0.7.9 and carry a two-edit patch; the anchors are unchanged in 0.7.10 and 0.7.11. 0.7.11 (bumped 2026-10-06) changes docgen only: a `--source-project` flag adds a `source project` row to the landing page's Provider Summary admonition, linking the repository name to the URL; `make docs` passes it from the Makefile variable `SOURCE_PROJECT`.

**Decision.** `bin/patch-provider-utils.mjs`, run as the npm `postinstall` hook, applies the same two edits plus a third of its own in `parameters.js` (the body properties of a SELECT-routed naive method are listed in the Parameters table, where the Methods table's required-param links point); all three are idempotent and the script exits non-zero with PATTERN NOT FOUND when upstream moves. With it the `evaluate` page documents `model`, `questions` and `state` as required parameters with the vendor's descriptions, and its generated SELECT example carries them in the WHERE clause. `sanitize-docs.mjs` additionally keeps docgen's `<br />` line breaks in description cells as tags instead of escaping them to text (the two multi-paragraph operation descriptions would otherwise show literal `<br />`). Remove the hook once a provider-utils release includes `select` in the allowlist.

### 10. Labels, errors and headers

**Evidence.** The spec carries no `deprecated` flags and no beta / alpha / preview wording; the vendor's own labelling is the `jev-preview` alias (live description: "A preview version of `jev-latest`: should be better in most ways"). Error bodies observed live (2026-10-05): a wrong key is 401 and a missing key 403, both `{"detail": {"error_type": "authentication_error", "message"}}`; an unknown model name is 400 `{"detail": {"error_type": "api_usage_error", "message": "Unknown model: jev-typo"}}`; a question with an unknown `type` is 400 `{"detail": {"error_type": "api_usage_error", "message": "Invalid request."}}` rather than the spec's 422 `HTTPValidationError` (which the live API was not seen to emit; it presumably covers a structurally missing field). Unauthenticated probes: 404 `{"detail": "Not Found"}`, 405 `{"detail": "Method Not Allowed"}`. No rate-limit headers on a live 200 (HTTP/2, `content-type` and `x-typesafe-request-id` only). stackql surfaces every body verbatim in its error text.

**Decision.** The getting-started page states the error contract in one paragraph; the mock reproduces each observed body (400 `api_usage_error` for an unknown model or a malformed question, the 422 list for a missing field) and the integration suite asserts the 400 and 401 paths.

### 11. Mapping stability

**Evidence.** `all_services.csv` has two rows: `models.yaml` / `models_v1_v1_models_get` -> `models.list` select `$.models`; `systemone.yaml` / `systemone_v1_systemone_post` -> `evaluations.evaluate` select. `endpoint_inventory.csv`: 2 operations, 2 mapped, 0 skipped, 0 labelled, no pagination parameters.

**Decision.** The CSV is the contract. A refresh that adds operations extends it; one that renames an operationId must keep `evaluations.evaluate` and `models.list` through the rule tables.

### 12. Live runs (2026-10-05): the published examples, as written

**Question.** Do the SQL examples on the getting-started page, the smoke suite and the negative paths behave live as the mock predicted?

**Evidence.** Two rounds, both from WSL with stackql v0.12.732 and the API key in `.env`. The first round ran the original six examples (catalog, one Noul, Choice plus Score, structured state, a pinned version, the cross-provider UNION with the registry's `anthropic` provider beside this one in a temporary registry): every one returned the expected shape. The smoke suite's first run exposed a harness bug, not an API one (three `contains` checks looked for a quoted type name in a result blob where the `answers` column is JSON text with escaped quotes); fixed, the suite passes 17 checks over 9 statements at 2485 input tokens, about `$0.0001`.

The second round followed the realignment of the page around agent routines (finding 13). `bin/validate-docs-examples.sh` extracts every `sql` block, strips the comment lines, splits on `;` and runs each statement: the typesafe ones live, the aws / k8s / okta / github / anthropic ones against a temporary registry built from the registry clone with dummy credentials, so each must reach the wire (an auth or network error) rather than fail to route. 25 statements, 0 routing failures; the Jev decisions the page shows:

| Example | Live answer (jev-1.13.0) |
|---|---|
| Quick start: needs_escalation | 0.84 (294 input tokens) |
| A decision as a query: is_urgent | 0.98 (302 input tokens) |
| Tagging hygiene | environment production, confidence 1.0; owner_team platform |
| Rightsizing and off-hours | action stop_outside_hours, confidence 0.86 to 0.91 across runs; schedulable 0.86 to 0.87 |
| Incident triage | cause dependency; severity 2.21 to 2.25; reschedule_helps 0.21 (the routine would not delete the pod - the log tail names a saturated database pool) |
| Access review | admin_role_fits 0.16; account_kind contractor, confidence 1.0 |
| Public ingress review | justified 0.03 to 0.04; exposure database_port, confidence 1.0 |
| Audit findings | in_policy 0.02; risk 1.99 |
| Pinning a model version: is_spam | 0.94 to 0.95 |
| Cross-provider UNION | 2 typesafe rows + 15 anthropic rows |

Context and action statements against the other providers: `aws` 401 AuthFailure (routed and signed), `okta` 401 invalid token, `github` 404 for the dummy repo, `k8s` connection refused on the dummy host. Three facts about those providers came out of the check and shaped the examples: the aws rules column is `cidr_ipv_4` (snake conversion of `CidrIpv4`), aws list parameters (`Tag`, `InstanceId`) take JSON arrays or a single value under the provider's canonical query transposition, and a k8s `DELETE` routes only once `KUBE_HOST` (the `cluster_addr` server variable) is set - with it unset the variable is a required WHERE key, and a host with a port on a bare IP breaks route matching while `localhost:6443` works.

**Decision.** The page stands as written; Choice confidences and Scores drift slightly between identical calls, so the docs quote no exact numbers. The mock's model descriptions, `release_date` values and error bodies are the live ones; the integration suite asserts the 400 `api_usage_error` shape. `bin/validate-docs-examples.sh` is the pre-publish check for the examples (it needs a registry clone; see README step 6).

### 13. Question design: ask Jev the judgment, compute the facts

**Question.** The page is organised around agent routines over the StackQL MCP server (context rows -> decision -> gated mutation). How should the questions in those routines be written?

**Evidence.** The first draft of the access-review example asked a Noul "Is this account dormant as of review_date?" with a 90-day criterion in the `criteria`, over a record whose `lastLogin` was 160 days old. Jev answered 0.54, then 0.58 with `days_since_last_login: 160` spelled out, 0.66 at 307 days, and 0.88 only when an HR note said the contract had ended: it treats "dormant" as a judgment about the person, not as date arithmetic. The same record asked "Do the title and department justify the roles this account holds?" answered 0.16 to 0.18 every time, and "What kind of account is this?" answered contractor with confidence 1.0. By contrast the CSPM question ("Do the description, group name and port justify ingress from the whole internet?") and the audit question (the change policy written into `criteria`) answered 0.03 and 0.02 with no drift, and the incident question declined a pod restart (0.21) because the log tail named a saturated dependency.

**Decision.** Facts a routine can compute - days since a sign-in, whether a CIDR is `0.0.0.0/0`, a port number - stay in SQL or in the agent, and are passed to Jev as fields of the state; Jev is asked the judgment the record cannot compute, one atomic question at a time, with the policy in `criteria`. Thresholds are stated per routine (a Noul at or above 0.9 or at or below 0.1, a Choice `confidence` at or above 0.9), and the `model` column is recorded with every action. The getting-started page's "Decisions in an agent routine" section states this; every example on it is written in that shape.

## Spec refreshes

None yet. Initial pin 2026-10-02: upstream sha256 `a191f8a7df6bd6fedced8120dd0fd106f88575d1d1c8360d08900a6c7c0360d5`, sanitized sha256 `00bb0580854e...`, 2 paths / 2 operations.

## Blockers - what only a live run can establish

Resolved by the first live run on 2026-10-05 (finding 12): a wrong key is 401 and stackql surfaces the body; an unknown model is 400 `api_usage_error`; a smoke run costs about `$0.0001` (2485 input tokens); `GET /v1/models` lists `jev-latest` and `jev-preview` for a new account and `jev-latest` resolves to `jev-1.13.0`; a structured state with backticked field references answers as the State guide describes.

Still open, because they need the service to misbehave:

1. The 529 (overloaded) path and whether a `retry-after` value accompanies a live 429 (the engine ignores the header; its own backoff applies). The mock proves the retry loop.
2. Whether a structurally missing required field is the spec's 422 `HTTPValidationError` list or another 400 `api_usage_error` (the provider never sends such a request: a statement missing a required field does not route).

## Testing requirements

- `make test` green after every regeneration (offline 16 checks, integration 28 checks, meta-route walk over 2 services / 2 resources / 2 methods).
- `make smoke` against the dedicated dev account before a publish; `make smoke-live` after. `bin/validate-docs-examples.sh` before a docs publish (every SQL block on the getting-started page routes; the typesafe ones run live).
- Budget: measured `$0.0001` per default run on 2026-10-05 (2485 input tokens at `$0.042` per million); `smoke-read-only` spends nothing; there is no gated lifecycle.
