-- A trade synced from a trading account: where it came from (`venue:account:coin:opened`),
-- so each sync writes the same row again rather than another.
ALTER TABLE journal_trade ADD COLUMN source TEXT;
CREATE UNIQUE INDEX journal_trade_source_idx ON journal_trade (owner, source) WHERE source IS NOT NULL;
