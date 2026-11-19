# API Reference Implementation

This project's API integration was developed by reverse-engineering ProtonVPN's authentication and VPN APIs. The implementation is based on patterns from these official Proton libraries:

## Authentication (SRP Protocol)
- **[ProtonMail/proton-python-client](https://github.com/ProtonMail/proton-python-client)** - Python implementation of Proton's SRP authentication
  - Reference for: `/auth/info`, `/auth`, `/auth/2fa`, `/auth/refresh` endpoints
  - SRP protocol implementation patterns
- **[ProtonMail/go-srp](https://github.com/ProtonMail/go-srp)** - Go SRP library (direct dependency)

## VPN API
- **[ProtonVPN/python-proton-vpn-api-core](https://github.com/ProtonVPN/python-proton-vpn-api-core)** - Official Python VPN API client
  - Reference for: `/vpn/v1/certificate`, `/vpn/v1/logicals`, `/vpn/v1/sessions` endpoints
  - Server filtering and selection patterns
  - Certificate request format (`Duration`, `Features`)

## Key Generation
- **[ProtonVPN/go-vpn-lib](https://github.com/ProtonVPN/go-vpn-lib)** - Ed25519 to X25519 key conversion (direct dependency)

## Client Version
- **[ProtonVPN/proton-vpn-gtk-app](https://github.com/ProtonVPN/proton-vpn-gtk-app)** - Official Linux client
  - Sends python-proton-vpn-api-core's version in `x-pm-appversion` and `User-Agent`, not its own (both headers are built by `SessionHolder` in api-core's `proton/vpn/core/session_holder.py`)
- **[python-proton-vpn-api-core `versions.yml`](https://raw.githubusercontent.com/ProtonVPN/python-proton-vpn-api-core/stable/versions.yml)** - Source for that version (`ClientVersion`, fetched dynamically by `make build`)

## API Endpoints Used

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/core/v4/auth/info` | POST | Get SRP authentication parameters |
| `/core/v4/auth` | POST | Authenticate with SRP proofs |
| `/core/v4/auth/2fa` | POST | Submit 2FA code for session upgrade |
| `/auth/refresh` | POST | Refresh session tokens |
| `/vpn/v1/certificate` | POST | Generate WireGuard certificate |
| `/vpn/v1/logicals` | GET | List available VPN servers |

## Certificate Request Format

The certificate request to `/vpn/v1/certificate` uses the following format:

```json
{
  "ClientPublicKey": "<PEM-encoded public key>",
  "ClientPublicKeyMode": "EC",
  "Mode": "persistent",
  "DeviceName": "<device name>",
  "Duration": "<duration in minutes> min",
  "Features": {
    "NetShieldLevel": 0,
    "RandomNAT": false,
    "PortForwarding": false,
    "SplitTCP": true
  }
}
```

`Mode` is one of `session` or `persistent` (see `WireGuardConfigurationSection/Certificate.ts` in WebClients). Omitting it - as the official Linux client does for every connection - yields a session certificate: not registered on the account and absent from `GET /vpn/v1/certificate/all?Mode=persistent`. `persistent` backs the dashboard's saved configuration list, which is the only place such configs can be revoked.

`Duration` is a request, not a guarantee; the granted expiry is returned as `ExpirationTime`. Observed against the live API (2026-07-29):

| Mode | Requested | Granted |
|------|-----------|---------|
| session | 9 min or less | error, code 2001 `Certificate duration must be at least 10 minutes` |
| session | 10m / 30m / 8h / 3d / 10080m (7d) | honored exactly |
| session | 10081m / 8d / 30d / 365d | 10080m (7d), silently clamped with no error |
| persistent | 365d | 365d |

So session certificates are bounded at [10 min, 7 days]. The lower bound is enforced with a real error; the upper bound is a silent clamp, which is why this client rejects `-duration` over 7d when `-no-save` is set rather than letting a 365d request quietly become 7d.

Note that the "the API does not allow intervals shorter than 1 day" comment in `python-proton-vpn-api-core`'s `fetcher.py` does not hold - sub-day durations are accepted down to 10 minutes. Likewise its 7-day `VPNPubkeyCredentials.REFRESH_INTERVAL` is that client's own refresh cadence and coincides with, but does not explain, the server-side cap.

### Feature Keys

| Key | Type | Description |
|-----|------|-------------|
| `NetShieldLevel` | int | NetShield ad/malware blocking (0=off, 1=malware, 2=ads+malware) |
| `RandomNAT` | bool | Moderate NAT / Random NAT for gaming |
| `PortForwarding` | bool | Port forwarding support |
| `SplitTCP` | bool | VPN Accelerator (performance optimization) |

## API Response Codes

**Official sources:**
- [ProtonMail/protoncore_android - ResponseCodes.kt](https://github.com/ProtonMail/protoncore_android/blob/main/network/domain/src/main/kotlin/me/proton/core/network/domain/ResponseCodes.kt) - Kotlin constants (authoritative)
- [ProtonMail/proton-python-client - README.md](https://github.com/ProtonMail/proton-python-client#error-handling) - Python client error handling
- [ProtonMail/proton-python-client - api.py](https://github.com/ProtonMail/proton-python-client/blob/master/proton/api.py) - Python API implementation

### Success Codes
| Code | Constant | Meaning |
|------|----------|---------|
| 1000 | OK | Success |
| 1001 | - | Success (multi-status) |

### Authentication Errors
| Code | Constant | Meaning |
|------|----------|---------|
| 8002 | PASSWORD_WRONG | Incorrect password |
| 8100 | AUTH_SWITCH_TO_SSO | Switch to SSO authentication |
| 8101 | AUTH_SWITCH_TO_SRP | Switch to SRP authentication |
| 9001 | HUMAN_VERIFICATION_REQUIRED | CAPTCHA/human verification required |
| 9002 | DEVICE_VERIFICATION_REQUIRED | Device verification required |
| 9101 | SCOPE_REAUTH_LOCKED | Scope re-authentication locked |
| 9102 | SCOPE_REAUTH_PASSWORD | Scope re-authentication requires password |

### Account Errors
| Code | Constant | Meaning |
|------|----------|---------|
| 10001 | ACCOUNT_FAILED_GENERIC | Generic account failure |
| 10002 | ACCOUNT_DELETED | Account has been deleted |
| 10003 | ACCOUNT_DISABLED | Account has been disabled |

### Version Errors
| Code | Constant | Meaning |
|------|----------|---------|
| 5003 | APP_VERSION_BAD | App version no longer supported |
| 5005 | API_VERSION_INVALID | API version invalid |
| 5099 | APP_VERSION_NOT_SUPPORTED_FOR_EXTERNAL_ACCOUNTS | App version not supported for external accounts |

5003 comes back as HTTP 422 with `This version of the app is no longer supported` once Proton stops accepting the `x-pm-appversion` sent. Observed 2026-11-19 on `GET /vpn/v2/clientconfig`: `linux-vpn@4.17.2`, which this tool sent until then, gets 5003, while `linux-vpn-gui@6.1.2+x86-64` gets 1000. The fix is to bump `ClientVersion` to the latest python-proton-vpn-api-core version (see [Required Headers](#required-headers)).

protoncore_android groups 5003 and 5005 as `ResponseCodes.FORCE_UPDATE`. [go-proton-api](https://github.com/ProtonMail/go-proton-api/blob/master/response.go) also defines 5001 (`AppVersionMissingCode`) for a missing `x-pm-appversion`. The helper reports 5001, 5003 and 5005 as `AppVersionError` (JSON `code` `APP_VERSION_UNSUPPORTED`; 5003 has been observed with HTTP 422) and never deletes the saved session because of them: they reject the client version, not the session.

### Other Errors
| Code | Constant | Meaning |
|------|----------|---------|
| 6001 | BODY_PARSE_FAILURE | Request body parse failure |
| 12081 | USER_CREATE_NAME_INVALID | Invalid username during creation |
| 12087 | USER_CREATE_TOKEN_INVALID | Invalid token during user creation |

### VPN-Specific Codes (observed, not in official docs)
| Code | Meaning | Notes |
|------|---------|-------|
| 9100 | 2FA required for VPN | VPN certificate endpoint requires 2FA-authenticated session |
| 10013 | Mailbox password required | Legacy 2-password mode (proton-python-client says "RefreshToken invalid") |

**Note:** Codes 9100 and 10013 were observed during VPN operations but are not documented in the official protoncore_android library. Their meanings may vary by context.

## Required Headers

All authenticated requests require these headers:

```
Authorization: Bearer <access_token>
x-pm-uid: <session_uid>
x-pm-appversion: linux-vpn-gui@X.Y.Z+<arch>
User-Agent: ProtonVPN/X.Y.Z (Linux; ubuntu/26.04)
Content-Type: application/json
```

`X.Y.Z` is the python-proton-vpn-api-core version in `ClientVersion` (`internal/constants/api.go`), and `<arch>` is the CPU architecture the way the official client spells it (Python's `platform.machine()` with `_` turned into `-`), mapped from `GOARCH`: `amd64` -> `x86-64`, `arm64` -> `aarch64`, `arm` -> `armv7l`, anything else as-is. On x86-64 that is `linux-vpn-gui@6.1.2+x86-64` and `ProtonVPN/6.1.2 (Linux; ubuntu/26.04)`; the official client puts its own distribution there, this tool always sends `ubuntu/26.04`. Both values are derived from `ClientVersion` at startup. `AppVersion` and `UserAgent` can still be overridden whole with `-X`, but the normal way is to override only `ClientVersion`.

**Important**: Using a web client version (like `web-vpn-settings@X.Y.Z`) may trigger CAPTCHA challenges. Always use the Linux client version format. `linux-vpn@4.17.2`, which this tool sent until 2026-11-19, is now rejected with code 5003.

## Token Refresh

The token refresh endpoint expects:

```json
{
  "ResponseType": "token",
  "GrantType": "refresh_token",
  "RefreshToken": "<refresh_token>",
  "RedirectURI": "http://protonmail.ch"
}
```

## Local Reference Libraries

For debugging and verification, reference implementations are cloned in `.debug-libs/`:
- `proton-python-client` - SRP authentication reference
- `python-proton-vpn-api-core` - VPN API reference
- `proton-vpn-gtk-app` - Linux client reference
