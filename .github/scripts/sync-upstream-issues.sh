#!/usr/bin/env bash
# Reconcile one rolling maintenance issue per provider from the drift
# result JSON in $RESULT (produced by scripts/check-upstream.mjs).
#
# Idempotent: the existing tracker is found by its label pair
# (upstream-update + provider:<key>), so repeated cron runs edit the
# same issue instead of opening duplicates. OpenCode ships several times
# a week — a fresh issue per release would bury the repo.
#
# This script only opens / updates / closes issues. It never edits
# runtime code and never touches support/upstream-versions.json — that
# bump is a deliberate human PR after a compatibility review.
set -euo pipefail

# Fail red if the detector produced no usable result. An empty or
# malformed $RESULT means the `result=` output from the detect step
# never wired through (a renamed step id, a crashed script, a GitHub
# Actions output-format change). Without this guard the loop below
# would iterate ZERO providers and the whole run would go GREEN having
# opened, updated, and closed nothing — silently masking a broken
# detector, which is the one failure mode this whole system exists to
# prevent. Checked before label creation so a broken run is inert.
if ! jq -e '.results | type == "array" and length > 0' >/dev/null 2>&1 <<<"${RESULT:-}"; then
  echo "ERROR: \$RESULT is empty or has no providers — the detect step likely failed" >&2
  exit 1
fi

# Ensure the two generic labels exist. --force is create-or-update, so
# this is safe against a repo that has never seen these labels.
gh label create upstream-update --color FBCA04 \
  --description "Upstream CLI moved; needs a compatibility pass" --force
gh label create maintenance --color 0E8A16 \
  --description "Maintenance work" --force

echo "$RESULT" | jq -c '.results[]' | while read -r row; do
  provider=$(jq -r '.provider'   <<<"$row")
  label_name=$(jq -r '.label'    <<<"$row")
  pkg=$(jq -r '.pkg'             <<<"$row")
  accepted=$(jq -r '.accepted'   <<<"$row")
  latest=$(jq -r '.latest'       <<<"$row")
  drift=$(jq -r '.drift'         <<<"$row")
  changelog=$(jq -r '.changelog' <<<"$row")

  # Per-provider label, created only for providers this repo watches.
  gh label create "provider:${provider}" --color 6F42C1 \
    --description "Affects ${label_name} integration" --force

  marker="<!-- upstream-watch:${provider} -->"
  title="chore(upstream): ${label_name} ${latest} is newer than accepted ${accepted}"

  # The tracker is keyed by its labels — structured and reliable,
  # unlike full-text body search. There is at most one open tracker
  # per provider by construction.
  existing=$(gh issue list --state open \
    --label upstream-update --label "provider:${provider}" \
    --json number --jq '.[0].number // empty')

  if [ "$drift" = "true" ]; then
    body=$(cat <<EOF
${marker}

## Upstream version detected

| | |
|---|---|
| Provider | ${label_name} |
| npm package | \`${pkg}\` |
| Accepted (supported) version | \`${accepted}\` |
| Latest upstream version | \`${latest}\` |

Release notes / changelog: ${changelog}

## What this issue means

Upstream moved. **This is not a known breakage.** It only means a newer
${label_name} release exists than the version this repo has explicitly
accepted in \`support/upstream-versions.json\`.

A human or agent must read the upstream release notes and verify this
repo still works against the new version. **Do not bump the accepted
version until that review is done.**

## Acceptance checklist

- [ ] Upstream release notes reviewed
- [ ] Schema gate: \`src/transcript/schema.ts\` REQUIRED_COLUMNS still present in the new release's \`opencode.db\` (\`npm run census -- --db <path>\`)
- [ ] Durable event versions: \`message.updated\` / \`message.removed\` still version 1; the census reports no new event families in a session written by the new release
- [ ] Assistant write orders unchanged: SessionProcessor cleanup, SessionPrompt.shellImpl, SessionPrompt.handleSubtask (see \`src/transcript/CommittedAssembler.ts\`)
- [ ] Live bus and re-sync endpoints unchanged: re-record with \`npm run probe:live\` and diff against \`testing/fixtures/live\`
- [ ] Existing fixtures / verification scripts still pass; regenerated fixtures documented in \`testing/fixtures/README.md\`
- [ ] \`support/upstream-versions.json\` bumped to \`${latest}\` in a PR

_Maintained automatically by \`.github/workflows/upstream-watch.yml\`. The bot keeps this issue current as upstream moves and closes it once the accepted version catches up._
EOF
)
    # Preserve multiline Markdown literally; a file also keeps issue text out
    # of argv and matches the sibling package's structured result boundary.
    body_file=$(mktemp)
    trap 'rm -f "$body_file"' EXIT
    printf '%s\n' "$body" >"$body_file"
    if [ -n "$existing" ]; then
      gh issue edit "$existing" --title "$title" --body-file "$body_file"
      echo "Updated #${existing} for ${provider} (latest ${latest})"
    else
      gh issue create --title "$title" --body-file "$body_file" \
        --label upstream-update --label maintenance --label "provider:${provider}"
      echo "Opened tracker for ${provider} (latest ${latest})"
    fi
    rm -f "$body_file"
    trap - EXIT
  else
    # No drift. If a tracker is still open, a human merged the bump PR
    # and the accepted version has caught up — close it.
    if [ -n "$existing" ]; then
      gh issue close "$existing" \
        --comment "Accepted version is now \`${accepted}\`, in sync with upstream \`${latest}\`. Closed automatically."
      echo "Closed #${existing} for ${provider} — drift resolved"
    else
      echo "${provider}: in sync (accepted ${accepted}, latest ${latest})"
    fi
  fi
done
