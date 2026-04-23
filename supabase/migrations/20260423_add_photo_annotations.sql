-- Store per-bottle detection annotations (bbox, product, status, confidence)
-- alongside each photo so the review screen can draw boxes on the image.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS annotations JSONB DEFAULT '[]'::jsonb;
