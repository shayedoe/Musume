-- Add per-bottle bounding box annotations to photos so the Review
-- screen can render a color-coded overlay on the captured image.
-- Each row is [{ bbox:[x,y,w,h], product, status, confidence }].
ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS annotations JSONB DEFAULT '[]'::jsonb;
