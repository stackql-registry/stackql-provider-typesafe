#!/usr/bin/env python3
"""pystackql smoke test for the typesafe stackql provider.

Exercises the whole surface against a real TypeSafe account: the models
catalog (the control plane - a free read) and the System One evaluation
endpoint (the inference plane - billed per input token), the way the docs
examples use them: a yes/no (noul) question, a choice, a score, the three
mixed in one request, a structured JSON state, an alias resolved to a
versioned model id and that id pinned on a second call. There are no
mutable resources in the API, so there is nothing to create, toggle or
sweep, and no gated lifecycle.

Budget: Jev is billed at $0.042 per million input tokens (output tokens are
free, docs.typesafe.ai/models, 2026-10-02). The default run makes nine
evaluations of a few hundred tokens each (measured 2026-10-05: 2485 input
tokens, about $0.0001) and prints the measured token total and its cost
from the `usage` column at the end. `--read-only` runs the catalog read only
and spends nothing.

Credentials come from the environment, exactly as the provider reads them
(`make smoke*` sources .env):

    export TYPESAFE_API_KEY=...

Rate limiting: Jev 1.13 allows 80 requests per second and 100K tokens per
second, adjusted dynamically while the service is in early access. Every
statement is paced by INTER_REQUEST_DELAY_S; a 429 is a harness bug and
fails the run (the provider's own retry policy would otherwise mask it).

Never run this against a production account.

Usage:
    python tests/smoke_test.py                 # local provider-dev/openapi registry (default)
    python tests/smoke_test.py --live          # the published provider in the stackql registry
    python tests/smoke_test.py --read-only     # the models catalog only, no evaluation is billed
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
PROVIDER = "typesafe"
# 80 requests per second is the documented limit; one statement per second
# keeps the suite two orders of magnitude under it.
INTER_REQUEST_DELAY_S = 1.0
REQUIRED_ENV = ("TYPESAFE_API_KEY",)
# pystackql manages its own stackql binary; the harness upgrades it when
# older than the minimum the provider needs (the provider-level retry policy
# is read by any-sdk >= 0.6.0, shipped in stackql v0.12.x).
MIN_STACKQL_VERSION = (0, 12, 700)
# docs.typesafe.ai/models, 2026-10-02: $0.042 per million input tokens
USD_PER_INPUT_TOKEN = 0.042 / 1_000_000

ERROR_RE = re.compile(
    r"http response status code: [45]|over HTTP error|error assembling|"
    r"cannot find matching operation|FindRoute|no matching operation|"
    r"cannot find any viable servers|parser error|panic|"
    r"no request body for operation|schema unsuitable|UNAUTHORIZED|FORBIDDEN|"
    r"authentication_error",
    re.I,
)
RATE_LIMIT_RE = re.compile(r"status code: 429|TOO_MANY_REQUESTS|rate_limit_error", re.I)

# The statements the docs lead with. `questions` is a JSON object passed as
# a string: naive body translation sends it as the JSON it encodes.
STATE_TICKET = "Hi, I've been trying to connect my Stripe account for 3 days and the integration keeps failing. I'm losing sales. Please help ASAP."
Q_NOUL = {"is_urgent": {"type": "noul", "instructions": "Does this message express urgency?"}}
Q_CHOICE = {
    "department": {
        "type": "choice",
        "instructions": "Which team should handle this?",
        "criteria": {
            "billing": "Payments, invoicing, refunds",
            "technical": "Bugs, outages, integrations",
            "sales": "Pricing, upgrades, new accounts",
        },
    }
}
Q_SCORE = {
    "frustration": {
        "type": "score",
        "instructions": "How frustrated is the customer?",
        "criteria": ["Calm", "Frustrated", "Very angry"],
    }
}
STATE_STRUCTURED = {
    "ticket": {
        "subject": "Duplicate charge",
        "messages": [
            {"from": "customer", "text": "I was charged twice for order A-104. Please refund the duplicate."},
            {"from": "support", "text": "We are checking the charges."},
        ],
    },
    "order": {"id": "A-104", "charges": [{"amount_usd": 49, "status": "captured"}, {"amount_usd": 49, "status": "captured"}]},
    "refund_policy": "Duplicate charges are eligible for a refund.",
}
Q_STRUCTURED = {
    "refund_requested": {"type": "noul", "instructions": "Did the customer ask for a refund?"},
    "policy_supports_refund": {
        "type": "noul",
        "instructions": "Does `refund_policy` entitle the customer to a refund of one of the charges in `order`?",
    },
}


def sql_str(value) -> str:
    """Render a Python value as a single-quoted SQL string literal (JSON for non-strings)."""
    text = value if isinstance(value, str) else json.dumps(value, separators=(",", ":"))
    return "'" + text.replace("'", "''") + "'"


class Smoke:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.results: list[tuple[str, str, str]] = []
        self.requests = 0
        self.input_tokens = 0
        self.output_tokens = 0

        for var in REQUIRED_ENV:
            if not os.environ.get(var):
                sys.exit(f"{var} is not set - see the module docstring and .env.example")

        from pystackql import StackQL

        if not args.live:
            reg_path = (BASE_DIR / "provider-dev" / "openapi").resolve()
            reg_url = "file://" + reg_path.as_posix()
            self.sq = StackQL(output="dict", custom_registry=reg_url)
            # pystackql only serialises {"url": ...}; a local file registry
            # additionally needs localDocRoot + nopVerify - patch the exec
            # params in place (compact JSON, shell-quoted).
            full = json.dumps(
                {"url": reg_url, "localDocRoot": reg_path.as_posix(), "verifyConfig": {"nopVerify": True}},
                separators=(",", ":"),
            )
            if sys.platform.startswith("win"):
                quoted = '"' + full.replace('"', '\\"') + '"'
            else:
                import shlex
                quoted = shlex.quote(full)
            params = self.sq.local_query_executor.params
            for i, p in enumerate(params):
                if p == "--registry":
                    params[i + 1] = quoted
                    break
        else:
            self.sq = StackQL(output="dict")
        self.ensure_stackql_version()

    def ensure_stackql_version(self) -> None:
        def parse(v: str) -> tuple[int, ...]:
            return tuple(int(x) for x in re.findall(r"\d+", str(v))[:3])

        current = parse(getattr(self.sq, "version", "") or "")
        if current and current >= MIN_STACKQL_VERSION:
            return
        print(f"stackql {self.sq.version} at {self.sq.bin_path} is older than "
              f"v{'.'.join(map(str, MIN_STACKQL_VERSION))} - upgrading pystackql's binary")
        self.sq.upgrade(showprogress=False)
        if parse(self.sq.version) < MIN_STACKQL_VERSION:
            sys.exit(f"stackql {self.sq.version} is still too old after upgrade")

    # ------------------------------------------------------------------ core
    def q(self, sql: str):
        # serial pacing under the rate limit
        if self.requests:
            time.sleep(INTER_REQUEST_DELAY_S)
        self.requests += 1
        try:
            out = self.sq.execute(sql)
        except Exception as exc:  # noqa: BLE001
            return [], str(exc)
        text = json.dumps(out, default=str)
        if RATE_LIMIT_RE.search(text):
            return out if isinstance(out, list) else [out], "RATE LIMITED (429) - harness pacing bug: " + text
        if ERROR_RE.search(text):
            return out if isinstance(out, list) else [out], text
        if isinstance(out, list) and out and isinstance(out[0], dict) and "error" in out[0]:
            return out, text
        return out if isinstance(out, list) else [out], None

    def step(self, name: str, sql: str, expect_rows: bool = False, contains: str | None = None):
        rows, err = self.q(sql)
        if err:
            self.results.append((name, "FAIL", err[:200]))
            print(f"  FAIL  {name}  [{err[:140]}]")
            return None
        blob = json.dumps(rows, default=str)
        if expect_rows and not rows:
            self.results.append((name, "FAIL", "expected rows, got none"))
            print(f"  FAIL  {name}  [no rows]")
            return None
        if contains and contains not in blob:
            self.results.append((name, "FAIL", f"'{contains}' not in result"))
            print(f"  FAIL  {name}  ['{contains}' not in {blob[:100]}]")
            return None
        self.results.append((name, "PASS", ""))
        print(f"  PASS  {name}")
        return rows

    def evaluate(self, name: str, state, questions, model: str = "jev-latest", contains: str | None = None):
        """One System One evaluation; accumulates the usage the row reports."""
        sql = (
            f"SELECT model, answers, usage FROM {PROVIDER}.systemone.evaluations "
            f"WHERE state = {sql_str(state)} AND model = {sql_str(model)} AND questions = {sql_str(questions)}"
        )
        rows = self.step(name, sql, expect_rows=True, contains=contains)
        if rows:
            usage = rows[0].get("usage")
            if isinstance(usage, str):
                try:
                    usage = json.loads(usage)
                except ValueError:
                    usage = {}
            if isinstance(usage, dict):
                self.input_tokens += int(usage.get("input_tokens") or 0)
                self.output_tokens += int(usage.get("output_tokens") or 0)
        return rows

    @staticmethod
    def answers_of(rows) -> dict:
        answers = rows[0].get("answers") if rows else None
        if isinstance(answers, str):
            try:
                answers = json.loads(answers)
            except ValueError:
                answers = {}
        return answers if isinstance(answers, dict) else {}

    def assert_true(self, name: str, cond: bool, note: str = "") -> None:
        self.results.append((name, "PASS" if cond else "FAIL", "" if cond else note))
        print(f"  {'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  [' + note[:140] + ']'}")

    # -------------------------------------------------------------- read path
    def read_smokes(self) -> None:
        print("== read smokes (free) ==")
        self.step("show services", f"SHOW SERVICES IN {PROVIDER}", expect_rows=True, contains="systemone")
        rows = self.step("models catalog", f"SELECT name, description, release_date FROM {PROVIDER}.models.models ORDER BY name",
                         expect_rows=True, contains="jev-latest")
        if rows:
            print("        " + ", ".join(f"{r.get('name')} ({r.get('release_date')})" for r in rows))

    # -------------------------------------------------------- inference path
    def evaluation_smokes(self) -> None:
        print("== System One evaluations (billed per input token) ==")
        rows = self.evaluate("noul: is the ticket urgent", STATE_TICKET, Q_NOUL, contains="noul")
        resolved = rows[0].get("model") if rows else None
        if rows:
            print(f"        {resolved}: {json.dumps(self.answers_of(rows))[:120]}")
            p = self.answers_of(rows).get("is_urgent", {}).get("noul")
            self.assert_true("noul answer is a probability in [0, 1]", isinstance(p, (int, float)) and 0 <= p <= 1, json.dumps(rows[0].get("answers"))[:140])
            self.assert_true("jev-latest resolves to a versioned model id", isinstance(resolved, str) and resolved.startswith("jev-") and resolved != "jev-latest", str(resolved))

        rows = self.evaluate("choice: which team", STATE_TICKET, Q_CHOICE, contains="choice")
        if rows:
            a = self.answers_of(rows).get("department", {})
            self.assert_true("choice answer names one of the criteria with probabilities and confidence",
                             a.get("choice") in Q_CHOICE["department"]["criteria"] and isinstance(a.get("probabilities"), dict) and "confidence" in a,
                             json.dumps(a)[:140])

        rows = self.evaluate("score: how frustrated", STATE_TICKET, Q_SCORE, contains="score")
        if rows:
            a = self.answers_of(rows).get("frustration", {})
            self.assert_true("score answer carries score, legend and probabilities",
                             isinstance(a.get("score"), (int, float)) and isinstance(a.get("legend"), dict) and isinstance(a.get("probabilities"), dict),
                             json.dumps(a)[:140])

        mixed = {**Q_NOUL, **Q_CHOICE, **Q_SCORE}
        rows = self.evaluate("mixed: three question types in one request", STATE_TICKET, mixed)
        if rows:
            self.assert_true("mixed request returns one answer per question", set(self.answers_of(rows)) == set(mixed), json.dumps(rows[0].get("answers"))[:140])

        rows = self.evaluate("structured state: ticket + order + policy as a JSON object", STATE_STRUCTURED, Q_STRUCTURED)
        if rows:
            self.assert_true("structured state answered both questions", set(self.answers_of(rows)) == set(Q_STRUCTURED), json.dumps(rows[0].get("answers"))[:140])

        if resolved:
            rows = self.evaluate(f"pinned model id {resolved}", STATE_TICKET, Q_NOUL, model=resolved)
            if rows:
                self.assert_true("pinned model id is echoed back", rows[0].get("model") == resolved, str(rows[0].get("model")))

        # json_extract over the JSON columns - the docs' routing idiom
        sql = (
            f"SELECT json_extract(answers, '$.is_urgent.noul') AS p_urgent, "
            f"json_extract(usage, '$.input_tokens') AS input_tokens "
            f"FROM {PROVIDER}.systemone.evaluations "
            f"WHERE state = {sql_str(STATE_TICKET)} AND model = 'jev-latest' AND questions = {sql_str(Q_NOUL)}"
        )
        rows = self.step("json_extract over answers and usage", sql, expect_rows=True)
        if rows:
            self.assert_true("json_extract yields the probability and the token count",
                             rows[0].get("p_urgent") not in (None, "") and str(rows[0].get("input_tokens")).isdigit(), json.dumps(rows[0])[:140])
            self.input_tokens += int(rows[0].get("input_tokens") or 0)

    # ---------------------------------------------------------------- summary
    def summary(self) -> int:
        print("\n== summary ==")
        counts = {"PASS": 0, "FAIL": 0}
        for name, status, note in self.results:
            counts[status] = counts.get(status, 0) + 1
            if status != "PASS":
                print(f"  {status:5s} {name}  [{note[:110]}]")
        registry = "public" if self.args.live else "local"
        print(f"  {counts['PASS']} passed, {counts['FAIL']} failed; {self.requests} statements, "
              f"paced at {INTER_REQUEST_DELAY_S}s (registry: {registry})")
        if self.input_tokens:
            print(f"  usage: {self.input_tokens} input tokens (about ${self.input_tokens * USD_PER_INPUT_TOKEN:.6f} at $0.042/Mtok), "
                  f"{self.output_tokens} output tokens (free)")
        return 1 if counts["FAIL"] else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=f"{PROVIDER} provider smoke test")
    ap.add_argument("--live", action="store_true",
                    help="run against the published provider in the stackql registry (default: the local provider-dev/openapi file registry)")
    ap.add_argument("--read-only", action="store_true", help="the models catalog only - no evaluation is billed")
    args = ap.parse_args()

    smoke = Smoke(args)
    print(f"{PROVIDER} smoke test  registry={'public' if args.live else 'local'}  stackql={smoke.sq.version}")
    smoke.read_smokes()
    if not args.read_only:
        smoke.evaluation_smokes()
    return smoke.summary()


if __name__ == "__main__":
    sys.exit(main())
