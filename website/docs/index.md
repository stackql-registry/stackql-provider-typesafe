---
title: typesafe
hide_title: false
hide_table_of_contents: false
keywords:
  - typesafe
  - jev
  - system one
  - stackql
  - mcp
  - ai agents
  - infrastructure-as-code
  - configuration-as-data
  - cloud inventory
description: Run Jev, TypeSafe AI's System One decision model, as a SELECT - typed decisions over any StackQL provider's rows for agent routines, with the models catalog alongside
custom_edit_url: null
image: /img/stackql-typesafe-provider-featured-image.png
id: 'provider-intro'
---

import CopyableCode from '@site/src/components/CopyableCode/CopyableCode';

The `typesafe` provider maps the TypeSafe AI API (`https://api.typesafe.ai`) to SQL: the System One evaluation endpoint behind Jev, TypeSafe's flagship model (`typesafe.systemone.evaluations`), and the models catalog an API key can use (`typesafe.models.models`). A System One request evaluates a `state` (text or JSON) against named, typed questions - Noul (yes/no probability), Choice (one option from a set, with a probability per option and a confidence) and Score (an ordered rubric, with an expected score, a legend and probabilities) - and returns typed answers rather than text. In the provider that request is a `SELECT`: the WHERE clause carries the state, the model and the questions, and the row carries the model that answered, the answers map and the token usage, ready for `json_extract`. In an agent routine over the StackQL MCP server, rows from any other provider become the state, Jev makes the judgment call, and a StackQL mutation runs only when the answer clears the routine's threshold.


:::info[Provider Summary] 

total services: __2__  
total resources: __2__  

:::

