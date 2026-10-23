# Security Policy

## Encryption

Store passwords are encrypted with AES-256-GCM. Each value has its own random 16-byte IV and a 16-byte authentication tag.

AAD binds the ciphertext to the shop domain, insales id and purpose (`store` or `candidate`). `APP_ENCRYPTION_KEY` is 32 bytes, supplied as 64 hex characters. Generate it with `npm run dev:keygen` or `node dist/cli.js keygen`. Keep it outside the database and the logs.

The application does not re-encrypt stored credentials when the key changes. A wrong or damaged key fails decryption with a fixed message. The process does not create a session and does not print the key, the ciphertext or the password.

## Credential storage

SQLite stores ciphertext. The plaintext password exists in memory only while a request or API call uses the copy taken with that generation.

There is no uninstall tombstone and no HMAC of a removed password. A repeated uninstall of an already removed connection is an empty success. A later install with a new token is a new connection. After deletion, the application cannot tell a replay of the old password from a password it has never stored.

The ordinal counter increases and is not reset when a store row is deleted.

## Installation order

A candidate receives its ordinal in the same write transaction as the insert. Activation locks the row again and checks that the candidate still exists, has not expired and is newer than the active generation. A late success for an older candidate does not replace a newer confirmed connection, including its title and password. An unverified newer candidate does not revoke the active sessions and does not by itself block a candidate that is still allowed to finish.

Migration `002_candidate_ordinal.sql` keeps active stores and their sessions. Pending rows from the previous schema had no recoverable order, so the migration cancels them. A shop that was only pending must be installed again.

## Authentication

Install password and token3 use MD5 because that is the InSales protocol. New application secrets do not use MD5.

token3 is compared with `crypto.timingSafeEqual` after the hex format is checked. Session ids and the login nonce come from `crypto.randomBytes`.

`/login` does not create a session. After a valid signature, one transaction re-reads the active generation, consumes the challenge and inserts the session. Two callbacks for one challenge create one session. A connection that was removed or replaced after the signature check does not receive a session of the old generation.

## Sessions and challenges

Session TTL is 1 hour. Login challenge TTL is 5 minutes. Pending install TTL is 7 days. These values are fixed in the source, not environment settings.

A challenge is bound to the browser cookie, the store and the generation. A protected request reads session, store, generation and credential together. The API client is built from that object. A later install does not hand its password to a request that already passed the check. The password is omitted from `JSON.stringify` and from `util.inspect` of the context.

A new password replaces the active connection and deletes that store's sessions and challenges in the same transaction. Repeating the already active password does not change the generation and does not delete sessions.

Logout is `POST /logout`. The CSRF hook runs after the form body is parsed. A missing or invalid `_csrf` value does not delete the session.

## HTTP responses

Cookies are `HttpOnly` and `SameSite=Lax`, with an explicit `Path` and `Max-Age`. `Secure` is added when `APP_BASE_URL` is HTTPS.

`/`, `/probe`, `/login`, `/autologin`, `/install`, `/uninstall` and `/logout` send `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

The access log keeps the request path and drops the query, so install passwords and token3 are not written as part of the incoming-request line. Reverse proxies must do the same.

Install and uninstall stay GET, as the InSales protocol requires. They are limited by the shop allowlist and by comparing the uninstall value with the stored password.

The default rate limit is 100 requests per minute per client IP. Behind a proxy, set `TRUST_PROXY` to that proxy's address or CIDR. `true`, `*` and a bare hop count are rejected.

## API client

`ApiError` is an HTTP status the operation does not treat as success. `TransportError` is DNS, connection, timeout or a path rejected before the request. `ResponseError` is JSON or a required field that does not match the operation. Messages do not include the response body, the Basic secret or the store password. Status, `API-Usage-Limit` and `Retry-After` stay on `ApiError`. Its diagnostic `body` is limited to 64 KiB; `data` contains parsed JSON when available. Both are private-backed getters and are omitted from default serialization.

Production calls use HTTPS and verify the certificate. `LOCAL_DEMO=true` allows HTTP only to a loopback address, and only when `APP_ENV` is not `production`. Redirects are not followed. There is no automatic retry. A timed-out PUT or POST has an unknown result.

The 5 second deadline covers headers and the body. The body is counted while it is read and the read stops when it passes 2 000 000 bytes.

A candidate is deleted when the account id does not match or the API returns 401 or 403. Invalid JSON, timeouts, network errors, 429 and 5xx keep the candidate until its TTL. If there is no active connection yet, that temporary failure is HTTP 503 on login.

## Database and process

SQLite WAL with a 3 second busy timeout. Lifecycle changes run in explicit transactions. The runtime directory is created with mode `0700`. Foreign keys are enabled.

Copying a single open SQLite file is not a backup, because the WAL sidecar can hold the latest pages. Use the SQLite backup API or copy the database together with its sidecar files while the process is stopped. Keep the same encryption key.

`SIGTERM` and `SIGINT` are handled by the server process. Closing the HTTP server closes the database. If shutdown takes longer than 10 seconds, the process exits with code 1.

## Dependencies

CI runs `npm audit --audit-level=high`. High and critical advisories fail the job. Moderate and low advisories are reviewed in the Dependabot pull requests. Do not use `npm audit fix --force`.

## Reporting

Report a vulnerability to the repository maintainer. Do not publish it before it is fixed.
