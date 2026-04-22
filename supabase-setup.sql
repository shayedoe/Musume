-- Musume Inventory App - Supabase Database Setup
-- Run this SQL in your Supabase SQL Editor

-- Create inventory_sessions table
CREATE TABLE IF NOT EXISTS inventory_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMP DEFAULT now()
);

-- Create photos table
CREATE TABLE IF NOT EXISTS photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL
);

-- Create final_counts table
CREATE TABLE IF NOT EXISTS final_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  quantity DECIMAL NOT NULL,
  section TEXT
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_photos_session_id ON photos(session_id);
CREATE INDEX IF NOT EXISTS idx_final_counts_session_id ON final_counts(session_id);

-- Enable Row Level Security (RLS)
ALTER TABLE inventory_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE final_counts ENABLE ROW LEVEL SECURITY;

-- Create policies with safer defaults
-- These policies allow all operations for signed-in users only.
-- If you need stricter production access, replace these with user/session-scoped policies.

-- Policies for inventory_sessions
CREATE POLICY "Allow authenticated operations on inventory_sessions"
  ON inventory_sessions FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Policies for photos
CREATE POLICY "Allow authenticated operations on photos"
  ON photos FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Policies for final_counts
CREATE POLICY "Allow authenticated operations on final_counts"
  ON final_counts FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Create storage bucket for inventory images
-- Note: This needs to be done through the Supabase Dashboard > Storage
-- Bucket name: inventory-images
-- Make it public or configure appropriate policies
