-- Migration 0004: enforce accounts.kind domain in the schema instead of a
-- comment. Values were already documented as savings | investment; this
-- makes the database reject anything else.

alter table accounts
  add constraint accounts_kind_check check (kind in ('savings', 'investment'));
