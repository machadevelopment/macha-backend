-- CU-868kt94an — LA ALERTA TIENE QUE DECIR DE QUÉ MES HABLA.
--
-- El usuario vio dos alertas de "Caída de ingresos" con la misma fecha (17/08/2026): una
-- del 52,3 % y otra del 100 %. Le preguntó al asesor, el asesor calculó 64,9 % y le dijo
-- que la del 52,3 % "no existe". Los tres números son correctos — para tres ventanas de
-- tiempo distintas — y NINGUNA de las tres partes decía cuál era la suya.
--
-- `alert_events` guardaba el valor y nada más: ni qué período se evaluó ni contra cuál se
-- comparó. Con eso, una alerta no se puede verificar (¿52 % de qué contra qué?), no se
-- puede explicar y no se puede contrastar con lo que dice el asesor o el dashboard. Es la
-- diferencia entre un aviso y un rumor.
--
-- Las tres columnas son NULLABLE porque los eventos YA EXISTENTES no tienen forma de
-- recuperar su período: se evaluaron con la regla vieja (mes en curso contra el promedio
-- de los 3 anteriores) y el instante exacto de la evaluación es lo único que se guardó.
-- Rellenarlos con una suposición sería peor que dejarlos vacíos — inventaría precisión
-- donde no la hay. La UI los muestra sin período, como hasta ahora.
--
-- `alert_events` NO está en la lista de ledgers de solo-inserción del CLAUDE.md, así que
-- un ALTER es legítimo acá. Y los tres son ADD COLUMN sin default ni NOT NULL: en
-- PostgreSQL eso es solo un cambio de catálogo, no reescribe la tabla, y el
-- AccessExclusiveLock se toma y se suelta de inmediato. Importa porque estas migraciones
-- corren contra producción mientras el contenedor viejo sigue atendiendo tráfico.

ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS period_start date;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS period_end date;
-- Con qué se comparó. Para `revenue_drop` es el promedio de los 3 meses previos; para las
-- reglas que no comparan contra nada (concentración, saldo de créditos) queda en NULL.
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS baseline_value numeric(18,4);

COMMENT ON COLUMN alert_events.period_start IS
  'CU-868kt94an: mes evaluado. NULL en los eventos anteriores a la migración 0032.';
COMMENT ON COLUMN alert_events.baseline_value IS
  'CU-868kt94an: el valor de referencia contra el que se comparó, cuando la regla compara.';
