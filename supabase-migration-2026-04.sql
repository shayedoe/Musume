-- Musume: migration to run AFTER the original supabase-setup.sql was already executed.
-- Safe to run multiple times.

-- 1. Add missing columns to pre-existing tables
ALTER TABLE inventory_sessions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open';
ALTER TABLE inventory_sessions ADD COLUMN IF NOT EXISTS location_name TEXT;
ALTER TABLE inventory_sessions ADD COLUMN IF NOT EXISTS count_sheet_name TEXT;

ALTER TABLE photos ADD COLUMN IF NOT EXISTS captured_at TIMESTAMP DEFAULT now();

-- products / detections may not exist yet on older DBs — create if missing
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  count_unit TEXT NOT NULL DEFAULT 'bottle',
  bottle_size_ml INTEGER,
  barcode TEXT,
  aliases TEXT[],
  marginedge_product_id TEXT,
  active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS detections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id UUID REFERENCES photos(id) ON DELETE CASCADE,
  session_id UUID REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  predicted_product TEXT,
  matched_product_id UUID REFERENCES products(id),
  count INTEGER NOT NULL DEFAULT 1,
  fill_level DECIMAL NOT NULL DEFAULT 1,
  confidence DECIMAL,
  notes TEXT,
  status TEXT DEFAULT 'pending'
);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE detections ENABLE ROW LEVEL SECURITY;

-- 2. Allow the anon role (mobile app using supabaseAnonKey without login)
--    Replace previous authenticated-only policies with anon+authenticated.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_sessions','photos','products','detections','final_counts']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Allow authenticated operations on %I" ON %I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "Allow anon operations on %I" ON %I', t, t);
    EXECUTE format($p$CREATE POLICY "Allow anon operations on %I"
                      ON %I FOR ALL
                      TO anon, authenticated
                      USING (true)
                      WITH CHECK (true)$p$, t, t);
  END LOOP;
END $$;

-- 3. Storage bucket policies for inventory-images (app uses anon key to upload)
--    These are idempotent.
INSERT INTO storage.buckets (id, name, public)
VALUES ('inventory-images', 'inventory-images', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

DROP POLICY IF EXISTS "anon upload inventory images" ON storage.objects;
CREATE POLICY "anon upload inventory images"
  ON storage.objects FOR INSERT
  TO anon, authenticated
  WITH CHECK (bucket_id = 'inventory-images');

DROP POLICY IF EXISTS "anon read inventory images" ON storage.objects;
CREATE POLICY "anon read inventory images"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'inventory-images');
