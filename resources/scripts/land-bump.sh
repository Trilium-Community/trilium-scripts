#!/usr/bin/env bash
# Runs one tamhelper bump command and lands what it changes on main, with its changelog, as the GitHub Actions bot.
# A push that loses a race with another push starts again from the new main; prints landed=true to GITHUB_OUTPUT on success.
set -euo pipefail

command="$1"
git config user.name "github-actions[bot]"
git config user.email "41898283+github-actions[bot]@users.noreply.github.com"

for attempt in 1 2 3; do
    git fetch -q origin main
    git reset -q --hard origin/main
    bump_output="$(mktemp)"
    GITHUB_OUTPUT="$bump_output" node resources/scripts/tamhelper.js "$command"
    grep -q "^updated=true$" "$bump_output" || exit 0
    addon="$(sed -n 's/^addon=//p' "$bump_output")"
    addon_version="$(sed -n 's/^addon_version=//p' "$bump_output")"
    message="$(sed -n 's/^message=//p' "$bump_output")"
    node resources/scripts/tamhelper.js validate
    git add -A
    git commit -qm "$message"
    node resources/scripts/tamhelper.js changelog
    git commit -qam "chore: regenerate the changelog for $addon $addon_version"
    if git push origin HEAD:main; then
        echo "landed=true" >> "${GITHUB_OUTPUT:-/dev/null}"
        exit 0
    fi
done

echo "Could not land the $command update after 3 attempts." >&2
exit 1
