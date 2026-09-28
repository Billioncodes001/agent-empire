# APP-01: device tokens and app-origin CORS

Branch `claude/app-device-auth`. Server lane only: `src/server/devices.ts` (new), `src/server/server.ts`, `src/server/relay.ts` (after review), `tests/device-auth.test.ts`. No changes to `src/shared`, `src/client`, `mobile/` or `desktop/`, and no new dependencies.

## API

| Call | Auth | Result |
| --- | --- | --- |
| `POST /api/device/login {password, deviceName}` | none | `200 {token, deviceId}`. `401` wrong password, `400` bad body, `429` rate limited, `409` at the 100-device limit. No cookie is set |
| `GET /api/devices` | cookie or bearer | `{devices: [{id, name, createdAt, lastUsedAt, current}]}`. `current` marks the calling device. No hashes |
| `DELETE /api/devices/:id` | cookie (same-origin) or bearer | `200 {ok:true}` or `404`. If the change can't be saved: `500`, and the device stays signed in. Either way, that device's open WebSockets are closed (code `4401`) |
| `GET /api/whoami` | cookie or bearer | Unchanged for cookies. Bearer responses add `deviceId` |

Token use:

- HTTP: `Authorization: Bearer <token>` is accepted everywhere the session cookie is, including authenticated pages and files.
- WebSocket: offer the subprotocols `["empire.v1", "bearer.<token>"]`. The handshake answers `Sec-WebSocket-Protocol: empire.v1` only. The token is never echoed back.
- Tokens are never read from the query string.

`APP_ORIGINS` and `WS_PROTOCOL` are exported from `src/server/server.ts`.

## Security reasoning

- **Token.** 32 random bytes, base64url (43 characters). `devices.json` in the office data dir holds only `HMAC-SHA256(key, token)`. The key is `HMAC(secret, "device-token:" + password verifier)`. The file uses `writeJsonAtomic`: mode 0600, written to a temp file then renamed. A leaked store file can't be replayed as tokens.
- **Rotation.** A new password or secret changes the key, so no stored hash matches any more. The file records a key fingerprint (`keyId`). At startup, stale entries are dropped so Settings doesn't list dead devices. An unreadable store fails closed: every device is signed out.
- **Sign-in.** Device login uses the same `auth.allowAttempt(ip)` budget as `/api/login` and `/api/claim`: 10 attempts per 5 minutes per client, shared across all three. It uses the same scrypt check and resets the budget on success.
- **CSRF.** Browsers never attach a Bearer header on their own, so bearer requests skip the same-origin Origin check. Only the `Bearer` scheme counts. Any other `Authorization` header, such as a reverse proxy's Basic auth, leaves cookie auth exactly as it was. When a Bearer header is sent, only the token is checked; the cookie is ignored. Cookie mutations still need a same-origin Origin. That covers cookie requests from the app origins too.
- **CORS.** Only `empire-app://game` and `https://appassets.androidplatform.net` get CORS headers, and only as an exact match. The server answers their `OPTIONS` preflight with `204`, allowing `Authorization, Content-Type` and `GET, POST, PUT, DELETE, OPTIONS`. `Access-Control-Allow-Origin` is reflected for those origins only in these cases:
  - the request carries a Bearer header;
  - the request is `/api/device/login`;
  - the request is `/api/health`.

  `Access-Control-Allow-Credentials` is never sent, so cookie responses can't be read cross-origin. Every other origin behaves as before.
- **WebSocket.** Cookie connections behave exactly as before: `/ws`, a valid cookie and the same origin. A bearer connection has three requirements:
  - `empire.v1` must be offered, with exactly one `bearer.` entry;
  - the token must be valid;
  - the Origin must be absent, the office's own, or one of `APP_ORIGINS`. A token offered from any other site's page is refused.

  An app origin with no valid token gets `401`. `handleProtocols` only ever selects `empire.v1`, so a token entry can never be chosen and echoed.
