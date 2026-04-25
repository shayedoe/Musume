-- Debug payloads from each vision request so bad scans can be inspected later.
CREATE TABLE IF NOT EXISTS vision_debug_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id UUID REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  image_url TEXT,
  photo_index INTEGER,
  capture_mode TEXT,
  detections JSONB NOT NULL DEFAULT '[]'::jsonb,
  annotations JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS vision_debug_logs_session_idx
  ON vision_debug_logs(session_id, created_at DESC);

-- Human corrections from the review overlay. This becomes the app-side
-- training queue: export these rows/images into Roboflow, or use them to
-- tune reference matching.
CREATE TABLE IF NOT EXISTS training_annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id UUID REFERENCES inventory_sessions(id) ON DELETE SET NULL,
  photo_id UUID REFERENCES photos(id) ON DELETE SET NULL,
  image_url TEXT NOT NULL,
  bbox JSONB NOT NULL,
  predicted_product TEXT,
  corrected_product TEXT NOT NULL,
  confidence NUMERIC,
  source TEXT NOT NULL DEFAULT 'review-overlay',
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT
);

CREATE INDEX IF NOT EXISTS training_annotations_status_idx
  ON training_annotations(status, created_at DESC);

CREATE INDEX IF NOT EXISTS training_annotations_product_idx
  ON training_annotations(corrected_product, created_at DESC);