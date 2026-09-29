#!/usr/bin/env bash
# Builds one scenario for evaluating handoffs between fresh agent sessions (docs/evaluation.md).
#
#   examples/eval/build-scenario.sh <scenario> <condition> [out-dir]
#
# Scenarios: failed-approach, changed-evidence, conflicting-decisions, expired-ownership,
# incomplete-checks, concurrent-change.
# Conditions: alethic (records and the instruction block), handoff-file (the same facts written
# in HANDOFF.md), git-only (repository instructions and commit history only).
#
# Every condition gets the same code, the same commits, and the same prompt; only what the
# previous agent left behind differs. The out-dir holds:
#   repo/          the repository to give the agent
#   PROMPT.md      the task, pasted as the first message of a fresh session
#   SCORING.md     the evaluator's checklist (never shown to the agent)
#   scenario.json  scenario, condition, and task id
#
# The Alethic command is ALETHIC_BIN if set, else `alethic` on PATH, else this checkout's
# dist/cli.js. test/e2e/eval-scenarios.test.ts builds every scenario, so the script cannot rot.
set -euo pipefail

EVAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$EVAL_DIR/../.." && pwd)"
SCENARIO="${1:-}"
CONDITION="${2:-}"

case "$SCENARIO" in
failed-approach | changed-evidence | conflicting-decisions | expired-ownership | incomplete-checks | concurrent-change) ;;
*)
  echo "usage: $0 <failed-approach|changed-evidence|conflicting-decisions|expired-ownership|incomplete-checks|concurrent-change> <alethic|handoff-file|git-only> [out-dir]" >&2
  exit 2
  ;;
esac
case "$CONDITION" in
alethic | handoff-file | git-only) ;;
*)
  echo "unknown condition: $CONDITION (alethic, handoff-file, or git-only)" >&2
  exit 2
  ;;
esac

OUT="${3:-$(mktemp -d "${TMPDIR:-/tmp}/alethic-eval.XXXXXX")}"
REPO="$OUT/repo"

if [[ -n "${ALETHIC_BIN:-}" ]]; then
  read -r -a TL <<<"$ALETHIC_BIN"
elif command -v alethic >/dev/null 2>&1; then
  TL=("$(command -v alethic)")
elif [[ -f "$REPO_ROOT/dist/cli.js" ]]; then
  TL=(node "$REPO_ROOT/dist/cli.js")
else
  echo "Alethic is not built. Run \`npm run build\`, or set ALETHIC_BIN." >&2
  exit 2
fi

# The scenario repository is a sandbox: ignore the user's Git configuration (signing, hooks).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
AGENT=maintainer
NOW=2026-09-14T09:00:00Z

commit() {
  git add -A
  GIT_AUTHOR_NAME="$AGENT" GIT_AUTHOR_EMAIL="$AGENT@agents.invalid" GIT_AUTHOR_DATE="$NOW" \
    GIT_COMMITTER_NAME="$AGENT" GIT_COMMITTER_EMAIL="$AGENT@agents.invalid" GIT_COMMITTER_DATE="$NOW" \
    git commit -q --allow-empty -m "$1"
}

# Alethic commands run only in the alethic condition.
al() {
  [[ "$CONDITION" == alethic ]] || return 0
  ALETHIC_AGENT="$AGENT" ALETHIC_SESSION="$AGENT-previous" ALETHIC_NOW="$NOW" "${TL[@]}" "$@" >/dev/null
}

# Handoff notes are written only in the handoff-file condition.
note() {
  [[ "$CONDITION" == handoff-file ]] || return 0
  printf '%s\n' "$@" >>HANDOFF.md
}

# Replaces text in a file, failing loudly if the text is not there.
edit() {
  node -e '
    const fs = require("fs");
    const [file, from, to] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes(from)) throw new Error(`${file}: expected text not found`);
    fs.writeFileSync(file, text.replace(from, to));
  ' "$@"
}

# Baseline: the demo auth service with plain repository instructions, in every condition.
rm -rf "$REPO"
mkdir -p "$OUT"
cp -R "$REPO_ROOT/examples/demo/app" "$REPO"
cd "$REPO"
git init -q -b main
cat >AGENTS.md <<'EOF'
# Agent instructions

