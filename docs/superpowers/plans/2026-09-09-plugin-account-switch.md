# Plugin account-switch profile invalidation plan

**Goal:** Prevent a Proton account switch from reusing a WireGuard profile generated for a different account.

**Scope:** `goLiveBypass/vpn-controller.ts` and plugin source tests only. Preserve custom profiles, external WireSock ownership, and the existing no-relaunch login contract.

## Acceptance criteria

- A successful Proton login for another account cannot leave an active plugin VPN using the previous account's profile.
- When the owned VPN is active, account switching returns a recoverable error and does not change the session or route.
- A Proton profile is regenerated when its private metadata marker is absent or belongs to another account.
- Importing a custom `.conf` invalidates Proton profile metadata without requiring Proton credentials.
- External WireSock is never stopped, adopted, or killed by the account-switch path.

## Verification

- Source regression for serialized login, active-route guard, account marker validation, and custom-profile invalidation.
- All `tests/test-plugin-*.mjs`, `go test ./...` in `tools/proton-confgen/`, userplugin E2E, and `git diff --check`.
- Windows VM package type-check/build; no injection or route activation while the authorized Discord call remains active.

## Status

Implementado e validado em 2026-09-09: regressão 6/6, suíte completa do plugin,
helper Proton, E2E 51/51, compilação Windows x64 do plugin e `testTsc`/`build` do
Vencord. A troca real de conta e a ativação em runtime ficaram pendentes porque a
call/transmissão autorizada permaneceu ativa.
