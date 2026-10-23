-- Candidate order is reserved at insert time and is distinct from the
-- timestamp. Pending rows of the previous schema all stored generation = 0,
-- so their order cannot be recovered. They are cancelled. Active stores,
-- their sessions and the generation counter stay. A shop that only had a
-- pending install must be installed again.
--
-- The counter is raised to the highest active generation and is not reset
-- when a store row disappears.

DELETE FROM install_candidates;

CREATE TABLE install_candidates_next (
    id TEXT NOT NULL PRIMARY KEY,
    store_id TEXT NOT NULL,
    shop TEXT NOT NULL,
    password TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    diagnostic TEXT DEFAULT NULL
);

DROP TABLE install_candidates;
ALTER TABLE install_candidates_next RENAME TO install_candidates;

CREATE INDEX IF NOT EXISTS idx_install_candidates_shop ON install_candidates(shop);
CREATE INDEX IF NOT EXISTS idx_install_candidates_ordinal ON install_candidates(ordinal);

UPDATE generation_counter
SET counter = MAX(counter, COALESCE((SELECT MAX(generation) FROM stores), 0))
WHERE id = 1;