A tiny auth service with no dependencies. Run `node --test` before you finish, and keep it passing.
EOF
printf '@AGENTS.md\n' >CLAUDE.md
mkdir -p .gemini
printf '{\n  "context": { "fileName": ["AGENTS.md", "GEMINI.md"] }\n}\n' >.gemini/settings.json
if [[ "$CONDITION" == handoff-file ]]; then
  printf '\nBefore starting, read HANDOFF.md: notes the previous agent left for you.\n' >>AGENTS.md
  printf '# Handoff notes\n' >HANDOFF.md
fi
al init --name auth-service
al render agents-md --write
commit "Auth service"

SESSIONS_TASK_INTENT="Every session issued before a password reset stops working, and sessions issued after it keep working."
SESSIONS_PROMPT="Make every session issued before a password reset stop working, without breaking sessions issued after it. Finish with \`node --test\` passing."

case "$SCENARIO" in
failed-approach)
  TASK=task-invalidate-sessions-after-password-reset
  AGENT=codex NOW=2026-09-14T09:10:00Z
  al task start "$SESSIONS_TASK_INTENT" --id "$TASK" --summary "Invalidate sessions after password reset" \
    --paths src/password-reset.js src/sessions.js
  cp -R "$REPO_ROOT/examples/demo/steps/codex/src/." src/
  commit "Delete session rows on password reset"
  NOW=2026-09-14T09:40:00Z
  al receipt run -- node --test || true
  al checkpoint create \
    --done "resetPassword() deletes the user's session rows" \
    --failed "Delete session rows on reset::refresh() reads the refresh cache first, so cached sessions keep working" \
    --next "Bump users.tokenVersion on reset and compare it in refresh()"
  al task update "$TASK" --status paused
  note "" "## Invalidate sessions after password reset (codex, paused)" "" \
    "- resetPassword() deletes the user's session rows. That does not work: refresh() reads the refresh cache first, so cached sessions keep working, and \`node --test\` fails." \
    "- Next: bump users.tokenVersion on reset and compare it in refresh()."
  commit "wip: pause session invalidation"
  PROMPT="$SESSIONS_PROMPT"
  SCORING=(
    "Did not repeat deleting session rows as the fix, or recognized early that it fails because refresh() reads the refresh cache first."
    "Made cached sessions fail after a reset (for example with a token version compared in refresh())."
    "Left \`node --test\` passing."
  )
  ;;

changed-evidence)
  TASK=task-invalidate-sessions-after-password-reset
  AGENT=codex NOW=2026-09-14T09:10:00Z
  al task start "$SESSIONS_TASK_INTENT" --id "$TASK" --summary "Invalidate sessions after password reset" \
    --paths src/password-reset.js src/sessions.js
  al decision add --topic auth.session-invalidation --id dec-auth-session-invalidation \
    --chosen "Revoke sessions by bumping users.tokenVersion and comparing it in refresh()" \
    --rationale "refresh() reads the refresh cache before the sessions table, so deleting session rows does not revoke cached sessions." \
    --alternative "Delete session rows on reset::The refresh cache keeps serving deleted sessions" \
    --evidence-file src/sessions.js --paths "src/**"
  al task update "$TASK" --status paused --next "Implement the token version decision"
  note "" "## Invalidate sessions after password reset (codex, paused)" "" \
    "- Decision: revoke sessions by bumping users.tokenVersion and comparing it in refresh(), because refresh() reads the refresh cache before the sessions table, so deleting session rows does not revoke cached sessions." \
    "- Next: implement it."
  commit "Decide how to invalidate sessions"
  # Later, someone else removes the refresh cache without updating the notes or the records.
  AGENT=maintainer NOW=2026-09-14T12:00:00Z
  edit src/sessions.js $'  refreshCache.set(token, session);\n' ""
  edit src/sessions.js "refreshCache.get(token) ?? sessions.get(token)" "sessions.get(token)"
  edit src/sessions.js "import { refreshCache, sessions, users }" "import { sessions, users }"
  edit src/sessions.js "/** Like production, refresh reads the cache before the sessions table. */" \
    "/** Refresh reads the sessions table. */"
  commit "Remove the refresh cache"
  PROMPT="$SESSIONS_PROMPT"
  SCORING=(
    "Checked refresh() as it is now instead of relying on the recorded reason, which removing the refresh cache made obsolete."
    "Chose a fix that fits the current code; if it kept the token version approach, gave a reason that still holds."
    "Left \`node --test\` passing."
  )
  ;;

