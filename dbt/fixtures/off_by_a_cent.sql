-- Variant of synthetic.sql, loaded after it: one receipt line moves by
-- 0.01, so its lines no longer sum to the header. CI loads it and expects
-- expense_lines_sum_to_header, and only that test, to fail.
update transaction_items
set amount = amount + 0.01
where id = 'b0000000-0000-0000-0000-000000000062';
