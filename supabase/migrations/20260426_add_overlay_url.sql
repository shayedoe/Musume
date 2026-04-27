-- Add overlay_url to photos table for storing Roboflow's rendered overlay image.
alter table photos add column if not exists overlay_url text;
