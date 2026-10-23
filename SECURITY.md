# Security Policy

## Encryption

- Store passwords are encrypted with **AES-256-GCM** using a unique random 16-byte IV per encryption.
- The authentication tag is 16 bytes.
- **AAD** binds the ciphertext to the shop domain, insales_id and purpose (`store` or `candidate`).
- `APP_ENCRYPTION_KEY` is 32 bytes, supplied as 64 hex characters. Generate it with `npm run keygen` and keep it outside the database and the logs.
- Changing the key requires re-encrypting stored credentials. v1 does not rotate them automatically.

## Credential storage

- SQLite stores only ciphertext. The plaintext password exists in memory while a request uses it.
- v1 does not keep an uninstall tombstone or an HMAC fingerprint of a removed password. A repeated uninstall of an already removed connection is an empty success. A later install with a new token is a new connection. After deletion, the application cannot tell a replay of the old password from a password it has never stored.
- The generation counter increases and is not reset when a store row is deleted.

## Authentication

- Install password and token3 use MD5 because that is the InSales protocol. New application secrets do not use MD5.
- token3 is compared with `crypto.timingSafeEqual` after the hex format is checked.
- Session ids and the login nonce come from `crypto.randomBytes`.
- `/login` does not create a session. The session appears only after a valid token3 and consumption of the challenge.

## Sessions and challenges

- Session TTL is 1 hour. Login challenge TTL is 5 minutes. Pending install TTL is 7 days. These values are fixed in v1, not environment settings.
- A challenge is bound to the browser cookie, the store and the generation. Consuming it is one transaction, and a second callback does not create a second session.
- A new password replaces the active connection and deletes that store's sessions and challenges in the same transaction. Repeating the already active password does not change the generation and does not delete sessions.
- Logout is `POST /logout`. The CSRF hook runs after the form body is parsed. A missing or invalid `_csrf` value does not delete the session.

## HTTP responses

- Cookies are `HttpOnly` and `SameSite=Lax`, with an explicit `Path` and `Max-Age`. `Secure` is added when `APP_BASE_URL` is HTTPS.
- `/`, `/probe`, `/login`, `/autologin`, `/install`, `/uninstall` and `/logout` send `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- The access log is configured on the Fastify logger itself. The request serializer keeps the path and drops the query, so install passwords and token3 are not written as part of the incoming-request line.
- Install and uninstall stay GET, as the InSales protocol requires. They are limited by the shop allowlist and by comparing the uninstall value with the stored password.
- The default rate limit is 100 requests per minute per client IP. Behind a proxy, set `TRUST_PROXY` to that proxy's address or CIDR. `true`, `*` and a bare hop count are rejected. Without a matching proxy address, every client shares the proxy's IP and therefore one limit.

## API client

- Production calls use HTTPS and verify the certificate.
- `LOCAL_DEMO=true` allows HTTP only to a loopback address, and only when `APP_ENV` is not `production`. Other private destinations stay blocked.
- The address check runs inside the connection step on the address that will be used. It covers IPv4, IPv6, IPv4-mapped IPv6 and a lookup result that changes between requests. Each API call resolves at connect time and does not reuse another shop's connection.
- Basic credentials are sent in the `Authorization` header. Redirects are not followed.
- The 5 second deadline covers headers and the body. The body is counted while it is read and the read stops when it passes 2 MB, before the rest is buffered.
- A candidate is deleted when the account id does not match or the API returns 401 or 403. Invalid JSON, timeouts, network errors, 429 and 5xx keep the candidate until its TTL. If there is no active connection yet, that temporary failure is HTTP 503.

## Database

- SQLite WAL with a 3 second busy timeout. Lifecycle changes run in explicit transactions.
- The runtime directory is created with mode `0700`.
- Foreign keys are enabled.

## Deployment

- Terminate HTTPS on a reverse proxy you operate.
- Keep `APP_ENCRYPTION_KEY` in the environment or a secret manager, not in the repository.
- Back up the SQLite file and encrypt the disk that holds the runtime directory.

## Reporting

Report a vulnerability to the repository maintainer. Do not publish it before it is fixed.
