-- The migration runner updates D1 before replacing the active Worker. These
-- triggers keep writes from the previous Worker version valid during that
-- deployment window, while the repeated backfill closes the gap between 0003
-- and this migration.
UPDATE referrals
SET claim_expires_at = CASE
    WHEN status IN ('redeemed','rejected','expired') THEN claimed_at
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+24 hours')
END
WHERE claim_expires_at IS NULL;

CREATE TRIGGER referrals_fill_claim_expiry
AFTER INSERT ON referrals
WHEN NEW.claim_expires_at IS NULL
BEGIN
    UPDATE referrals
    SET claim_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.claimed_at, '+24 hours')
    WHERE id = NEW.id;
END;

UPDATE redemptions
SET reconciliation_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+30 days')
WHERE reconciliation_expires_at IS NULL;

CREATE TRIGGER redemptions_fill_reconciliation_expiry
AFTER INSERT ON redemptions
WHEN NEW.reconciliation_expires_at IS NULL
BEGIN
    UPDATE redemptions
    SET reconciliation_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.expires_at, '+30 days')
    WHERE id = NEW.id;
END;
