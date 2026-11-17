#!/usr/bin/env bash
# 复用同一不可变源码提交在 main 的完整门禁；缺失、失败或超时均拒绝发布。
set -euo pipefail
[[ ${GITHUB_SHA:-} =~ ^[a-f0-9]{40}$ && -n ${GITHUB_REPOSITORY:-} && -d ${RUNNER_TEMP:-} ]] || { echo '缺少 GitHub 发布上下文' >&2; exit 1; }
for attempt in $(seq 1 120); do
  gh api "repos/${GITHUB_REPOSITORY}/actions/runs?head_sha=${GITHUB_SHA}&per_page=100" > "${RUNNER_TEMP}/release-runs.json"
  if node scripts/verify-release.mjs checks "${RUNNER_TEMP}/release-runs.json" "${GITHUB_SHA}"; then
    exit 0
  else
    status=$?
    [[ $status == 75 ]] || exit "$status"
  fi
  sleep 30
done
echo '等待 main 同提交的完整门禁超时' >&2
exit 1
