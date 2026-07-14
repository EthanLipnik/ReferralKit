CREATE TABLE registration_challenges (
    id TEXT PRIMARY KEY,
    identity_family_hash TEXT NOT NULL,
    public_key_hash TEXT NOT NULL,
    attribute_key TEXT NOT NULL,
    attribute_value_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX registration_challenges_lookup
    ON registration_challenges(identity_family_hash, public_key_hash, expires_at);
