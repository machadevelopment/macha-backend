/**
 * Cuánto cuesta ingerir cada tipo de archivo — pedido de Jose (2026-08-06):
 * "hagamos benchmark de los tipos de archivo cuánto cuestan, y lo vamos viendo con ellos".
 *
 * Lee lo que YA pasó en una base real (no simula nada, no gasta un solo token) y arma el
 * costo por archivo, por hoja y por arquetipo. Se corre a mano contra la base que se
 * quiera medir:
 *
 *   BENCH_DATABASE_URL=postgres://... bun run scripts/benchmark-ingest.ts
 *   BENCH_DATABASE_URL=postgres://... bun run scripts/benchmark-ingest.ts --json
 *
 * NO es un test y no corre en CI: es una herramienta de decisión de producto.
 *
 * ── DOS ADVERTENCIAS SOBRE LA PRECISIÓN, porque quien lea la tabla va a tomar decisiones
 * de precio con ella ──
 *
 * 1. `ai_usage_events` NO guarda a qué hoja pertenece cada llamada. El desglose por hoja
 *    se reconstruye casando cada lote con el evento de IA más cercano en el tiempo, lo
 *    cual es correcto en la práctica —los dos se escriben en la MISMA transacción— pero
 *    es una inferencia, no un dato. El total por archivo sí es exacto.
 *
 * 2. `cost_usd` sale de `estimateCostUsd(input, output)`, que ignora las tarifas de caché
 *    de prompt: los tokens escritos al caché cuestan 1,25× y los leídos 0,1×, y ninguno de
 *    los dos se registra. Con `cache_control: ephemeral` puesto en el bloque de la
 *    plantilla, el costo real puede diferir. La tabla es la mejor estimación disponible
 *    hoy, no la factura.
 *
 * Las dos se arreglan agregando columnas a `ai_usage_events`; mientras no estén, el
 * script lo dice en su propia salida en vez de dejar creer que son cifras exactas.
 */
import postgres from 'postgres';

const URL_ = process.env.BENCH_DATABASE_URL ?? process.env.DATABASE_URL;
if (!URL_) throw new Error('Set BENCH_DATABASE_URL (o DATABASE_URL)');

const comoJson = process.argv.includes('--json');
const sql = postgres(URL_, { max: 1, ssl: 'prefer' });

/**
 * Arquetipo de costo. No es el tipo de archivo (.xlsx/.csv) — eso no predice nada —, sino
 * qué lado de la llamada domina, que es lo que sí decide el precio:
 *
 *  · `salida`  — libro contable normal: pocas llamadas, muchísima salida. El costo escala
 *                con las filas que la IA EXTRAE. Es el caso que se quiere cobrar.
 *  · `entrada` — hoja ancha o sin movimientos: muchas llamadas, salida mínima. Se paga por
 *                mandarle a Claude datos que no producen nada. Es desperdicio, no producto.
 *  · `descarte`— el archivo no era financiero y el motor lo dijo enseguida. Debe costar
 *                centavos; si no, el filtro previo está fallando.
 */
function arquetipo(inp: number, out: number, filas: number): 'salida' | 'entrada' | 'descarte' {
  if (filas === 0 && out < 1_000) return 'descarte';
  return out >= inp ? 'salida' : 'entrada';
}

const money = (n: number) => `$${n.toFixed(4)}`;

const docs = await sql<
  Array<{
    id: string;
    archivo: string;
    estado: string;
    industria: string;
    kb: number;
    filas: number;
    staging: number;
    hojas: number;
    llamadas: number;
    inp: number;
    out: number;
    costo: number;
    seg: number | null;
  }>
>`
  select d.id,
         d.original_filename                as archivo,
         d.status                           as estado,
         c.industry                         as industria,
         round(d.file_size_bytes / 1024.0)::int as kb,
         coalesce(d.row_count, 0)::int      as filas,
         (select count(*)::int from staging_rows      where document_id = d.id) as staging,
         (select count(distinct sheet_name)::int from document_ingest_batches where document_id = d.id) as hojas,
         (select count(*)::int from ai_usage_events   where ref_id = d.id)      as llamadas,
         (select coalesce(sum(input_tokens), 0)::int  from ai_usage_events where ref_id = d.id) as inp,
         (select coalesce(sum(output_tokens), 0)::int from ai_usage_events where ref_id = d.id) as out,
         (select coalesce(sum(cost_usd), 0)::float    from ai_usage_events where ref_id = d.id) as costo,
         (select extract(epoch from (max(created_at) - min(created_at)))::int
            from document_ingest_batches where document_id = d.id) as seg
  from documents d
  join companies c on c.id = d.company_id
  where exists (select 1 from ai_usage_events where ref_id = d.id)
  order by d.created_at
`;

const enriquecidos = docs.map((d) => ({
  ...d,
  arquetipo: arquetipo(d.inp, d.out, d.filas),
  costoPor100: d.filas > 0 ? (d.costo / d.filas) * 100 : null,
  filasPorMin: d.seg && d.seg > 0 ? Math.round(d.filas / (d.seg / 60)) : null,
}));

