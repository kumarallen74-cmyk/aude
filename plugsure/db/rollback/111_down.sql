-- Rollback of 111_depot_queue_carbon_diagnostics.sql (v1.44.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/111_down.sql
-- Roll the CODE back first. Dropped: fleet vehicles, sessions' departures, diagnostics runs (work orders they opened
-- stay), the depot, queue-priority and site grid-factor settings. Charging goes back to the usual load management.
DROP TABLE IF EXISTS diagnostic_run;
ALTER TABLE driver_queue_entry DROP COLUMN IF EXISTS priority;
ALTER TABLE site DROP COLUMN IF EXISTS grid_kg_per_kwh;
ALTER TABLE site DROP COLUMN IF EXISTS queue_priority;
ALTER TABLE site DROP COLUMN IF EXISTS depot_scheduling;
DROP TABLE IF EXISTS session_departure;
DROP TABLE IF EXISTS fleet_vehicle;
DELETE FROM schema_migration WHERE name = '111_depot_queue_carbon_diagnostics.sql';
