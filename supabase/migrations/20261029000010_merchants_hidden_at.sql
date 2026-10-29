-- Migration 0010: /delmerchant hides a merchant that saved transactions use
-- instead of refusing. A hidden merchant keeps its links on past
-- transactions, is left out of the extraction prompt's Merchants list, and is
-- not linked by later Confirms. /addmerchant on its name clears hidden_at.

alter table merchants add column hidden_at timestamptz;