- **Service tunnels.** The relay (`tunneledPort`) is still cookie-only. It doesn't accept bearer tokens. The first version wrongly said a token could never reach a worker's server: in fact `upstreamHeaders` forwarded `Authorization: Bearer …` and the `bearer.<token>` subprotocol. Since review, the relay strips a Bearer `Authorization` header and every `bearer.*` subprotocol entry, as well as the office cookies. Other Authorization schemes and subprotocols still pass through. One side effect: a worker dev server that relies on its own Bearer header from the browser won't get it through a service tunnel.
- **Revoking.** Closing a socket only starts the closing handshake. Messages from a socket that is no longer OPEN are dropped, and a revoked device's sockets are terminated after 1 second, so a peer that ignores the close frame can't keep acting.
- **Persistence.** `issue` and `revoke` write the new list first and change memory only if the write succeeds. A failed issue leaves no dead entry. A failed revoke returns `500` and the device stays signed in, so a restart can't bring back a device the user was told was removed. Its sockets are closed regardless.
- **App origins are not app attestation.** `Origin` only helps against browser pages. Any non-browser client can send `empire-app://game`. The origin rules are defense in depth; the device token is the real credential.
- **Devices have full power.** A device token has the same power as a browser session, including revoking other devices and the browser's own sign-in path. The Settings UI should show revocations and which device made them.
- **Device names.** Control and bidi-override characters are removed, whitespace is collapsed, names are capped at 64 characters and default to "Device".
- **`lastUsedAt`.** Updated in memory on every use and written at most every 10 minutes per device, plus a flush on shutdown.

## Tests

`tests/device-auth.test.ts` has 16 tests. Each starts a real server on an ephemeral port with a temp data dir and fake workers; nothing launches. They cover:

- login success and failure, and that device login sets no cookie;
- the rate limit shared between cookie and device login;
- a bearer GET, and a bearer POST without Origin;
- a cookie POST without the same origin still gets `403`, including from an app origin;
- Basic auth doesn't displace the cookie;
- query-string tokens are rejected on HTTP and WebSocket;
- listing has no hashes and marks the current device;
- revocation, which rejects the token and closes the device's live socket;
- the store file holds hashes only, with mode 0600;
- CORS preflight is granted to both app origins and absent for others (look-alike origins and `null` included), with no credentials header;
- WebSocket from both app origins returns exactly `empire.v1` in the handshake and receives `welcome`;
- WebSocket without a token, with a bad token, with a token but no `empire.v1`, with several tokens, cookie-only from an app origin, or with a token from a foreign origin is rejected;
- the cookie WebSocket from the same origin still works;
- tokens survive a restart, and a secret or password rotation invalidates them;
- after review:
  - a raw WebSocket client that ignores the close frame gets no effective message through after revoke and is terminated. A cookie observer confirms that chat sent before the revoke arrives and chat sent after it doesn't. With the fix removed, this test fails;
  - with an injected failing writer, the store doesn't keep a device whose issue failed, and a revoke that fails leaves memory and disk the same;
  - with a read-only data dir, `DELETE` returns `500` and still closes the device's socket, and revoking again once the dir is writable succeeds;
  - `upstreamHeaders` removes Bearer auth, `bearer.*` subprotocols and office cookies, and keeps Basic auth and the other subprotocols.

Checks after review fixes: `npm run typecheck` passes. `npm test`: 217 of 217 pass. `npm run build` passes.

## Limits and follow-ups

- There's no token expiry; tokens last until revoked or rotated, as the contract says. There's no per-device scope; a device has the same power as a browser session.
- The client side (APP-02 `net.ts`) and the Settings UI for listing and revoking devices aren't built yet.
- Desktop (APP-05): if the bundled Electron client connects with an Origin that isn't absent, same-origin or in `APP_ORIGINS`, the WebSocket is refused. Its origin would have to be added to `APP_ORIGINS`.
- Rate limiting is per client IP and in memory, the same as cookie login. Behind a proxy it depends on `--trust-proxy`.
- A reverse proxy that uses the `Bearer` scheme for its own auth would conflict with device tokens. None is known in current deployments.
