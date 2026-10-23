-- Initial schema for InSales partner application.
-- Stores, install candidates, login challenges, sessions.

CREATE TABLE IF NOT EXISTS stores (
    id TEXT NOT NULL PRIMARY KEY,           -- insales_id from InSales
    shop TEXT NOT NULL UNIQUE,               -- canonical shop domain
    password TEXT NOT NULL,                   -- AES-256-GCM encrypted credential
    title TEXT NOT NULL DEFAULT '',           -- store title from account.json
    generation INTEGER NOT NULL DEFAULT 1,    -- monotonically increasing generation
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS install_candidates (
    id TEXT NOT NULL PRIMARY KEY,             -- candidate ID (random)
    store_id TEXT NOT NULL,                    -- claimed insales_id
    shop TEXT NOT NULL,                        -- claimed shop domain
    password TEXT NOT NULL,                    -- encrypted candidate credential
    generation INT NOT NULL DEFAULT 0,         -- generation when created (0 = pending)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,                  -- TTL
    diagnostic TEXT DEFAULT NULL               -- diagnostic code after verification attempt
);

CREATE TABLE IF NOT EXISTS login_challenges (
    id TEXT NOT NULL PRIMARY KEY,             -- challenge ID (random nonce storage ID)
    store_id TEXT NOT NULL,                    -- store this challenge is for
    nonce TEXT NOT NULL,                       -- crypto random nonce sent to InSales
    generation INTEGER NOT NULL,               -- store generation at challenge creation
    browser_binding TEXT NOT NULL,             -- HttpOnly cookie value for browser binding
    expires_at TEXT NOT NULL,                  -- TTL
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT NOT NULL PRIMARY KEY,             -- session ID (crypto random)
    store_id TEXT NOT NULL,                    -- authenticated store
    user_id TEXT NOT NULL,                     -- InSales employee ID
    generation INTEGER NOT NULL,               -- store generation at session creation
    expires_at TEXT NOT NULL,                  -- session TTL
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_install_candidates_shop ON install_candidates(shop);
CREATE INDEX IF NOT EXISTS idx_login_challenges_store ON login_challenges(store_id);
CREATE INDEX IF NOT EXISTS idx_login_challenges_nonce ON login_challenges(nonce);
CREATE INDEX IF NOT EXISTS idx_sessions_store ON sessions(store_id);

-- Generation tracking: a simple monotonic counter that persists
-- across store creation/deletion cycles.
CREATE TABLE IF NOT EXISTS generation_counter (
    id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    counter INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO generation_counter (id, counter) VALUES (1, 0);