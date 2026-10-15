#!/usr/bin/env bash
# Stages a Tier 3 fixture repo in the current directory (the eval sandbox cwd):
# commit 1 = <fixture>/base, commit 2 = <fixture>/change laid over it (the change under review),
# and that commit's diff in CHANGE.diff.
# Called from a case's scaffold.sh; needs `claude plugin eval --scaffold`.
set -euo pipefail
fixture="$(cd "$(dirname "$0")" && pwd)/$1"
[ -d "$fixture/base" ] || { echo "no fixture $1" >&2; exit 1; }
g() { git -c user.email=eval@example.com -c user.name=eval -c commit.gpgsign=false "$@"; }
cp -R "$fixture/base/." .
git init -q -b main
g add -A && g commit -qm "base"
if [ -d "$fixture/change" ]; then
  cp -R "$fixture/change/." .
  g add -A && g commit -qm "$(cat "$fixture/MESSAGE" 2>/dev/null || echo change)"
  # The change as a file, so cases need no shell tool (a granted Bash must be sandboxed,
  # which not every machine running the evals can do).
  git show HEAD --format='commit %h%n%n    %s%n' > CHANGE.diff
fi
