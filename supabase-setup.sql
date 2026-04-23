-- Musume Inventory App - Supabase Database Setup
-- Run this SQL in your Supabase SQL Editor

-- Create inventory_sessions table
CREATE TABLE IF NOT EXISTS inventory_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMP DEFAULT now(),
  location_name TEXT,
  count_sheet_name TEXT,
  status TEXT DEFAULT 'open'
);

-- Create photos table
CREATE TABLE IF NOT EXISTS photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  captured_at TIMESTAMP DEFAULT now()
);

-- Create products catalog table
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

-- Create detections table (AI-proposed bottle detections from photos)
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

-- Create final_counts table
CREATE TABLE IF NOT EXISTS final_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  product_id UUID REFERENCES products(id),
  quantity DECIMAL NOT NULL,
  section TEXT
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_photos_session_id ON photos(session_id);
CREATE INDEX IF NOT EXISTS idx_detections_session_id ON detections(session_id);
CREATE INDEX IF NOT EXISTS idx_detections_photo_id ON detections(photo_id);
CREATE INDEX IF NOT EXISTS idx_final_counts_session_id ON final_counts(session_id);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);

-- Enable Row Level Security (RLS)
ALTER TABLE inventory_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE detections ENABLE ROW LEVEL SECURITY;
ALTER TABLE final_counts ENABLE ROW LEVEL SECURITY;

-- Create policies with safer defaults
-- These policies allow all operations for signed-in users only.
-- If you need stricter production access, replace these with user/session-scoped policies.
-- Drop-then-create so this script is safe to re-run.

-- Policies for inventory_sessions
DROP POLICY IF EXISTS "Allow authenticated operations on inventory_sessions" ON inventory_sessions;
CREATE POLICY "Allow authenticated operations on inventory_sessions"
  ON inventory_sessions FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Policies for photos
DROP POLICY IF EXISTS "Allow authenticated operations on photos" ON photos;
CREATE POLICY "Allow authenticated operations on photos"
  ON photos FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Policies for final_counts
DROP POLICY IF EXISTS "Allow authenticated operations on final_counts" ON final_counts;
CREATE POLICY "Allow authenticated operations on final_counts"
  ON final_counts FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Policies for products
DROP POLICY IF EXISTS "Allow authenticated operations on products" ON products;
CREATE POLICY "Allow authenticated operations on products"
  ON products FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Policies for detections
DROP POLICY IF EXISTS "Allow authenticated operations on detections" ON detections;
CREATE POLICY "Allow authenticated operations on detections"
  ON detections FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Create storage bucket for inventory images
-- Note: This needs to be done through the Supabase Dashboard > Storage
-- Bucket name: inventory-images
-- Make it public or configure appropriate policies
