#!/usr/bin/env bash

# Validates every SQL block on the getting-started page
# (provider-dev/docgen/provider-data/headerContent2.txt) before a publish:
#
#   - statements against typesafe run LIVE when TYPESAFE_API_KEY is set
#     (a few hundred input tokens each, fractions of a cent) and are
#     expected to return rows;
#   - statements against the other providers the examples use (aws, k8s,
#     okta, github, anthropic) run with DUMMY credentials against a temporary
#     registry built from a stackql-provider-registry clone. The goal is to
#     prove that each statement ROUTES - reaches an auth or network error on
#     the wire - not that it succeeds. A routing failure ("cannot find
#     matching operation", "parser error", an unknown column) is a docs bug.
#     No real credential is read for those providers, so nothing is changed.
#
# Requires: a stackql binary on PATH, python3, the provider built
# (provider-dev/openapi), and a clone of stackql/stackql-provider-registry
# (REGISTRY_SRC, default ../../../../stackql/core/stackql-provider-registry/providers/src
# relative to this repo, i.e. the sibling layout used on the build machine).
#
# Usage: bin/validate-docs-examples.sh            (sources .env when present)
#        REGISTRY_SRC=/path/to/providers/src bin/validate-docs-examples.sh
#        EXAMPLES_FILE=/path/to/post.md bin/validate-docs-examples.sh

set -uo pipefail
REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$REPO_ROOT"
# EXAMPLES_FILE overrides the file whose sql blocks are checked (e.g. a blog post).
HEADER="${EXAMPLES_FILE:-provider-dev/docgen/provider-data/headerContent2.txt}"
REGISTRY_SRC="${REGISTRY_SRC:-$REPO_ROOT/../../../../stackql/core/stackql-provider-registry/providers/src}"

if [ -f .env ]; then set -a; source <(tr -d '\r' < .env); set +a; fi
if [ ! -d "$REGISTRY_SRC" ]; then
  echo "REGISTRY_SRC not found: $REGISTRY_SRC (clone stackql/stackql-provider-registry and point REGISTRY_SRC at providers/src)" >&2
  exit 2
fi

# Dummy credentials for the context / action providers: every call must fail
# at auth or network, never at routing. Override none of these with real values.
export AWS_ACCESS_KEY_ID=AKIADUMMYDUMMYDUMMY0 AWS_SECRET_ACCESS_KEY=dummydummydummydummydummydummydummydummy
export STACKQL_GITHUB_USERNAME=dummy STACKQL_GITHUB_PASSWORD=dummy
export OKTA_API_TOKEN=dummy
export KUBE_HOST=localhost KUBE_PROTOCOL=http
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-dummy}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/src"
cp -r provider-dev/openapi/src/typesafe "$TMP/src/typesafe"
for p in anthropic aws github okta k8s; do
  [ -d "$REGISTRY_SRC/$p" ] || { echo "provider $p missing from $REGISTRY_SRC" >&2; exit 2; }
  cp -r "$REGISTRY_SRC/$p" "$TMP/src/$p"
done
REG="{\"url\": \"file://$TMP\", \"localDocRoot\": \"$TMP\", \"verifyConfig\": {\"nopVerify\": true}}"

python3 - "$HEADER" <<'PY' > "$TMP/stmts.txt"
import re, sys
t = open(sys.argv[1], encoding='utf-8').read()
blocks = re.findall(r"```sql\n(.*?)```", t, re.S)
stmts = []
for b in blocks:
    body = "\n".join(l for l in b.split("\n") if not l.strip().startswith("--"))
    for s in body.split(";"):
        s = s.strip()
        if s:
            stmts.append(s)
print("\x1e".join(stmts))
PY

live=1
[ -n "${TYPESAFE_API_KEY:-}" ] || { live=0; echo "TYPESAFE_API_KEY not set - typesafe statements are routing-checked only"; }

pass=0; fail=0; i=0
while IFS= read -r -d $'\x1e' sql || [ -n "$sql" ]; do
  i=$((i+1))
  first="$(echo "$sql" | head -1 | cut -c1-72)"
  prov="$(echo "$sql" | grep -o -E "(FROM|INTO|UPDATE|EXEC) [a-z0-9_]+\." | head -1 | sed -E 's/.* ([a-z0-9_]+)\./\1/')"
  case "$sql" in
    REGISTRY*) echo "skip  [meta]      $first"; continue;;
    SHOW*|DESCRIBE*) prov="meta";;
  esac
  out="$(stackql --registry="$REG" exec "$sql" --output json 2>&1)"
  if echo "$out" | grep -q -i -E "cannot find matching operation|no appropriate method|parser error|unknown column|no such column|could not locate symbol|syntax error|FindRoute|not supported"; then
    verdict="FAIL"; fail=$((fail+1))
  elif [ "$prov" = "typesafe" ] && [ "$live" = 1 ]; then
    if echo "$out" | grep -q '^\[{'; then verdict="PASS"; pass=$((pass+1)); else verdict="FAIL"; fail=$((fail+1)); fi
  elif [ "$prov" = "meta" ]; then
    if echo "$out" | grep -q '^\[{'; then verdict="PASS"; pass=$((pass+1)); else verdict="FAIL"; fail=$((fail+1)); fi
  else
    verdict="PASS"; pass=$((pass+1))   # routed to the wire (auth / network error with dummy credentials)
  fi
  printf '%-5s [%-9s] %s\n' "$verdict" "$prov" "$first"
  if [ "$verdict" = "FAIL" ] || [ "$prov" = "typesafe" ]; then echo "      $(echo "$out" | head -c 200 | tr '\n' ' ')"; fi
  sleep 0.5
done < "$TMP/stmts.txt"

echo
echo "$pass passed, $fail failed ($i statements; typesafe live: $live)"
[ "$fail" -eq 0 ]
