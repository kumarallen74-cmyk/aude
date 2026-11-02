-- Rollback of 113_field_private_anpr.sql (v1.46.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/113_down.sql
-- Roll the CODE back first. Dropped: field templates, work-order photos (their files stay under STORAGE_DIR/field),
-- checklists, signatures and assignments; residential and workplace groups, units, members and statements (private
-- chargers become public again); cameras, plate events, parking visits and the sites' parking settings.
DROP TABLE IF EXISTS plate_event;
DROP TABLE IF EXISTS parking_visit;
DROP TABLE IF EXISTS anpr_camera;
ALTER TABLE site DROP COLUMN IF EXISTS plate_autostart;
ALTER TABLE site DROP COLUMN IF EXISTS parking_max_minutes;
ALTER TABLE site DROP COLUMN IF EXISTS parking_fee_per_hour_minor;
ALTER TABLE site DROP COLUMN IF EXISTS parking_grace_minutes;
DROP TABLE IF EXISTS private_statement;
DROP TABLE IF EXISTS private_member;
DROP TABLE IF EXISTS private_unit;
DROP TABLE IF EXISTS private_group_charger;
DROP TABLE IF EXISTS private_group;
DROP TABLE IF EXISTS field_op;
DROP TABLE IF EXISTS work_order_photo;
DROP INDEX IF EXISTS work_order_assignee_idx;
ALTER TABLE work_order DROP COLUMN IF EXISTS signed_at, DROP COLUMN IF EXISTS signature_path, DROP COLUMN IF EXISTS signature_name, DROP COLUMN IF EXISTS arrived_at,
  DROP COLUMN IF EXISTS field_notes, DROP COLUMN IF EXISTS checklist, DROP COLUMN IF EXISTS template_id, DROP COLUMN IF EXISTS scheduled_for, DROP COLUMN IF EXISTS assignee_id;
DROP TABLE IF EXISTS field_template;
DELETE FROM schema_migration WHERE name = '113_field_private_anpr.sql';
