# CLAUDE.md

Project rules for the `typesafe` StackQL provider: what it covers, the settled decisions, the pipeline and the non-negotiables. Read in full before changing a rule.

## Project

This repository builds and documents the `typesafe` provider for [StackQL](https://github.com/stackql/stackql): SQL access to the TypeSafe AI API (`https://api.typesafe.ai`), the hosted service behind Jev, TypeSafe's flagship System One model. The published API has two operations and the provider maps both: `GET /v1/models`, the models and aliases an API key can use (`typesafe.models.models`, the control plane), and `POST /v1/systemone`, the evaluation endpoint that answers typed questions (Noul, Choice, Score) about a `state` (`typesafe.systemone.evaluations`, the inference plane, bound as `SELECT`).

The primary use case is the agent routine over the StackQL MCP server: `run_select_query` against another provider for context, `run_select_query` against `typesafe.systemone.evaluations` with the record as the JSON `state` for the decision, then `run_mutation_query` or `run_lifecycle_operation` against the owning provider only when the decision clears the routine's threshold. The docs examples are written in that shape for platform engineering, FinOps and GreenOps, SRE, access review, CSPM and audit, against real surfaces of the `aws`, `k8s`, `okta` and `github` providers (NOTES.md findings 12 and 13).

Scope notes, recorded so they are never relitigated:

- **There is no admin or usage API to map.** TypeSafe manages API keys in its console (`https://console.typesafe.ai/keys`) and reports token usage per request in the `usage` field of each evaluation; no organization, project, key, usage or billing endpoint exists (NOTES.md finding 2 has the probe evidence). When one is published it becomes a `typesafe_admin` sibling (the `openai` / `openai_admin` precedent) or a new service here, decided at that time.
- **Everything in the API is a read.** No `INSERT`, `UPDATE` or `DELETE` method exists, so the smoke suite has no write lifecycles, no breadcrumb sweep and no gated lifecycle; its billed statements are evaluations (fractions of a cent).
- **Gateway routing is not modelled.** The vendor SDKs accept `TYPESAFE_BASE_URL` to route through OpenRouter, Vercel AI Gateway or Pydantic AI Gateway; those gateways also change the key and the model ids, so the provider pins the vendor host (NOTES.md finding 3).

## How to work in this repository

The build procedure is the `stackql-provider-development` skill in `.claude/skills/stackql-provider-development/` (`SKILL.md` is the map; `references/*.md` are the procedures; `scripts/` holds `spec_diff.mjs` and `find_extension_examples.sh`). Read the reference file for a step before executing it. Work the steps in order: archetype -> spec pin -> inventory and split -> mappings -> pre-normalize / normalize / generate / post-process -> Makefile -> the three credential-free test layers -> smoke suite -> docs and CI -> hand-over. On a spec refresh, run `scripts/spec_diff.mjs` on the old and new snapshots first and record the summary in NOTES.md; a diff in `provider-dev/config/all_services.csv` is a breaking-change review.

The provider constants live in `provider-dev/scripts/lib/spec_helpers.mjs` (`SPEC_URL`, `SPEC_FILE`, `PATH_VERSION_PREFIX`, `SCOPE_PREFIX` null, `WIRE_CASING` null) and `provider-dev/config/*.json`. WSL is the execution environment on a Windows machine (`make` and `stackql` run there; node steps also run from Windows).

## Archetype

Direct. TypeSafe publishes an OpenAPI 3.1.0 document at `https://api.typesafe.ai/openapi.json` (FastAPI-generated, served unauthenticated at an unversioned URL alongside `/docs` and `/redoc`; it is not linked from docs.typesafe.ai, which is why the pin records the URL). Pinned in `provider-dev/config/spec_pin.json` by upstream sha256; `make fetch-spec` fails on drift and the weekly `spec-drift` workflow opens an issue. Refresh cadence: on drift, reviewed.

## Design decisions (settled - see NOTES.md for the evidence)

- **Authentication** - `auth.type: bearer`, `credentialsenvvar: TYPESAFE_API_KEY`. TypeSafe has no Terraform provider, so the name follows the vendor SDKs and every docs curl example. Fixed API base `https://api.typesafe.ai`; no server template.
- **Scoping** - none. No organization, project or workspace path parameter; no `x-stackQL-envVar`; the JOIN fan-out caveat does not arise.
- **The flagship mapping** - `POST /v1/systemone` -> `typesafe.systemone.evaluations.evaluate`, bound as `SELECT` (the anthropic `messages.create` POST-as-SELECT precedent): the response is the result set, nothing is created, nothing can be listed or deleted afterwards. The three required body fields (`state`, `model`, `questions`) are the WHERE keys under naive body translation; `questions` is a JSON object passed as a string and fans out to the object on the wire, `state` goes as the string, object or array it is. `INSERT ... RETURNING` (the supabase query-endpoint precedent) was rejected because that shape is for a statement that mutates. One row per evaluation: `model`, `answers` (JSON), `usage` (JSON); `json_extract` addresses the answers. `GET /v1/models` -> `typesafe.models.models.list` with `objectKey: $.models`. Live-verified 2026-10-05 (NOTES.md finding 12): every getting-started example runs as published.
- **Casing** - the wire is snake_case already (`input_tokens`, `release_date`); no `snake_case_aliases`, no `nativeCasing`.
- **Pagination** - none: `GET /v1/models` returns the complete list and declares no paging or query parameters; `POST /v1/systemone` takes none. No pushdown configuration.
- **Update semantics** - not applicable (no PUT or PATCH).
- **Skip codes** - none in use; both operations map.
- **Retry and rate limit** - Jev 1.13: 80 requests per second and 100K tokens per second, adjusted dynamically during early access; 429 on either limit (with `retry-after`), 529 when overloaded. The provider carries the vendor SDKs' default posture as a retry policy on every service document (`provider-dev/config/service_config.json` via `--service-config`): exponential, 3 attempts, 500 ms initial, 10 s cap, 10% jitter, `POST` included (an evaluation has no side effects), status codes 408 / 429 / 502 / 503 / 504 / 529. It sits at service level because stackql v0.12.732 does not consult a provider-level `retry` block (finding 7, mock-verified). Harness pacing is 1.0 s per statement; a 429 that survives the retries in CI is a harness bug.
- **Labels and errors** - the spec carries no beta / alpha / deprecated labels; the `jev-preview` alias is explained on the getting-started page. Live error contract: wrong key 401, missing key 403 (`authentication_error`); unknown model or malformed question 400 (`api_usage_error`), not the spec's 422 (finding 10).
- **Engine typing** - UPDATE marshals every SET value as a string; INSERT and EXEC send typed JSON; EXEC cannot carry a boolean. Documented for completeness; no method here uses those verbs.
- **Content unions** - the vendor's `string | object | array (| null)` unions on `state`, `instructions`, criteria descriptions and the score legend are lowered to `string` in `pre_normalize.mjs` (9 sites) before provider-utils normalize, which would otherwise leave `additionalProperties: true` and `items: {}` on a `type: string` property. On the SQL surface those values are always strings.
- **Docs examples** - three-statement agent-loop blocks (context, decision, action) against verified sibling-provider surfaces, plus a few plain SELECTs and a shell quick start. Facts a routine can compute stay in SQL; Jev is asked the judgment, one atomic question at a time, with the policy in `criteria` (finding 13). `bin/validate-docs-examples.sh` runs every block before a docs publish: typesafe live, the other providers routed with dummy credentials through a registry clone (finding 12). Known provider facts the examples depend on: aws `cidr_ipv_4`, aws list params as JSON arrays, k8s needs `KUBE_HOST`.
- **Docgen** - `bin/patch-provider-utils.mjs` (npm `postinstall`) adds `select` to docgen's required-body-params allowlist and lists a SELECT method's naive body properties in the Parameters table, so the `evaluate` page documents `state`, `model`, `questions` as required and its SELECT example routes (provider-utils 0.7.10 still lacks it; the first two edits are carried from the anthropic and gemini builds). `sanitize-docs.mjs` keeps `<br />` line breaks in description cells.

## Toolchain rules

- Latest `@stackql/provider-utils` (0.7.10), `@stackql/pgwire-lite` (1.0.2) and `@apidevtools/swagger-parser` (13.1.0) at build time (check npm before starting: `npm view @stackql/provider-utils version`); Docusaurus `^3.10.x`. Node >= 22.19 (Node 20 reached end of life in April 2026; swagger-parser 13 needs 22.19), `type: module`. `js-yaml` stays on 4.x: provider-utils emits with js-yaml 4, and v5 drops the default export, removes the `quotingType` dump option and changes scalar quoting, so that bump is a coordinated change with provider-utils. `package-lock.json` pins what CI installs; a toolchain bump is an explicit commit that regenerates the artifacts and re-checks `bin/patch-provider-utils.mjs` (it prints PATTERN NOT FOUND when upstream moves).
- Linux, macOS or WSL: GNU make + bash, a `stackql` binary (`$STACKQL`, `./stackql`, then PATH; `bin/start-server.sh` downloads one if none is found), Python 3 and yarn. The Makefile is the operator surface (`make help`). Engine facts in NOTES.md were verified against stackql v0.12.732 (any-sdk v0.6.0-alpha01).
- The two provider-utils CLI entry points are npm scripts invoked through `node` (never `.bin` shims); flags go after `--`.

## Repository layout

```
Makefile               # make help / build / test / smoke* / docs / website / all
bin/                   # fetch-spec.sh, split.mjs, init-provider.sh, patch-provider-utils.mjs,
                       # server lifecycle, test-meta-routes.cjs
provider-dev/
  downloaded/          # pinned spec snapshot typesafe-v1.json (committed)
  config/              # spec_pin.json, service_names.json, servers.json, provider_config.json,
                       # service_config.json (retry), endpoint_inventory.csv, all_services.csv
  scripts/             # record_spec_pin, build_inventory, map_operations, pre_normalize, post_process,
                       # graphql_merge (no-op: no GraphQL API), lib/spec_helpers (the provider constants)
  source/              # split + normalized service specs (committed build artifacts)
  openapi/src/typesafe # generated provider (committed)
  docgen/provider-data # headerContent1.txt / headerContent2.txt (landing + getting-started page;
                       # examples close the page under "## Example Queries")
tests/
  offline_validation.mjs
  integration/         # mock_typesafe_server.mjs, run_integration_tests.mjs, probe.mjs, harness.mjs
  smoke_test.py        # pystackql live suite (--live, --read-only)
website/               # Docusaurus microsite (shared stackql/docusaurus-config vendored at build)
.github/workflows/     # build-and-test.yml (pin check, build, drift check, 3 test layers, gated smoke,
                       # weekly spec-drift); web deploys (.disabled until GitHub Pages is configured)
CLAUDE.md  NOTES.md  README.md  SECURITY.md  LICENSE  .env.example
```

No `views/` (no view earns its place over `json_extract` on two resources) and no `provider-dev/source-graphql/` (TypeSafe has no GraphQL API); `make graphql-merge` is a no-op kept for pipeline parity.

## Build pipeline

`make all` = `deps build test docs website`: fetch-spec (pin verify) -> inventory -> split -> mappings -> pre-normalize -> normalize -> generate (+ post-process, GraphQL merge) -> test-offline -> test-integration -> test-meta -> docs -> website. It never needs credentials and never bills. Every step is deterministic and re-runnable; manual decisions are rules in scripts (`RESOURCE_RULES` / `METHOD_RULES` in `map_operations.mjs`, `SKIP_RULES` in `lib/spec_helpers.mjs`, fix classes in `record_spec_pin.mjs`, passes in `pre_normalize.mjs`, validations in `post_process.mjs`), never hand-edits to CSVs or specs. Validate-and-fail-without-writing is the standard for every script. A regeneration reproduces the committed artifacts byte-for-byte (CI checks this).

`provider-dev/config/all_services.csv` is committed as the durable record of every operation -> resource.method mapping; a diff there on a regeneration is a breaking-change review (a method moving resource, a resource renamed), not noise.

## Tests

1. `make test-offline` - `SHOW` / `DESCRIBE` against the local file registry (services, resources, the SELECT-only verb set, the required body fields of `evaluate`, the projected columns).
2. `make test-integration` - the mock API (`tests/integration/mock_typesafe_server.mjs`, real wire shapes, auth enforced, 429 / 529 fixtures, request log) with row-level and wire-level assertions. `npm run probe -- "<sql>"` prints stackql output and the wire calls for ad-hoc binding checks.
3. `make test-meta` - the meta-route walk over a local server. A resource with no columns or a service with no resources fails it - fix the mapping, never the test.
4. `make smoke` / `make smoke-live` / `make smoke-read-only` - live, from `.env` (see `.env.example`), against a dedicated dev account. Budget under one cent per run (`$0.042` per million input tokens); `smoke-read-only` spends nothing.

Never run tests against a production account.

## Docs and publish

`make docs` (generate with `--snake-case-aliases`, then `sanitize-docs`) and `make website`; `website/docs` is committed after every regeneration so pages stamp with their regeneration date. Publishing to the registry is a separate, human-in-the-loop step (push the generated provider dir to `providers/src` in a feature branch of `stackql-provider-registry`, follow the release flow, verify with `make smoke-live`).

## Writing conventions

These apply to every piece of text the build generates, whoever or whatever reads it: README, docs headers and examples, NOTES, this file, code comments, commit messages, console output, inventory and CSV columns, mock fixtures, hand-over notes. Text the vendor owns (operation summaries, schema and parameter descriptions, examples carried from the upstream spec into the snapshot, `provider-dev/source`, the generated provider and `website/docs`) is passed through as the vendor wrote it; the only alteration is the MDX escaping `sanitize-docs` applies so the docs site builds.

- Measured, precise copy, no hyperbole. Comparisons with other tooling are capability statements and runnable examples, never editorializing.
- No em dashes and no `--` as a dash; use `-`. No characters that are not on a QWERTY keyboard: no emoji, no typographic quotes, `->` for arrows. No stacked headings.
- Sample queries are realistic and runnable against the generated surface: snake_case names, `json_extract` for nested fields, parser keywords such as `"database"` quoted.

## Non-negotiables

1. Latest `@stackql/provider-utils`, always
2. The skill is the procedure; sibling-build NOTES.md findings (the repos in the skill's reference-repos.md) are reused, not re-derived - deviate only with a documented reason in NOTES.md
3. Deterministic scripts, never hand-edits to derived artifacts
4. Every regeneration is followed by `make test` before commit
5. Test harnesses pace under the rate limit - a 429 in CI is a harness bug
6. No smoke statement spends more than an evaluation's input tokens; the suite reports what it spent
