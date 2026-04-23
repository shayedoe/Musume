-- Musume: reference-image gallery for visual cross-matching.
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS bottle_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  notes TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bottle_references_priority_idx
  ON bottle_references (priority ASC, product_name ASC);

ALTER TABLE bottle_references ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon operations on bottle_references" ON bottle_references;
CREATE POLICY "anon operations on bottle_references"
  ON bottle_references FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- Dedicated bucket for reference photos (smaller images, public read).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'bottle-references',
  'bottle-references',
  true,
  5242880, -- 5 MB
  ARRAY['image/jpeg','image/jpg','image/png','image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "anon upload bottle references" ON storage.objects;
CREATE POLICY "anon upload bottle references"
  ON storage.objects FOR INSERT
  TO anon, authenticated
  WITH CHECK (bucket_id = 'bottle-references');

DROP POLICY IF EXISTS "anon read bottle references" ON storage.objects;
CREATE POLICY "anon read bottle references"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'bottle-references');

DROP POLICY IF EXISTS "anon delete bottle references" ON storage.objects;
CREATE POLICY "anon delete bottle references"
  ON storage.objects FOR DELETE
  TO anon, authenticated
  USING (bucket_id = 'bottle-references');
