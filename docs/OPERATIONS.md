# CodexPulse operations and source transition

Use this runbook only for an identified, authorized installation. The repository does not assert an active service. [README](../README.md#source-consolidation) owns consolidation status; [deployment](DEPLOYMENT.md) owns configuration and setup. Keep account IDs, deployed URLs, credentials, real task data and local installation records outside Git.

## Diagnose by hop

| Signal | Meaning / next check |
|---|---|
| `/api/health` succeeds | Relay can ping its configured database; does not prove authentication or Push |
| Login/mutation 403 | Compare the actual opened origin with `APP_ORIGIN`; never relax origin checks to make a preview work |
| Host offline / queue grows | Check Mac sleep/network/clock, relay reachability and content-free bridge errors; one Mac does not proxy another |
| `codex_not_found` / `app_server_timeout` | Check supported local executable path and compatibility; do not expose App Server publicly |
| No Push attempt | Check watch rule and event TTL before subscription/provider |
| Provider failure | 404/410 disables an endpoint; transient failure can request bridge replay, bounded to three dispatches |
| Provider accepted, phone silent | Check Home Screen installation, permission, Focus and phone connectivity; acceptance is not visible delivery |
| Fingerprint missing/mismatch | Fail-closed credential access; stop and recover the old trusted install rather than retrying Keychain prompts |
| Quota / stale live state | Use authenticated retention cleanup when authorized; inspect freshness; never silently raise caps or treat old state as current |

The bridge's `status` command can inspect its local state, but must not be run as a synthetic source test against a user's installation. Do not copy its host identifiers into public artifacts. Logs must remain content-free; prompts, transcripts, paths, payloads and credential headers must not be logged at either application or platform level.

## Upgrade and rollback

1. Verify the reviewed source (`npm ci`, `npm run verify:all`, `npm run check:public`). Record source SHA and built artifact hashes. Preserve the previous deployment and operator-owned private backup; never publish it.
2. For an existing relay, retain origin, database, encryption keys and VAPID keys unless an explicit data migration is required. Apply only reviewed schema additions after backup; no schema change is required by source consolidation. Roll back code to the recorded previous artifact if smoke checks fail. Do not drop tables, rotate keys or roll back additive schema blindly.
3. For an unsigned bridge replacement, first preserve the old binary and private state for recovery. Stop its service (`service-uninstall --yes`) and restore notify (`notify-uninstall --yes`) using the current trusted binary. If safe notify restoration fails, stop here and retain recovery state. If running tasks cached the old hook, finish/restart those tasks or Codex before resuming notifications.
4. Revoke the old host on the phone when authorized. Use the old matching executable's `local-reset --yes` to remove its credential and move state/binary to Trash. This is an explicit destructive local action, never an automated side effect of repository migration. If a legacy config has no fingerprint, **do not manufacture one or bypass the guard**; stop for a separate Keychain/config recovery review.
5. Install the tested final binary, create a fresh phone-confirmed pairing, then opt in to notify and launchd. Re-pairing generates a new host identity and opaque task IDs; old watch rules do not transfer automatically. Recreate desired watch rules and verify with synthetic events before real tasks.
6. If a newly paired bridge must be rolled back, follow the same stop/restore/revoke/reset sequence with that matching binary, reinstall the prior artifact, and pair fresh. Restoring just `config.json` cannot restore a deleted Keychain item. Never overwrite a paired executable or promise transparent downgrade.

Source-only publication does not require reinstalling bridges, changing domains or resubscribing phones. Keep functioning installations unchanged until their owner approves a concrete runtime change.

## Secrets and retention

- Access-token rotation changes future logins; rotate `SESSION_SECRET` too to invalidate current sessions.
- `RELAY_MASTER_KEY` encrypts persisted credentials: preserve it with a protected database backup. Replacing it needs an explicit re-encryption or revoke/re-pair plan.
- VAPID replacement requires phones to subscribe again. Host secret rotation means revoke and pair again.
- Daily or explicitly requested owner cleanup removes expired data within existing caps. Do not delete or pause an unknown database, cron or local bridge to “finish” a source migration.

## Private-history retirement — after source review/publication

The old private repository stays private with its original history. Preserve all advertised branch/tag refs and a verified Git bundle in private storage before any archive action. A Git bundle preserves Git history only: it does not back up ignored files, platform configuration, databases, Keychain items, GitHub issues or uncommitted work.

Order of operations:

1. Re-fetch both remotes and compare against the review baselines. If either changed, review the new difference before publishing. Audit the public candidate diff and assets; never merge the private Git history or make that repository public.
2. Before **either** repository is pushed, inspect its Actions/workflows, webhooks and hosting Git integrations using metadata. A source push or a README-only commit can trigger deployment. If an automatic trigger exists, obtain approval to suspend/disconnect it or separately approve the resulting deployment; do not treat source publication permission as runtime permission. Inventory owners of any deployment, Neon project, cron and Mac installation. Unknown services remain untouched.
3. Publish the reviewed public-source changes only after approval and the trigger check. Record the resulting SHA. The public repo becomes the sole future code source; personal operation notes and historical internal research remain private.
4. For any identified active deployment, follow the controlled source switch above: preserve its previous artifact and environment, connect to the reviewed public SHA only when authorized, then smoke-test before retiring the old connection. If no active deployment is positively confirmed, there is no deployment to recreate; publish source and preserve history only. An unknown deployment is not declared retired.
5. Once the old repository's automatic deployment trigger is absent or explicitly disabled, apply the prepared private README maintenance notice pointing to the public repository. Do not copy internal research, reuse notes, acceptance diaries, machine paths or raw Git history into public docs. Leave old branches/tags recoverable.
6. Archive the private repository only after explicit owner approval and successful backup verification; archive is not deletion. Do not infer that archiving GitHub stops deployed resources, and do not pause unknown cron/database/local services.
7. Rollback: keep the private repository private; unarchive only if approved and history access is needed. Roll back an active service to its preserved artifact/source/environment, not by force-pushing or reverting repository visibility. For a source-only change, fix/revert the public commit through normal review after rechecking automatic triggers; cloud resources and local data need no action.
