-- Allow deleting an inventory session to also remove its photos,
-- detections, and final_counts. Without CASCADE, deletes from the
-- Past Inventories screen fail with:
--   insert or update on table photos violates foreign key photos_session_id_fkey
--   (or the delete on inventory_sessions is blocked by the same FK)
--
-- We drop-then-recreate each FK with ON DELETE CASCADE. Safe to re-run.

-- photos.session_id -> inventory_sessions.id
ALTER TABLE photos
  DROP CONSTRAINT IF EXISTS photos_session_id_fkey;
ALTER TABLE photos
  ADD CONSTRAINT photos_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES inventory_sessions(id) ON DELETE CASCADE;

-- detections.session_id -> inventory_sessions.id
ALTER TABLE detections
  DROP CONSTRAINT IF EXISTS detections_session_id_fkey;
ALTER TABLE detections
  ADD CONSTRAINT detections_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES inventory_sessions(id) ON DELETE CASCADE;

-- detections.photo_id -> photos.id (nullable; keep CASCADE so deleting a
-- photo row also cleans up per-photo detections. Aggregate detections
-- with photo_id=NULL are unaffected.)
ALTER TABLE detections
  DROP CONSTRAINT IF EXISTS detections_photo_id_fkey;
ALTER TABLE detections
  ADD CONSTRAINT detections_photo_id_fkey
  FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE;

-- final_counts.session_id -> inventory_sessions.id
ALTER TABLE final_counts
  DROP CONSTRAINT IF EXISTS final_counts_session_id_fkey;
ALTER TABLE final_counts
  ADD CONSTRAINT final_counts_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES inventory_sessions(id) ON DELETE CASCADE;
