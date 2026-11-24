-- Migration 0026: a note the owner gives about one line only ("the bananas
-- were for the trip because the kids skipped breakfast"). A reason about the
-- whole purchase stays on transactions.notes, the only place income and
-- transfers (no lines) carry one. Null when the owner gave none.
alter table transaction_items
  add column if not exists note text;