if (comoJson) {
  console.log(JSON.stringify(enriquecidos, null, 2));
  await sql.end();
} else {
  console.log('\n═══ COSTO POR ARCHIVO ═══\n');
  console.log(
    'archivo'.padEnd(38) +
      'estado'.padEnd(13) +
      'hojas'.padStart(6) +
      'filas'.padStart(7) +
      'llam'.padStart(6) +
      'entrada'.padStart(10) +
      'salida'.padStart(9) +
      'costo'.padStart(11) +
      '$/100f'.padStart(9) +
      '  arquetipo',
  );
  for (const d of enriquecidos) {
    console.log(
      String(d.archivo).slice(0, 36).padEnd(38) +
        d.estado.padEnd(13) +
        String(d.hojas).padStart(6) +
        String(d.filas).padStart(7) +
        String(d.llamadas).padStart(6) +
        String(d.inp).padStart(10) +
        String(d.out).padStart(9) +
        money(d.costo).padStart(11) +
        (d.costoPor100 === null ? '—' : d.costoPor100.toFixed(3)).padStart(9) +
        '  ' +
        d.arquetipo,
    );
  }

  // Lo que de verdad se quiere saber para poner precio: cuánto cuesta un libro contable
  // real por cada 100 filas. Solo entran los que llegaron a extraer filas — un archivo
  // descartado o fallido no dice nada sobre el precio de un cliente que sí sube su libro.
  const utiles = enriquecidos.filter((d) => d.costoPor100 !== null);
  if (utiles.length > 0) {
    const p = utiles.map((d) => d.costoPor100!).sort((a, b) => a - b);
    console.log(
      `\nlibros con filas extraídas: n=${p.length}  ` +
        `min=$${p[0]!.toFixed(3)}  mediana=$${p[Math.floor(p.length / 2)]!.toFixed(3)}  ` +
        `max=$${p[p.length - 1]!.toFixed(3)}  por cada 100 filas`,
    );
  }

  // El dinero que no compró nada: reintentos del mismo archivo y corridas que fallaron.
  const fallidos = enriquecidos.filter((d) => d.estado === 'failed');
  const gastoFallido = fallidos.reduce((s, d) => s + d.costo, 0);
  const porNombre = new Map<string, number>();
  for (const d of enriquecidos) porNombre.set(d.archivo, (porNombre.get(d.archivo) ?? 0) + 1);
  const repetidos = [...porNombre.entries()].filter(([, n]) => n > 1);

  console.log('\n═══ GASTO QUE NO PRODUJO NADA ═══\n');
  console.log(`corridas fallidas: ${fallidos.length}  →  ${money(gastoFallido)} gastados sin dato`);
  for (const [nombre, n] of repetidos) {
    const total = enriquecidos.filter((d) => d.archivo === nombre).reduce((s, d) => s + d.costo, 0);
    console.log(`  "${nombre.slice(0, 44)}" subido ${n} veces → ${money(total)} en total`);
  }

  console.log('\n═══ DESGLOSE POR HOJA ═══');
  console.log('(atribución por cercanía temporal — ver la nota 1 de la cabecera)\n');
  const hojas = await sql<
    Array<{ archivo: string; hoja: string; lotes: number; inp: number; out: number; costo: number }>
  >`
    select d.original_filename as archivo, b.sheet_name as hoja,
           count(*)::int as lotes,
           sum(e.input_tokens)::int as inp, sum(e.output_tokens)::int as out,
           sum(e.cost_usd)::float as costo
    from document_ingest_batches b
    join documents d on d.id = b.document_id
    join lateral (
      select * from ai_usage_events e2
      where e2.ref_id = b.document_id
      order by abs(extract(epoch from (e2.created_at - b.created_at))) limit 1
    ) e on true
    group by 1, 2
    order by 6 desc
    limit 20
  `;
  console.log(
    'archivo'.padEnd(30) +
      'hoja'.padEnd(26) +
      'lotes'.padStart(6) +
      'entrada'.padStart(10) +
      'salida'.padStart(9) +
      'costo'.padStart(11) +
      '  in:out',
  );
  for (const h of hojas) {
    const ratio = h.out > 0 ? (h.inp / h.out).toFixed(1) : '∞';
    console.log(
      String(h.archivo).slice(0, 28).padEnd(30) +
        String(h.hoja).slice(0, 24).padEnd(26) +
        String(h.lotes).padStart(6) +
        String(h.inp).padStart(10) +
        String(h.out).padStart(9) +
        money(h.costo).padStart(11) +
        `  ${ratio}:1`,
    );
  }

  console.log(
    '\nNota: `cost_usd` ignora las tarifas de caché de prompt (escritura 1,25×, lectura 0,1×),\n' +
      'que hoy no se registran. Es la mejor estimación disponible, no la factura.\n',
  );
  await sql.end();
}
