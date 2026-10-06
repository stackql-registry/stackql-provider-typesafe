# StackQL provider for TypeSafe AI

A [StackQL](https://github.com/stackql/stackql) provider for the TypeSafe AI API (`https://api.typesafe.ai`), the hosted service behind Jev, TypeSafe's flagship System One model. Two services, two resources, both reads:

| Service | Resource | Method | Verb | Operation |
|---|---|---|---|---|
| `models` | `models` | `list` | `SELECT` | `GET /v1/models` - the models and aliases the API key can use (`objectKey: $.models`) |
| `systemone` | `evaluations` | `evaluate` | `SELECT` | `POST /v1/systemone` - evaluate a `state` against named Noul / Choice / Score questions |

The evaluation endpoint is bound as `SELECT` (the anthropic `messages.create` precedent): the required body fields `state`, `model` and `questions` are the WHERE keys, and the row carries `model` (the versioned id that answered), `answers` (a JSON map keyed by your question names) and `usage` (token counts). TypeSafe publishes no admin or usage API; keys are managed in the console and usage is reported per request (see [NOTES.md](NOTES.md) finding 2).

The provider's primary use is the agent routine over the [StackQL MCP server](https://stackql.io/docs/command-line-usage/mcp): rows from another provider become the `state`, Jev returns a typed decision, and a StackQL mutation or lifecycle operation runs only when the decision clears the routine's threshold. The getting-started page carries that loop for tagging hygiene (aws), rightsizing (aws), incident triage (k8s), access review (okta), public ingress review (aws) and audit findings (okta and github); every statement on it is validated by `bin/validate-docs-examples.sh` (NOTES.md findings 12 and 13).

```sql
SELECT model,
       json_extract(answers, '$.is_urgent.noul') AS p_urgent,
       json_extract(usage, '$.input_tokens') AS input_tokens
FROM typesafe.systemone.evaluations
WHERE state = 'Hi, I have been trying to connect my Stripe account for 3 days and the integration keeps failing. Please help ASAP.'
  AND model = 'jev-latest'
  AND questions = '{"is_urgent": {"type": "noul", "instructions": "Does this message express urgency?"}}';
```

The procedure that built this repository is the bundled Claude Code skill, [`.claude/skills/stackql-provider-development`](.claude/skills/stackql-provider-development/SKILL.md); the settled decisions are in [CLAUDE.md](CLAUDE.md) and the evidence in [NOTES.md](NOTES.md).

## What is StackQL

[StackQL](https://github.com/stackql/stackql) is an open-source SQL interface for cloud and SaaS APIs. A provider is a versioned set of OpenAPI documents plus `x-stackQL-resources` extensions that the [any-sdk](https://github.com/stackql/any-sdk) engine turns into SQL tables: `SELECT` for reads, `INSERT` / `UPDATE` / `REPLACE` / `DELETE` for lifecycle, `EXEC` for actions, with `json_extract` over nested fields and joins across providers.

## Prerequisites

- Node.js >= 22.19
- A `stackql` binary (`$STACKQL`, `./stackql`, or on `PATH`; `bin/start-server.sh` downloads one if none is found); the engine facts in NOTES.md were verified against v0.12.732
- GNU make and bash (Linux, macOS or WSL); Python 3 for the smoke suite; yarn for the website
- For live smoke tests: a TypeSafe API key for a dedicated dev account (never a production account) in `.env` (see `.env.example`)

## Makefile

Every step is a `make` target (`make help` lists them). The composites:

```bash
make all      # deps, full pipeline (fetch/pin verify, inventory, split, mappings, pre-normalize,
              # normalize, generate, post-process, GraphQL merge), offline + integration + meta-route
              # tests, docs generation, website build - no credentials needed
make build    # the spec -> provider pipeline only
make test     # the three credential-free test layers
make smoke    # live smoke suite against the dev account (sources .env if present)
```

`make all` never touches a real account. The live suites are `smoke` (the catalog plus nine billed evaluations; measured at about $0.0001 per run), `smoke-live` (the published provider, post-publish verification) and `smoke-read-only` (the catalog only, spends nothing). The API has no mutable resources, so there is no gated lifecycle and nothing to sweep.

## 0. Download and pin the spec

```bash
make fetch-spec      # verify against the recorded pin (fails on drift)
make refresh-spec    # accept an upstream change (rewrites the pin - review the diff)
```

`bin/fetch-spec.sh` downloads `https://api.typesafe.ai/openapi.json` to a temp dir; `provider-dev/scripts/record_spec_pin.mjs` applies the deterministic fix classes (counted in the pin), validates with `@apidevtools/swagger-parser`, redacts credential-shaped example values, verifies the upstream sha256 against `provider-dev/config/spec_pin.json` and only then writes the snapshot into `provider-dev/downloaded/typesafe-v1.json` (committed, so every refresh is a reviewable diff). Before accepting a refresh: `node .claude/skills/stackql-provider-development/scripts/spec_diff.mjs <pinned> <fetched>` and record the summary in `NOTES.md`.

Pinned snapshot: title TypeSafe, OpenAPI 3.1.0, stated version 0.2.0, 2 paths, 2 operations, 14158 bytes, fetched 2026-10-02, upstream sha256 `a191f8a7df6b...`. Fix classes applied: `type_null_to_nullable` 7, `const_to_enum` 6; no redactions.

## 1. Endpoint inventory and service split

```bash
make inventory
```

Writes `provider-dev/config/endpoint_inventory.csv`: one row per operation with scope, path params, pagination-looking query params, request body presence / media types / bare-array flag, the update-semantics presumption, vendor labels, response shape and envelope candidates, the proposed service / resource / method / verb / objectKey and a skip reason code.

The service split is the ordered path rules in `provider-dev/config/service_names.json` (first match wins; an unmatched path fails the build). Then:

```bash
make split
```

writes `provider-dev/source/<service>.yaml` (committed build artifacts) with the fixed server `https://api.typesafe.ai` (no scoping prefix).

Inventory: 2 operations, 2 mapped, 0 skipped, 0 labelled, no pagination parameters, no path or query parameters. Services:

| Service | Resources | Operations |
|---|---|---|
| `models` | `models` | `GET /v1/models` |
| `systemone` | `evaluations` | `POST /v1/systemone` |

## 2. Mappings

```bash
make mappings-report   # print every derived mapping without writing
make mappings          # regenerate all_services.csv from scratch and apply the rules
```

`provider-dev/scripts/map_operations.mjs` fills `stackql_resource_name`, `stackql_method_name`, `stackql_verb` and `stackql_object_key` from the mechanical derivation plus `RESOURCE_RULES` / `METHOD_RULES`, and validates: every row mapped or skipped with a reason, every spec operation present, `(service, resource, method)` unique, unique required-parameter signatures per `(resource, sqlVerb)`. Fails without writing on any violation. Two rules carry the one decision: `POST /v1/systemone` is `evaluations.evaluate` bound as `select` rather than the mechanical `systemones.create` as `insert`.

`provider-dev/config/all_services.csv` is the committed contract of every operation -> resource.method mapping; a diff on regeneration is a breaking-change review. Result: 2 rows, both `select`.

## 3. Normalize

```bash
make pre-normalize   # provider-specific passes in provider-dev/scripts/pre_normalize.mjs
make normalize       # provider-utils: allOf flatten, oneOf/anyOf lowering, bare-array wrap
```

Pass 2 of `pre_normalize.mjs` lowers the vendor's nine `string | object | array (| null)` content unions (`state`, `instructions`, criteria descriptions, the score legend) to `string` so normalize does not leave `additionalProperties: true` and `items: {}` beside a string property. On the SQL surface those values are always strings; a JSON-looking string is sent as the JSON it encodes.

## 4. Generate

```bash
make generate        # rm output, generate (servers, auth, per-service retry policy, naive bodies), post-process, GraphQL merge
```

Output: `provider-dev/openapi/src/typesafe/v00.00.00000/provider.yaml` + `services/models.yaml` + `services/systemone.yaml` (committed). `--provider-config` carries the bearer auth (`TYPESAFE_API_KEY`); `--service-config` carries the retry policy for the vendor's 429 / 529 contract as each service's document-level `x-stackQL-config` (it must sit at service level: the engine does not consult a provider-level retry block, NOTES.md finding 7). `provider-dev/scripts/post_process.mjs` validates the result; this API needs none of the usual post-generation rules (no objectKey on a POST read, no pagination, no pushdown, no transforms, no aliases). `make graphql-merge` is a no-op (TypeSafe has no GraphQL API).

## 5. Test

```bash
make test-offline        # SHOW / DESCRIBE against the local file registry (16 checks)
make test-integration    # mock API, row-level and wire-level assertions (28 checks)
make test-meta           # meta-route walk over a local stackql server (2 services, 2 resources, 2 methods)
make smoke               # live (needs .env)
```

`npm run probe -- "SELECT ..."` runs ad-hoc SQL against the mock and prints the wire calls.

The integration suite proves the flagship binding on the wire: `questions` arrives as a JSON object, a plain `state` as a string and a JSON `state` as the object or array it encodes; `json_extract` reads `answers` and `usage`; mixed question types and a versioned model id pass through; a 429 and a 529 on the first attempt are retried; an unknown model and a malformed question surface the vendor's 400 `api_usage_error`; a statement missing a required body field does not route; a wrong key is a 401. The mock's fixtures and error bodies are the ones the live API returned on 2026-10-05.

The smoke suite (`tests/smoke_test.py`, pystackql) mirrors the vendor's quick-start and API-reference examples because TypeSafe has no Terraform provider to mirror: the models catalog, then nine evaluations (a Noul question, a Choice, a Score, the three mixed, a structured JSON state, the alias resolved to a versioned id and that id pinned, a `json_extract` read). It sums the `usage` column and prints the token total and its cost at `$0.042` per million input tokens (output tokens are free): 2485 input tokens, about `$0.0001`, on the first live run (2026-10-05). Statements are paced at one per second under the documented 80 requests per second.

`bin/validate-docs-examples.sh` checks the getting-started page before a docs publish: it extracts every `sql` block, runs the typesafe statements live (when `TYPESAFE_API_KEY` is set) and routes the aws / k8s / okta / github / anthropic context and action statements through a temporary registry built from a `stackql-provider-registry` clone (`REGISTRY_SRC`) with dummy credentials, so a statement that no longer routes fails the check without touching a real account. 25 statements passed on 2026-10-05 (NOTES.md finding 12).

## 6. Docs

```bash
make docs        # generate website/docs (snake_case surface, source project link) and sanitize for MDX
make website     # yarn install && yarn build (vendors the shared stackql/docusaurus-config)
make website-start
```

`provider-dev/docgen/provider-data/headerContent1.txt` is the landing-page front matter and pitch; `headerContent2.txt` is the getting-started page (installation, scope, authentication, evaluations as SELECT, models and aliases, rate limit and retries, example queries). `bin/patch-provider-utils.mjs` (npm `postinstall`) patches provider-utils' docgen so the `evaluate` method documents its three required body fields (in the Methods and Parameters tables) and its SELECT example routes. `website/provider.js` carries the site identity; `website/static/CNAME` the hostname `typesafe-provider.stackql.io`. Commit `website/docs` after every regeneration. The Makefile variable `SOURCE_PROJECT` (default: this repository's GitHub URL) is passed to docgen as `--source-project` and becomes the `source project` link in the landing page's Provider Summary; override it on the `make` command line for a fork.

To publish the site: rename `.github/workflows/prod-web-deploy.yml.disabled` and `test-web-deploy.yml.disabled`, enable GitHub Pages (source: GitHub Actions) and add the DNS record:

| Source domain | Record type | Target |
|---|---|---|
| `typesafe-provider.stackql.io` | CNAME | `stackql.github.io.` |

## 7. Publish

Push the generated `provider-dev/openapi/src/typesafe` directory to `providers/src` in a feature branch of [stackql-provider-registry](https://github.com/stackql/stackql-provider-registry) and follow the [registry release flow](https://github.com/stackql/stackql-provider-registry/blob/dev/docs/build-and-deployment.md). Verify from the dev registry, then `make smoke-live`:

```bash
export DEV_REG='{ "url": "https://registry-dev.stackql.app/providers" }'
stackql --registry="${DEV_REG}" shell
```

```sql
REGISTRY PULL typesafe;
```

## 8. CI

`.github/workflows/build-and-test.yml`: on push / PR - `npm ci` (which runs the docgen patch), `stackql/setup-stackql`, pin verification (warns on drift), the build steps, a hard failure on uncommitted generation drift, the three credential-free test layers, docs generation; a secret-gated live smoke job (`TYPESAFE_API_KEY`; skipped with a notice otherwise); a weekly `spec-drift` job that fetches, compares with the pin and opens a labelled issue. The web deploy workflows build the site from `main` once enabled.

## Authentication reference

`provider-dev/config/provider_config.json` becomes `config:` in `provider.yaml`:

```json
{"auth": {"type": "bearer", "credentialsenvvar": "TYPESAFE_API_KEY"}}
```

TypeSafe has no Terraform provider; `TYPESAFE_API_KEY` is the variable the vendor's Python and JavaScript SDKs and every docs example read. Create a key at `https://console.typesafe.ai/keys` (early access is behind a waitlist at `https://typesafe.ai`). A user can override at runtime with `stackql --auth='{"typesafe": {"type": "bearer", "credentialsenvvar": "MY_OTHER_VAR"}}'`.

## Contributing

Contributions are welcome - rules in scripts, `make build && make test`, then a pull request.

## Security

Report vulnerabilities privately through the repository's advisory form, never in a public issue - see [SECURITY.md](SECURITY.md).

## License

MIT - see [LICENSE](LICENSE).
