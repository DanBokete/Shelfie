-- What the owner sells a product for, used to work out the buy price needed to sell at a
-- competitive price and keep the same profit. Stored per 1 ml, 1 g or 1 item (ex VAT) so it
-- scales to any pack size; the owner enters it for the pack they buy now.
alter table products
  add column selling_price_per_base_unit numeric
    check (selling_price_per_base_unit is null or selling_price_per_base_unit > 0);
