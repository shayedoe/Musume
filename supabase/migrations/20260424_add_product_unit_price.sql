-- Adds a unit price column to products so review/export can compute $ totals.
-- Nullable: existing products have no price until you fill it in.
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_price DECIMAL(10, 2);
