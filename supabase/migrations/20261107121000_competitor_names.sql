-- One row per competitor name, so checks running side by side never create the same shop twice.
create unique index suppliers_competitor_name_idx on suppliers (lower(name)) where kind = 'competitor';
