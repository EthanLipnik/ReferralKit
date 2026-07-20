ALTER TABLE referrals ADD COLUMN claim_expires_at TEXT;
UPDATE referrals
SET claim_expires_at = CASE
    WHEN status IN ('redeemed','rejected','expired') THEN claimed_at
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+24 hours')
END
WHERE claim_expires_at IS NULL;

CREATE INDEX referrals_sender_status_expiry
    ON referrals(sender_account_id,status,claim_expires_at);
CREATE INDEX referrals_recipient_status
    ON referrals(recipient_account_id,status,claimed_at);
UPDATE referral_codes
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE revoked_at IS NULL AND EXISTS(
    SELECT 1 FROM referral_codes newer
    WHERE newer.sender_account_id = referral_codes.sender_account_id
      AND newer.revoked_at IS NULL
      AND (newer.created_at > referral_codes.created_at OR
           (newer.created_at = referral_codes.created_at AND newer.id > referral_codes.id))
);
CREATE UNIQUE INDEX one_active_code_per_sender
    ON referral_codes(sender_account_id)
    WHERE revoked_at IS NULL;

ALTER TABLE redemptions ADD COLUMN reconciliation_expires_at TEXT;
UPDATE redemptions
SET reconciliation_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+30 days')
WHERE reconciliation_expires_at IS NULL;

CREATE INDEX redemptions_account_reconciliation
    ON redemptions(account_id,status,reconciliation_expires_at,reserved_at);
UPDATE offer_code_inventory
SET status = 'assigned', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'reserved';
CREATE UNIQUE INDEX one_inventory_code_per_redemption
    ON offer_code_inventory(reservation_id)
    WHERE reservation_id IS NOT NULL;
CREATE INDEX offer_code_inventory_allocation
    ON offer_code_inventory(offer_reference,product,status,created_at,id);

CREATE TABLE transaction_adjustments (
    transaction_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK(state IN ('active','refunded')),
    event_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