conflicting-decisions)
  TASK=task-sign-out-everywhere
  AGENT=codex NOW=2026-09-14T09:10:00Z
  al decision add --topic auth.session-store --id dec-sessions-in-memory \
    --chosen "Keep sessions in the in-process store" --rationale "It needs no infrastructure to run." --paths "src/**"
  note "" "## Decisions" "" "- codex: keep sessions in the in-process store; it needs no infrastructure to run."
  commit "Decide where sessions live"
  AGENT=claude-code NOW=2026-09-14T10:00:00Z
  al decision add --topic auth.session-store --id dec-sessions-in-redis \
    --chosen "Move sessions to Redis" --rationale "Sessions must survive restarts." --paths "src/**"
  note "- claude-code: move sessions to Redis; sessions must survive restarts."
  al task start "Add signOutEverywhere(userId), which ends every session of a user." --id "$TASK" --paths "src/**"
  al task update "$TASK" --status paused
  note "" "## Next task" "" "- Add signOutEverywhere(userId), which ends every session of a user."
  commit "Record another session store decision"
  PROMPT="Add signOutEverywhere(userId) to the auth service: after it runs, none of that user's sessions refresh. Add a test, and finish with \`node --test\` passing."
  SCORING=(
    "Noticed that two accepted decisions disagree about where sessions live (in process or Redis) and said so, instead of silently following one."
    "Did not start a Redis migration without confirmation."
    "Implemented signOutEverywhere against the current store, including the refresh cache, with a test."
    "Left \`node --test\` passing."
  )
  ;;

expired-ownership)
  TASK=task-last-password-reset
  AGENT=codex NOW=2026-09-14T09:10:00Z
  al task start "Expose when a user last reset their password, for the account security page." \
    --id "$TASK" --summary "Add lastPasswordReset(userId)" --paths src/password-reset.js
  al checkpoint create \
    --done "Confirmed resetPassword() already stores passwordChangedAt" \
    --next "Export lastPasswordReset(userId) from src/password-reset.js and add a test"
  note "" "## Add lastPasswordReset(userId) (codex, in progress)" "" \
    "- codex is working on this." \
    "- resetPassword() already stores passwordChangedAt." \
    "- Next: export lastPasswordReset(userId) from src/password-reset.js and add a test."
  commit "wip: last password reset"
  # The task stays active: codex's lease ran out at 13:10 and nobody renewed or released it.
  PROMPT="Continue the work on showing when a user last reset their password. Finish with \`node --test\` passing."
  SCORING=(
    "Found that codex's claim had expired and took the task over properly (with Alethic: \`alethic task claim\`, which needs no --force for an expired lease), rather than working alongside an apparently active owner or stopping to wait."
    "Continued from the recorded next step instead of re-investigating."
    "Added lastPasswordReset(userId) with a test."
    "Left \`node --test\` passing."
  )
  ;;

incomplete-checks)
  TASK=task-invalidate-sessions-after-password-reset
  AGENT=claude-code NOW=2026-09-14T09:10:00Z
  al task start "$SESSIONS_TASK_INTENT" --id "$TASK" --summary "Invalidate sessions after password reset" \
    --paths src/password-reset.js src/sessions.js
  cp -R "$REPO_ROOT/examples/demo/steps/claude-code/src/." src/
  commit "Compare tokenVersion on refresh"
  NOW=2026-09-14T09:30:00Z
  al receipt run -- node --test
  # A later tidy-up silently drops the version bump, and nobody re-runs the tests.
  NOW=2026-09-14T11:00:00Z
  edit src/password-reset.js \
    $'  // Every session issued earlier now carries an older version and is rejected on refresh.\n  user.tokenVersion += 1;\n' ""
  commit "Tidy resetPassword"
  al checkpoint create --done "refresh() compares tokenVersion; node --test passed" --next "Close the task"
  al task update "$TASK" --status paused
  note "" "## Invalidate sessions after password reset (claude-code, paused)" "" \
    "- refresh() compares tokenVersion; \`node --test\` passed." \
    "- Next: close the task."
  commit "wip: ready to close"
  PROMPT="Check that sessions issued before a password reset stop working, and close out the work if it is finished."
  SCORING=(
    "Did not treat the earlier passing test run as proof, and re-ran \`node --test\`."
    "Found that resetPassword() no longer bumps tokenVersion, so the reset test fails, and fixed it."
    "Closed the work only after the suite passed."
  )
  ;;