See also:
[[` SHOW `]](https://stackql.io/docs/language-spec/show) [[` DESCRIBE `]](https://stackql.io/docs/language-spec/describe)  [[` REGISTRY `]](https://stackql.io/docs/language-spec/registry)
* * *

## Installation

To pull the latest version of the `typesafe` provider, run the following command:

```bash
REGISTRY PULL typesafe;
```
> To view previous provider versions or to pull a specific provider version, see [here](https://stackql.io/docs/language-spec/registry).

## Scope

The provider covers the whole of the TypeSafe HTTP API as published at `https://api.typesafe.ai/openapi.json` (version 0.2.0): `GET /v1/models`, the models and aliases the authenticated account can send in the `model` field, and `POST /v1/systemone`, the evaluation endpoint that every TypeSafe model, including Jev, is served through. Both are read surfaces. The API has no mutable resources, so the provider has no `INSERT`, `UPDATE` or `DELETE` methods. TypeSafe publishes no administrative or usage API: API keys are created and revoked in the TypeSafe console (`https://console.typesafe.ai/keys`), and token usage is reported per request in the `usage` column of each evaluation rather than through a reporting endpoint. If a control plane is published later it will be added here or as a sibling provider, following the `openai` / `openai_admin` pattern.

The provider is built for agent routines that run over the [StackQL MCP server](https://stackql.io/docs/command-line-usage/mcp): rows from any other StackQL provider become the `state`, Jev returns a typed decision with a probability or a confidence, and the routine runs a StackQL mutation or lifecycle operation only when the decision clears its threshold. The examples at the end of this page follow that shape for platform engineering, FinOps and GreenOps, SRE, access review, CSPM and audit.

## Authentication

Create an API key in the TypeSafe console and export it as `TYPESAFE_API_KEY`, the variable the vendor's Python and JavaScript SDKs read (TypeSafe has no Terraform provider). The provider sends it as `Authorization: Bearer`. One key class serves both resources.

```bash
export TYPESAFE_API_KEY='...'
```

or using PowerShell:

```powershell
$env:TYPESAFE_API_KEY = '...'
```

<details>

<summary>Using different environment variables</summary>

To use different environment variables (instead of the defaults), use the `--auth` flag of the `stackql` program. For example:

```bash
AUTH='{ "typesafe": { "type": "bearer", "credentialsenvvar": "MY_OTHER_VAR" }}'
stackql shell --auth="${AUTH}"
```

or using PowerShell:

```powershell
$Auth = "{ 'typesafe': { 'type': 'bearer', 'credentialsenvvar': 'MY_OTHER_VAR' }}"
stackql.exe shell --auth=$Auth
```
</details>

## Quick start

With the key exported, open a shell, pull the provider and ask Jev one question:

```bash
export TYPESAFE_API_KEY='...'
stackql shell
```

```sql
REGISTRY PULL typesafe;

SHOW METHODS IN typesafe.systemone.evaluations;

SELECT model, answers, usage
FROM typesafe.systemone.evaluations
WHERE state = 'The deploy failed twice tonight and the on-call engineer has not acknowledged the page.'
  AND model = 'jev-latest'
  AND questions = '{"needs_escalation": {"type": "noul", "instructions": "Should this be escalated to the incident commander now?"}}';
```

The same statement runs from a script or a CI job with `stackql exec`, reading the SQL from a file and returning JSON:

```bash
stackql exec -i decision.sql --output json
```

Every statement here is a `SELECT`, so it is allowed in every StackQL MCP server mode, including `read_only`; only the mutations an agent runs afterwards are gated.

## Evaluations as SELECT

`typesafe.systemone.evaluations` binds `POST /v1/systemone` to `SELECT`: the response of an evaluation is the result set, nothing is created, and nothing can be listed or deleted afterwards. The three required body fields are the WHERE keys, and `questions` (a JSON object keyed by the question names you choose) is passed as a string that the provider sends as the JSON it encodes. `state` is sent as the plain string you give it, or as a JSON object or array when the string is one. The row has three columns: `model`, the versioned model id that answered (an alias such as `jev-latest` resolves to it), `answers`, the answers map keyed by your question names, and `usage`, the input and output token counts. Address the nested values with `json_extract`.

| Question type | What you send in `questions` | What comes back under the question name |
|---|---|---|
| `noul` | `instructions`, optional `criteria` with `true` and `false` descriptions | `noul`: the probability of yes, 0 to 1 |
| `choice` | `instructions`, `criteria`: a map of option name to description (up to 255) | `choice`, `probabilities` per option, `confidence` |
| `score` | `instructions`, `criteria`: an ordered array of level descriptions (2 to 10) | `score` (probability-weighted), `legend`, `probabilities`, `confidence` |

The three types can be mixed in one request; each question is evaluated independently against the same state. Pricing is per input token (output tokens are free), so every `SELECT` from `evaluations` is billed; the `usage` column reports what it cost (the one-question example above costs about 300 input tokens). Errors come back in the statement's error text with the vendor's body: an unknown model name or a malformed question is a `400` with `error_type` `api_usage_error`, a wrong key a `401` with `authentication_error`. A statement that omits one of the three required fields does not route at all (`SHOW METHODS` lists them).

## Decisions in an agent routine

An agent connected to the StackQL MCP server already has every provider's control plane as SQL. Jev adds the judgment call that a `WHERE` clause cannot make: is this instance production or scratch, does this rule's description justify public ingress, does this account still need an admin role, is a restart the right response to this event. The pattern is three tool calls:

1. **Context** - `run_select_query` against the provider that owns the facts (`aws`, `k8s`, `okta`, `github`, ...). The agent keeps the columns the decision needs.
2. **Decision** - `run_select_query` against `typesafe.systemone.evaluations`, with the record (or a small batch of records) serialised as the JSON `state` and the routine's questions as `questions`. Jev answers every question against the same state in one call, in about a hundred milliseconds, for a fraction of a cent.
3. **Action** - `run_mutation_query` or `run_lifecycle_operation` against the owning provider, only when the answer clears the threshold the routine sets (a Noul above 0.9, a Choice with `confidence` above 0.9, a Score above a level). In the MCP server's default `safe` mode the mutation still goes through the client's approval prompt; in `read_only` mode the routine stops at the recommendation.

Three habits make the routine auditable. Keep each question atomic and put the policy in `criteria` rather than in prose, so a change of policy is a diff in the question text. Record the `model` column with the action, so every automated change names the model version that decided it. Pin the versioned id once thresholds are tuned, and move to the next release deliberately. The examples below are written in that shape: the context query, the decision with a representative record as the state, and the action.

## Models and aliases

`typesafe.models.models` lists the names the account can use in the `model` field with a description and a release date (an ISO 8601 timestamp). The list carries the aliases (`jev-latest`, the most recent stable release, and `jev-preview`, which moves ahead of it when a preview build is available); versioned ids such as `jev-1.13.0` are accepted by the `model` field whether or not they are listed. An alias moves when a new release ships, so the `model` column of an evaluation records which version produced each answer. Pin the versioned id when you have tuned confidence thresholds against it.

## Rate limit and retries

Jev 1.13 is limited to 80 requests per second and 100K tokens per second, adjusted dynamically while the service is in early access; a request over either limit returns `429 Too Many Requests`, and an overloaded service returns `529`. The provider carries the retry policy the vendor SDKs apply by default: up to three attempts with exponential backoff (500 ms initial delay, doubling, capped at 10 s) on `408`, `429`, `502`, `503`, `504` and `529`, for the evaluation `POST` as well as the catalog `GET` (an evaluation has no side effects, so a retry is safe). A query that still fails after the third attempt surfaces the vendor's error body.

## Example Queries

Try the following queries using `stackql shell`, or run them from a script or CI pipeline with `stackql exec`.

### Models catalog

The names an API key can send as `model`, with their release dates:

```sql
SELECT name, description, release_date
FROM typesafe.models.models
ORDER BY name;
```

### A decision as a query

One Noul question about a support message, with the probability of yes and the cost read out of the row:

```sql
SELECT model,
       json_extract(answers, '$.is_urgent.noul') AS p_urgent,
       json_extract(usage, '$.input_tokens') AS input_tokens
FROM typesafe.systemone.evaluations
WHERE state = 'Hi, I have been trying to connect my Stripe account for 3 days and the integration keeps failing. I am losing sales. Please help ASAP.'
  AND model = 'jev-latest'
  AND questions = '{"is_urgent": {"type": "noul", "instructions": "Does this message express urgency?"}}';
```

### Tagging hygiene

Platform engineering: classify an instance from its name and existing tags, then write the missing tags back - the context read, the decision on one instance's record, and the tag write the agent runs only when the confidence is at least 0.9:

```sql
-- 1. context (run_select_query)
SELECT instance_id, instance_type, launch_time, tags
FROM aws.ec2.instances
WHERE region = 'us-east-1';

-- 2. decision (run_select_query): one record from the result as the state
SELECT json_extract(answers, '$.environment.choice') AS environment,
       json_extract(answers, '$.environment.confidence') AS confidence,
       json_extract(answers, '$.owner_team.choice') AS owner_team,
       model
FROM typesafe.systemone.evaluations
WHERE state = '{"instance_id": "i-0a1b2c3d4e5f67890", "instance_type": "m5.2xlarge", "launch_time": "2026-03-02T09:14:00Z", "tags": [{"Key": "Name", "Value": "jenkins-agent-prod-2"}, {"Key": "created-by", "Value": "ci-platform@example.com"}]}'
  AND model = 'jev-latest'
  AND questions = '{
    "environment": {"type": "choice", "instructions": "Which environment does this instance belong to? Use the Name tag and anything else in the record.",
                    "criteria": {"production": "Serves live traffic or production pipelines", "staging": "Pre-production, UAT or release testing", "development": "Developer, sandbox or test use", "unknown": "The record does not say"}},
    "owner_team": {"type": "choice", "instructions": "Which team most likely owns this instance?",
                   "criteria": {"platform": "CI, build and shared infrastructure", "data": "Analytics and data pipelines", "product": "Customer-facing applications", "unknown": "Cannot tell from the record"}}
  }';

-- 3. action (run_mutation_query), when confidence >= 0.9
INSERT INTO aws.ec2.tags (ResourceId, Tag, region)
SELECT 'i-0a1b2c3d4e5f67890',
       '[{"Key": "environment", "Value": "production"}, {"Key": "owner", "Value": "platform"}]',
       'us-east-1';
```

### Rightsizing and off-hours scheduling

FinOps and GreenOps: given an instance record and the utilisation the agent has gathered, decide between keeping it, stopping it outside business hours, downsizing it or referring it to the owner, and whether the workload could run at another time or in another region at all; the stop runs only for a `stop_outside_hours` decision with confidence at least 0.9:

```sql
-- 1. context (run_select_query)
SELECT instance_id, instance_type, state, launch_time, tags
FROM aws.ec2.instances
WHERE region = 'us-east-1';

-- 2. decision (run_select_query)
SELECT json_extract(answers, '$.action.choice') AS action,
       json_extract(answers, '$.action.confidence') AS confidence,
       json_extract(answers, '$.schedulable.noul') AS p_schedulable,
       model
FROM typesafe.systemone.evaluations
WHERE state = '{"instance_id": "i-0b9c8d7e6f5a43210", "instance_type": "r5.4xlarge", "state": "running", "launch_time": "2025-11-18T03:00:00Z", "tags": [{"Key": "Name", "Value": "nightly-report-builder"}, {"Key": "owner", "Value": "data"}], "avg_cpu_14d_pct": 3.1, "max_cpu_14d_pct": 61.0, "busy_hours_utc": "01:00-03:00"}'
  AND model = 'jev-latest'
  AND questions = '{
    "action": {"type": "choice", "instructions": "What should a cost review do with this instance?",
               "criteria": {"keep": "Utilisation and purpose justify running it as is", "stop_outside_hours": "It only works in a known window and can be stopped the rest of the time", "downsize": "It is oversized for its sustained load", "review_with_owner": "The record is not enough to decide"}},
    "schedulable": {"type": "noul", "instructions": "Could this workload run at a different time of day or in a different region without affecting users?",
                    "criteria": {"true": "A batch or scheduled job with no interactive users", "false": "Serves users or other systems on demand"}}
  }';

-- 3. action (run_lifecycle_operation), when action = 'stop_outside_hours' and confidence >= 0.9
EXEC aws.ec2.instances.stop_instances
  @InstanceId = 'i-0b9c8d7e6f5a43210',
  @region = 'us-east-1';
```

### Incident triage

SRE: read the cluster's warning events, let Jev name the likely cause, rate the severity and say whether rescheduling the pod is the right first response, then delete the pod only when that answer is at least 0.9 and the severity is below the paging level:

```sql
-- 1. context (run_select_query)
SELECT json_extract(involved_object, '$.namespace') AS namespace,
       json_extract(involved_object, '$.kind') AS kind,
       json_extract(involved_object, '$.name') AS name,
       reason, message, count, last_timestamp
FROM k8s.core.events_all_namespaces
WHERE type = 'Warning';

-- 2. decision (run_select_query)
SELECT json_extract(answers, '$.cause.choice') AS cause,
       json_extract(answers, '$.severity.score') AS severity,
       json_extract(answers, '$.reschedule_helps.noul') AS p_reschedule_helps,
       model
FROM typesafe.systemone.evaluations
WHERE state = '{"namespace": "payments", "kind": "Pod", "name": "checkout-api-7c9d6f8b5-xk2lp", "reason": "BackOff", "message": "Back-off restarting failed container checkout-api in pod checkout-api-7c9d6f8b5-xk2lp", "count": 14, "last_timestamp": "2026-10-05T02:41:07Z", "recent_log_tail": "FATAL: connection pool exhausted after 30s waiting for a connection to payments-db"}'
  AND model = 'jev-latest'
  AND questions = '{
    "cause": {"type": "choice", "instructions": "What is the most likely cause of this event?",
              "criteria": {"crash_loop": "The container exits repeatedly on its own error", "out_of_memory": "Killed for exceeding its memory limit", "image_pull": "The image cannot be pulled", "scheduling": "No node can place the pod", "dependency": "A dependency the container needs is unavailable or saturated", "other": "None of the above"}},
    "severity": {"type": "score", "instructions": "How severe is this for users?",
                 "criteria": ["Informational, no user impact", "Degraded, users may notice", "Outage of a user-facing capability", "Outage with data or payment risk"]},
    "reschedule_helps": {"type": "noul", "instructions": "Would deleting the pod so the controller reschedules it most likely resolve this?",
                         "criteria": {"true": "A transient or node-local fault that a fresh pod clears", "false": "A code, configuration or dependency fault a new pod would hit again"}}
  }';

-- 3. action (run_mutation_query), when p_reschedule_helps >= 0.9 and severity < 2
DELETE FROM k8s.core.pods
WHERE namespace = 'payments' AND name = 'checkout-api-7c9d6f8b5-xk2lp';
```

### Access review

Entitlements: the facts a review can compute stay in SQL (days since the last sign-in, from `lastLogin`); Jev answers what the record cannot compute - whether the roles an account holds fit its title and department, and what kind of account it is - and the suspension runs only for a person-held account whose administrative role is judged not to fit (probability at most 0.1) and that has not signed in for 90 days:

```sql
-- 1. context (run_select_query)
SELECT id, status, lastLogin, created,
       json_extract(profile, '$.login') AS login,
       json_extract(profile, '$.title') AS title,
       json_extract(profile, '$.department') AS department
FROM okta.users.users
WHERE subdomain = 'my-org';

-- 2. decision (run_select_query): the record plus the agent's computed facts and the role assignments it read
SELECT json_extract(answers, '$.admin_role_fits.noul') AS p_admin_role_fits,
       json_extract(answers, '$.account_kind.choice') AS account_kind,
       json_extract(answers, '$.account_kind.confidence') AS confidence,
       model
FROM typesafe.systemone.evaluations
WHERE state = '{"login": "t.nguyen@example.com", "title": "Contract QA Analyst", "department": "Engineering", "status": "ACTIVE", "created": "2025-02-10T00:00:00Z", "lastLogin": "2026-04-28T07:12:00Z", "days_since_last_login": 160, "roles": ["SUPER_ADMIN"]}'
  AND model = 'jev-latest'
  AND questions = '{
    "admin_role_fits": {"type": "noul", "instructions": "Do the title and department justify the roles this account holds?",
                        "criteria": {"true": "An identity, security or platform administration role that needs tenant-wide rights", "false": "A role that would normally hold scoped or read-only rights"}},
    "account_kind": {"type": "choice", "instructions": "What kind of account is this?",
                     "criteria": {"employee": "A person on staff", "contractor": "A person engaged for a fixed term", "service_account": "An integration or automation identity", "shared": "A mailbox or shared login"}}
  }';

-- 3. action (run_lifecycle_operation), when p_admin_role_fits <= 0.1, account_kind is a person and days_since_last_login > 90
EXEC okta.users.users.suspend_user
  @id = '00u1abcd2efgh3ijk4l5',
  @subdomain = 'my-org';
```

### Public ingress review

CSPM: list the security group rules open to the internet, let Jev judge whether each rule's description and port make the exposure a deliberate public endpoint or an exposed management or database port, then revoke a rule only when it is judged unjustified with probability at least 0.9:

```sql
-- 1. context (run_select_query)
SELECT security_group_rule_id, group_id, ip_protocol, from_port, to_port, cidr_ipv_4, is_egress, description
FROM aws.ec2.security_group_rules
WHERE region = 'us-east-1'
  AND cidr_ipv_4 = '0.0.0.0/0';

-- 2. decision (run_select_query)
SELECT json_extract(answers, '$.justified.noul') AS p_justified,
       json_extract(answers, '$.exposure.choice') AS exposure,
       json_extract(answers, '$.exposure.confidence') AS confidence,
       model
FROM typesafe.systemone.evaluations
WHERE state = '{"security_group_rule_id": "sgr-0f1e2d3c4b5a69788", "group_id": "sg-0123456789abcdef0", "group_name": "analytics-db", "ip_protocol": "tcp", "from_port": 5432, "to_port": 5432, "cidr_ipv_4": "0.0.0.0/0", "is_egress": false, "description": "temp access for vendor demo"}'
  AND model = 'jev-latest'
  AND questions = '{
    "justified": {"type": "noul", "instructions": "Do the description, group name and port justify ingress from the whole internet?",
                  "criteria": {"true": "A deliberate public endpoint such as a load balancer or web tier on 80 or 443", "false": "A management, database or internal service port, or a temporary exception"}},
    "exposure": {"type": "choice", "instructions": "What kind of exposure is this?",
                 "criteria": {"public_endpoint": "Intended internet-facing service", "management_port": "SSH, RDP, WinRM or similar", "database_port": "A database or cache listener", "unknown": "Cannot tell from the record"}}
  }';

-- 3. action (run_lifecycle_operation), when p_justified <= 0.1
EXEC aws.ec2.security_groups.revoke_security_group_ingress
  @GroupId = 'sg-0123456789abcdef0',
  @SecurityGroupRuleId = 'sgr-0f1e2d3c4b5a69788',
  @region = 'us-east-1';
```

### Audit findings

Audit and compliance: read the privilege grants from the identity provider's system log, let Jev check each against the change policy written into the question, and open a tracked finding for the ones that fall outside it:

```sql
-- 1. context (run_select_query)
SELECT published, eventType, displayMessage, outcome, actor, target
FROM okta.logs.system_log_events
WHERE subdomain = 'my-org'
  AND since = '2026-10-04T00:00:00Z'
  AND filter = 'eventType eq "user.account.privilege.grant"';

-- 2. decision (run_select_query)
SELECT json_extract(answers, '$.in_policy.noul') AS p_in_policy,
       json_extract(answers, '$.risk.score') AS risk,
       model
FROM typesafe.systemone.evaluations
WHERE state = '{"published": "2026-10-04T22:47:13Z", "eventType": "user.account.privilege.grant", "displayMessage": "Grant user privilege", "outcome": "SUCCESS", "actor": {"alternateId": "j.doe@example.com", "type": "User"}, "target": [{"alternateId": "svc-reporting@example.com", "type": "User"}, {"displayName": "Super Administrator", "type": "ROLE"}], "note": "no change ticket referenced"}'
  AND model = 'jev-latest'
  AND questions = '{
    "in_policy": {"type": "noul", "instructions": "Does this privilege grant comply with the change policy?",
                  "criteria": {"true": "Granted by an identity administrator, between 09:00 and 17:00 UTC on a weekday, with a change ticket referenced", "false": "Outside the change window, by a non-administrator, to a service account, or without a ticket"}},
    "risk": {"type": "score", "instructions": "How much risk does this grant carry?",
             "criteria": ["Routine, scoped role", "Elevated role to a person", "Tenant-wide administrative role, or any role to a service account"]}
  }';

-- 3. action (run_mutation_query), when p_in_policy <= 0.2
INSERT INTO github.issues.issues (owner, repo, title, body, labels)
SELECT 'my-org',
       'security-audit',
       'Privilege grant outside change policy: svc-reporting@example.com granted Super Administrator',
       'Granted 2026-10-04T22:47:13Z by j.doe@example.com with no change ticket referenced. Flagged by jev-1.13.0 (in_policy 0.02, risk 2.0). Review and revoke or document.',
       '["compliance", "iam"]';
```

### Pinning a model version

Run a question against the versioned id an alias resolved to, so answers do not move when the alias does:

```sql
SELECT model, json_extract(answers, '$.is_spam.noul') AS p_spam
FROM typesafe.systemone.evaluations
WHERE state = 'Congratulations! You have been selected for an exclusive offer. Click here to claim.'
  AND model = 'jev-1.13.0'
  AND questions = '{"is_spam": {"type": "noul", "instructions": "Is this message spam?", "criteria": {"true": "Unsolicited advertising", "false": "A legitimate conversation"}}}';
```

### Cross-provider

The models available to the account alongside another model provider's catalog in one result set:

```sql
SELECT 'typesafe' AS platform, name, release_date AS released
FROM typesafe.models.models
UNION ALL
SELECT 'anthropic', id, created_at
FROM anthropic.models.models;
```


## Services
<div class="row">
<div class="providerDocColumn">
<a href="/services/models/">models</a><br />
</div>
<div class="providerDocColumn">
<a href="/services/systemone/">systemone</a><br />
</div>
</div>
