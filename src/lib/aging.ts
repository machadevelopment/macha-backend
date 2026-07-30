import { sql as rawSql } from 'drizzle-orm';

export const AGING_BUCKETS = ['current', '1_30', '31_60', '61_90', '90_plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/**
 * Clasificación por antigüedad de AR/AP (CU-868kh8w6b). Traduce literalmente el
 * `bucketFor()` que antes corría en JavaScript sobre TODAS las filas abiertas:
 * `due_date` nula o futura → `current`; si no, días de atraso en tramos de 30.
 *
 * `current_date - due_date` en Postgres da un entero de días entre dos `date`, que es
 * exactamente el `Math.floor((today - dueDate) / 1 día)` anterior — mismo corte en los
 * bordes (30, 60, 90), sin depender de zonas horarias ni del reloj del proceso.
 *
 * Vive aquí y no dentro de `modules/metrics` para poder ejercitarlo contra un Postgres
 * real sin arrastrar guards, Redis ni el resto de la ruta: los bordes de los tramos son
 * justo donde un off-by-one no se nota a ojo (ver `tests/integration/aging.test.ts`).
 */
export const AGING_BUCKET_SQL = rawSql<AgingBucket>`
  case
    when due_date is null or due_date >= current_date then 'current'
    when current_date - due_date <= 30 then '1_30'
    when current_date - due_date <= 60 then '31_60'
    when current_date - due_date <= 90 then '61_90'
    else '90_plus'
  end
`;

export function emptyAgingBuckets(): Record<AgingBucket, number> {
  return Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
}