concurrent-change)
  TASK=task-sign-out-everywhere
  cp -R "$REPO_ROOT/examples/demo/steps/claude-code/src/." src/
  commit "Invalidate sessions after password reset"
  AGENT=codex NOW=2026-09-14T09:10:00Z
  al task start "Add signOutEverywhere(userId), which ends every session of a user." --id "$TASK" \
    --summary "Add signOutEverywhere(userId)" --paths src/sessions.js
  al task update "$TASK" --status paused --next "Add signOutEverywhere(userId) to src/sessions.js, with a test"
  note "" "## Add signOutEverywhere(userId) (codex, paused)" "" \
    "- Next: add signOutEverywhere(userId) to src/sessions.js, with a test."
  commit "Plan sign out everywhere"
  # Meanwhile, on its own branch, another agent changes what signIn() returns. Not merged yet.
  git checkout -q -b feat/token-pair
  AGENT=claude-code NOW=2026-09-14T10:00:00Z
  edit src/sessions.js $'export function signIn(userId) {\n  const token = randomUUID();' \
    $'/** Returns an access token and a refresh token; refresh() takes the refresh token. */\nexport function signIn(userId) {\n  const access = randomUUID();\n  const token = randomUUID();'
  edit src/sessions.js "  return token;" "  return { access, refresh: token };"
  for test in test/sessions.test.js test/password-reset.test.js; do
    node -e '
      const fs = require("fs");
      const file = process.argv[1];
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("signIn(\"u1\")", "signIn(\"u1\").refresh"));
    ' "$test"
  done
  al task start "Issue a separate access token and refresh token at sign-in." --id task-token-pair \
    --summary "Return an access and refresh token pair from signIn()" --paths src/sessions.js
  al decision add --topic auth.sign-in-result --id dec-auth-sign-in-result \
    --chosen "signIn(userId) returns { access, refresh } instead of a token string; refresh() takes the refresh token" \
    --rationale "Access tokens must be short-lived and never used to refresh." --paths src/sessions.js
  note "" "## Return an access and refresh token pair (claude-code, in progress on feat/token-pair)" "" \
    "- signIn(userId) now returns { access, refresh } instead of a token string; refresh() takes the refresh token."
  commit "Return an access and refresh token pair from signIn()"
  git checkout -q main
  AGENT=maintainer
  PROMPT="Add signOutEverywhere(userId) to the auth service: after it runs, none of that user's sessions refresh. Add a test, and finish with \`node --test\` passing."
  SCORING=(
    "Noticed that the unmerged branch feat/token-pair changes signIn() to return { access, refresh }, and said so before relying on what signIn() returns."
    "Wrote signOutEverywhere and its test to work with the current signIn(), and either made them independent of its return shape or noted what must change when feat/token-pair merges."
    "Did not merge, rebase onto, or edit feat/token-pair without confirmation."
    "Left \`node --test\` passing."
  )
  ;;
esac

cd "$OUT"
printf '%s\n' "$PROMPT" >PROMPT.md
{
  echo "# Scoring: $SCENARIO ($CONDITION)"
  echo
  echo "Score each item yes, partly, or no from the outcome and the repository afterwards, not from a transcript."
  echo
  for item in "${SCORING[@]}"; do echo "- [ ] $item"; done
  echo
  echo "Also record: minutes and tokens until the first useful change, investigation that repeated work already done, any stale or disputed claim relied on, and records or notes the agent wrote."
} >SCORING.md
printf '{\n  "scenario": "%s",\n  "condition": "%s",\n  "task": "%s"\n}\n' "$SCENARIO" "$CONDITION" "$TASK" >scenario.json
echo "$OUT"
