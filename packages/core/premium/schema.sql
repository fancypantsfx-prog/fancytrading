CREATE TABLE IF NOT EXISTS premium_grants (
    feature TEXT NOT NULL,
    account_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (feature, account_id)
);

CREATE TABLE IF NOT EXISTS premium_previews (
    feature TEXT PRIMARY KEY NOT NULL,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL CHECK (ends_at > starts_at)
);
