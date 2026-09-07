# protonvpn-wg-confgen

[![CI](https://github.com/hatemosphere/protonvpn-wg-confgen/actions/workflows/ci.yml/badge.svg)](https://github.com/hatemosphere/protonvpn-wg-confgen/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/hatemosphere/protonvpn-wg-confgen?include_prereleases)](https://github.com/hatemosphere/protonvpn-wg-confgen/releases/latest)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

Generate WireGuard configuration files for ProtonVPN from the command line, picking the best server in the countries you ask for. Headless-friendly: log in once, then rotate configs unattended.

## Motivation

I wanted to automatically rotate VPN servers on my private HTPC Linux host running WireGuard, and since I'm already paying for a Proton bundle subscription, why not just use theirs? Unfortunately, as of the time of writing, they didn't have a good programmatic headless way to generate WireGuard profiles, so I did my research and reverse-engineered their APIs (which was a pain in the butt) and created this. The idea is to run this code as a daemon and restart the WireGuard client on profile file change.

## Features

- Username/password login with SRP, including TOTP 2FA
- Session persistence and automatic refresh, so headless runs only need the password once
- Picks the best server using Proton's own Quick Connect metric (lowest `Score`, with `Load` as tiebreaker - lower is better per the official API)
- Filters by country, tier, P2P, and Secure Core, or targets one server by name
- Persistent configurations (visible in the ProtonVPN dashboard) or session-only ones that are never registered on the account
- VPN accelerator, NAT-PMP port forwarding, Moderate NAT, and IPv6
- Lists servers and registered configurations, and renews certificates without generating a new key pair

## Installation

Download a binary for your platform from the [latest release](https://github.com/hatemosphere/protonvpn-wg-confgen/releases/latest). Archives are named `protonvpn-wg-confgen_<version>_<os>_<arch>.tar.gz` (`.zip` on Windows) and are published with a `checksums.txt` (SHA-256):

```bash
tar xzf protonvpn-wg-confgen_*_linux_amd64.tar.gz
./protonvpn-wg-confgen -h
```

Or build from source (requires Go 1.26+):

```bash
git clone https://github.com/hatemosphere/protonvpn-wg-confgen
cd protonvpn-wg-confgen
make build          # produces ./build/protonvpn-wg-confgen
```

`make build` stamps the binary with the current ProtonVPN Linux client version, fetched from upstream at build time. A plain `go build` falls back to the version compiled into `internal/constants`. Advertising an outdated client version gets rejected by the API with code 5003, so prefer `make build`.

You will need a ProtonVPN account; a free one works, with the tier caveats noted below.

## Usage

```bash
protonvpn-wg-confgen -username <username> -countries <country-codes> [options]
protonvpn-wg-confgen -username <username> -server <server-name> [options]
protonvpn-wg-confgen -username <username> -list-servers [-countries <country-codes>]
protonvpn-wg-confgen -username <username> -list-configs
protonvpn-wg-confgen -username <username> -renew-serial <serial-number>
protonvpn-wg-confgen -username <username> -check-plan -json
```

`-username` is optional and prompted for when omitted, as is the password. Either `-countries` or `-server` is required when generating a configuration.

### Modes

| Flag | Description |
|------|-------------|
| *(default)* | Generate a WireGuard configuration |
| `-list-servers` | List available servers (country, name, city, load, score, tier, features) and exit. Honors `-countries`, `-secure-core`, `-p2p-only`, and `-free-only` |
| `-list-configs` | List persistent configurations on the account (SerialNumber, DeviceName, expiry, key fingerprint) and exit |
| `-renew-serial <serial>` | Renew a persistent certificate by SerialNumber, reusing its existing key. Extends it server-side and writes no `.conf` file |
| `-check-plan` | Check the saved session's account plan through Proton's authenticated settings API and exit. Does not prompt for a password or open a tunnel |
| `-speed-test` | Run the staged route comparison: ping every regional candidate, keep the twelve lowest-latency routes, validate all twelve tunnels, then measure up to six healthy routes |

### Server selection

| Flag | Default | Description |
|------|---------|-------------|
| `-countries` | | Comma-separated country codes, e.g. `US,NL,CH`. Always matches the **exit** country |
| `-server` | | Target one server by name, e.g. `UA#122`. Alternative to `-countries`, and bypasses the filters below |
| `-p2p-only` | `true` | Use only P2P-enabled servers |
| `-secure-core` | `false` | Use only Secure Core servers |
| `-free-only` | `false` | Use only Free tier servers |
| `-debug` | `false` | Print every server that survived filtering |

### Output and network

| Flag | Default | Description |
|------|---------|-------------|
| `-output` | `protonvpn.conf` | Output file path |
| `-device-name` | *(generated)* | Device name shown in the ProtonVPN dashboard |
| `-ipv6` | `false` | Enable IPv6 |
| `-dns` | *(per `-ipv6`)* | Comma-separated DNS servers |
| `-allowed-ips` | *(per `-ipv6`)* | Comma-separated allowed IPs |
| `-accelerator` | `true` | VPN accelerator |
| `-port-forwarding` | `false` | NAT-PMP port forwarding (Plus tier, P2P servers) |
| `-moderate-nat` | `false` | Moderate NAT (paid plans). Cannot be combined with `-port-forwarding` |

### Certificate and session

| Flag | Default | Description |
|------|---------|-------------|
| `-duration` | `365d` (`7d` with `-no-save`) | Certificate lifetime, e.g. `30m`, `24h`, `7d`, `1h30m`. Min `10m`, max `365d` (`7d` with `-no-save`) |
| `-no-save` | `false` | Issue a session-only certificate, never registered on the account |
| `-session-duration` | `0` | Session cache lifetime, e.g. `12h`, `7d`. `0` uses the API expiration. Max `30d` |
| `-clear-session` | `false` | Clear the saved session and re-authenticate |
| `-no-session` | `false` | Disable session persistence entirely |
| `-force-refresh` | `false` | Refresh the session even if it is not expiring soon |
| `-hv-token` | | Human verification token replayed after solving a CAPTCHA out of band, see below |
| `-api-url` | `https://vpn-api.proton.me` | ProtonVPN API base URL |

### Staged speed selection and terminal trace

The speed selector uses the same four stages as the GoLiveBypass dialog:

1. Measure ping for every eligible route in the regional scan.
2. Keep the twelve routes with the lowest measured ping (or deterministic fallbacks when ping is blocked).
3. Open a temporary userspace WireGuard tunnel for **all twelve** routes and make a zero-byte HTTPS request (up to four handshakes overlap; failures are retried serially); the first six healthy routes remain in ping order.
4. Measure download and upload sequentially on the six lowest-ping routes that passed the preflight. If a transfer fails, consume the next preflight-approved route until six valid measurements are available, then select the best result.

When the account is Premium and no country is selected, South American exits are promoted when their measured RTT is within 12 ms of the fastest route. A route with a clearly lower RTT still wins; an explicit country selection is always respected.

For a human-readable terminal run, add `-speed-test-trace`:

```bash
protonvpn-wg-confgen -username myusername -auto-ping -speed-test -speed-test-trace
```

The trace prints counters for ping, shortlist, tunnel preflight, and speed measurement to stderr. `-progress-json` remains available for machine-readable events; both outputs describe the same run.

## Examples

```bash
# Best P2P server across the US and Netherlands
protonvpn-wg-confgen -username myusername -countries US,NL

# Custom DNS and output path
protonvpn-wg-confgen -username myusername -countries CH,DE -dns 1.1.1.1,8.8.8.8 -output switzerland.conf

# A specific server, IPv6 enabled
protonvpn-wg-confgen -username myusername -server UA#122 -ipv6

# Secure Core, 30-day certificate
protonvpn-wg-confgen -username myusername -countries NL,US -secure-core -duration 30d

# Session-only config that never lands in the dashboard
protonvpn-wg-confgen -username myusername -countries US -no-save

# Port forwarding for P2P, or Moderate NAT for gaming (mutually exclusive)
protonvpn-wg-confgen -username myusername -countries NL -port-forwarding
protonvpn-wg-confgen -username myusername -countries NL -moderate-nat

# Free tier only, no session saved to disk
protonvpn-wg-confgen -username myusername -countries US,NL -free-only -no-session

# Inspect the same staged optimization flow used by the GUI
protonvpn-wg-confgen -username myusername -auto-ping -speed-test -speed-test-trace
```

Listing and maintenance:

```bash
protonvpn-wg-confgen -username myusername -list-servers -countries US,PL
protonvpn-wg-confgen -username myusername -list-servers -secure-core
protonvpn-wg-confgen -username myusername -list-configs
protonvpn-wg-confgen -username myusername -renew-serial "SERIAL12345"
```

## Persistent vs session-only configurations

Proton issues certificates in one of two modes.

**Persistent** (the default) registers a named configuration on your account. It appears in the ProtonVPN dashboard, is listed by `-list-configs`, can be renewed with `-renew-serial`, and accepts durations up to 365 days.

**Session-only** (`-no-save`) omits `Mode` and `DeviceName` from the request, which is what the official ProtonVPN clients do for an ordinary connection. The `.conf` file is written normally; only the account-side registration is skipped. Consequences:

- Absent from the dashboard and from `-list-configs`, which queries `Mode=persistent` only
- Cannot be renewed - generate a new configuration instead
- `-device-name` is ignored
- Capped at 7 days, which is also the default when `-duration` is omitted. Anything between `10m` and `7d` is honored exactly; longer values are rejected up front, because the API would otherwise silently clamp them to 7 days

Either way, the output reports what was actually issued and the expiry the API granted:

```
Certificate: session, expires 2026-08-05 11:13 UTC
```

### Revoking

Revoking is only possible through the [ProtonVPN web dashboard](https://account.proton.me/u/0/vpn/WireGuard). The API gates `DELETE /vpn/v1/certificate` behind the `full` session scope, which is granted to `account.proton.me` web and desktop logins but not to VPN API clients. Session-only certificates never appear there at all, so they can only be left to expire.

## Server tiers

Free tier servers are excluded unless you ask for them:

| Tier | Selected when | Notes |
|------|---------------|-------|
| Free (0) | `-free-only` | Limited selection, higher load, no P2P |
| Plus (2) | default | Full features, including P2P and Secure Core |
| Visionary (3) | default | Returned by the API for historical and bundle plans |

`-free-only` swaps the tier filter rather than widening it: it selects Free servers *exclusively*. It also disables P2P filtering, since Free servers do not support P2P.

## Secure Core

Secure Core routes traffic through a server in a privacy-friendly country before it exits in your chosen one, which protects against network-based attacks at the exit at the cost of latency.

- Entry countries are always Switzerland (CH), Iceland (IS), or Sweden (SE)
- `-countries` filters the **exit** country - where your traffic appears to come from
- Server names carry both ends, so `IS-NL#1` is Iceland -> Netherlands
- P2P filtering is disabled automatically, since Secure Core servers do not support P2P
- Requires a Plus or higher subscription

## IPv6

Configurations are IPv4-only by default. `-ipv6` additionally assigns the IPv6 interface address `2a07:b944::2:2/128`, adds Proton's internal IPv6 DNS `2a07:b944::2:1`, and routes `::/0`. Explicit `-dns` and `-allowed-ips` override these defaults.

## Authentication

This tool requires an account in [single password mode](https://proton.me/support/single-password), the default for new Proton accounts. Legacy 2-password accounts (separate login and mailbox passwords) must switch first.

**2FA is TOTP-only.** Authenticator apps work; FIDO2/WebAuthn security keys do not, because they need browser or platform APIs for the challenge-response protocol. If a security key is your only second factor, either add TOTP in your [account security settings](https://account.proton.me/u/0/vpn/account-password) or use a key that also does TOTP, such as a YubiKey with Yubico Authenticator.

### CAPTCHA (error 9001)

Proton challenges logins it considers automated, most often from datacenter/VPS
addresses or a machine already connected to a VPN. This is not specific to this
tool - the official clients hit the same challenge and solve it in an embedded
webview.

The challenge cannot be solved in a terminal, but it can be solved in a browser
and the result replayed with `-hv-token`. This flow is confirmed working.

On a 9001 the error prints the exact URL to open. The token to replay is **not**
the one in that URL: the widget emits `<challenge>:<solved-response>`, and that
whole colon-joined string is what the API accepts.

1. Open the URL from the error, `<api-url>/core/v4/captcha?Token=<challenge>`
2. Paste this in the browser console **before** solving. The page emits its
   result as a `postMessage`, and browser extensions post plenty of their own,
   so filter for Proton's:

   ```js
   window.addEventListener("message", e => {
     const t = e.data?.type
     if (t === "pm_captcha" || t === "proton_captcha")
       console.log("HV TOKEN:", e.data.token)
   })
   ```

3. Solve the CAPTCHA. The logged token looks like `zB2tiSsS...:RoIAZ83v...`
4. Re-run with the whole string, quoted - the response can contain `/`:

```bash
protonvpn-wg-confgen -username myusername -countries US -hv-token '<challenge>:<response>'
```

Challenge tokens expire, so if step 4 reports 9001 again, restart from the fresh
token in the new error.

The token travels as `x-pm-human-verification-token`, matching Proton's own
client. Only the `captcha` method is replayable this way; `email` and `sms`
deliver a code through a separate flow. Signing in once at account.proton.me
from the same network, or retrying from a residential connection, may also clear
the challenge.

### Session persistence

Sessions are stored in `~/.protonvpn-session.json` with `0600` permissions, verified before reuse, and tied to the username that created them.

- Proton sessions expire after 30 days (the API's `ExpiresIn`)
- `-session-duration` shortens that; values beyond the API's expiration are capped to it
- Sessions refresh automatically when fewer than 7 days remain
- `-clear-session`, `-force-refresh`, and `-no-session` override the defaults

## Using the generated configuration

On Linux and macOS:

```bash
sudo wg-quick up ./protonvpn.conf
```

On Windows or any GUI client, import the file.

## Security notes

- A fresh WireGuard keypair is generated on every run, except with `-renew-serial`, which reuses the existing key
- Configuration files hold your private key and are written with `0600` permissions - never share them
- Persistent configurations can be revoked from the dashboard; session-only ones cannot be revoked at all and simply expire within 7 days

## Project structure

```
.
├── cmd/
│   └── protonvpn-wg/
│       └── main.go         # CLI entry point + command dispatch
├── internal/
│   ├── api/
│   │   ├── types.go        # ProtonVPN API request/response types
│   │   └── transport.go    # Shared request building and JSON response handling
│   ├── auth/
│   │   ├── auth.go         # SRP authentication
│   │   ├── errors.go       # API error codes and types
│   │   └── session.go      # Session persistence, refresh, verify
│   ├── config/
│   │   ├── flags.go        # Command-line flag parsing and validation
│   │   └── types.go        # Config struct
│   ├── constants/
│   │   ├── api.go          # API endpoints and version headers
│   │   ├── defaults.go     # Certificate/selection defaults
│   │   ├── session.go      # Session persistence constants
│   │   └── wireguard.go    # WireGuard network defaults
│   ├── timeutil/
│   │   ├── duration.go     # Human-readable duration formatting
│   │   └── parser.go       # Duration parsing
│   ├── validation/
│   │   └── username.go     # Username and country-code validation
│   ├── vpn/
│   │   ├── client.go       # Certificate create + list + server fetch
│   │   └── servers.go      # Server filtering and selection
│   └── wireguard/
│       └── config.go       # .conf file generation
├── Makefile
├── go.mod
├── go.sum
└── README.md
```

See [API_REFERENCE.md](API_REFERENCE.md) for the reverse-engineered API details: endpoints, request formats, response codes, and the measured certificate duration bounds.

## Development

```bash
make build          # build with the current upstream client version
make test           # run tests
make fmt vet lint   # format, vet, lint
make show-version   # print the ProtonVPN client version that would be stamped in
```

## License

GPL-3.0. See [LICENSE](LICENSE).
