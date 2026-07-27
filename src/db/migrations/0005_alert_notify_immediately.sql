-- CU-868kfv993: distingue reglas que notifican por email de inmediato (afectan
-- liquidez) de las que se acumulan para el reporte periódico. drizzle-kit no pudo
-- correr en este entorno (mismatch de arquitectura de esbuild, sin Postgres local
-- disponible) — columna agregada a mano siguiendo el estilo de 0002_checks.sql.
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS notify_immediately boolean NOT NULL DEFAULT false;
