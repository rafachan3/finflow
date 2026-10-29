-- Migration 0012: tags the owner gives for one receipt line only ("the
-- bananas were for Partner"). Whole-transaction tags stay in
-- transaction_tags, the only place income and transfers (no lines) carry
-- one. A line's effective tags are its own plus its transaction's.
create table transaction_item_tags (
  transaction_item_id uuid     not null references transaction_items(id) on delete cascade,
  tag_id              smallint not null references tags(id),
  primary key (transaction_item_id, tag_id)
);
