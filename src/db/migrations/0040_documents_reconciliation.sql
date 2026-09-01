-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- 0040 — EL VEREDICTO DEL CUADRE SE GUARDA
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- `lib/cuadre.ts` compara lo LEÍDO del archivo contra lo ATERRIZADO y es lo único del pipeline
-- capaz de detectar un fallo sobre **un archivo que nadie vio nunca** — los tests cubren
-- archivos que ya vimos, y ahí estuvo el hueco durante siete reportes de clientes.
--
-- Su veredicto iba a `console.warn` y a ningún otro lado. El encabezado del propio módulo
-- afirmaba que "un descuadre queda ESCRITO en el resumen de la carga" y **no era cierto**: no
-- había columna donde ponerlo, y el `read_summary` se guarda ANTES de calcularlo.
--
-- Verificado el 2026-08-31 contra el proyecto de producción: buscando el veredicto de dos
-- cargas que un cliente acababa de reportar, **ya no existía**. Railway conserva una ventana
-- corta, no agrega y no alerta. Es el MISMO error que `lib/read-summary.ts` documenta haber
-- corregido para los datos de lectura ("hoy va a console.info y rota con los logs de Railway"):
-- la lección estaba aprendida en un módulo y sin aplicar en el que más la necesitaba.
--
-- `jsonb` y no columnas sueltas: el veredicto es por MONEDA y por HOJA, o sea una estructura,
-- y aplanarla a columnas obligaría a una migración cada vez que el cuadre aprenda a mirar algo
-- nuevo. No se consulta por su contenido — se lee entera junto al documento.
--
-- NULL = carga anterior a esta migración, o que no llegó a evaluarse. Distinto de un objeto
-- vacío, que significaría "se evaluó y no había nada que comparar".

ALTER TABLE documents ADD COLUMN IF NOT EXISTS reconciliation jsonb;

COMMENT ON COLUMN documents.reconciliation IS
  'Veredicto del cuadre (lib/cuadre.ts): lo leído del archivo contra lo aterrizado, por moneda y POR HOJA. NULL = carga anterior a la migración 0040. Antes esto solo existía como línea de log y se perdía con la rotación de Railway.';
