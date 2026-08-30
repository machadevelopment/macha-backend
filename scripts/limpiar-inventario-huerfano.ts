/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DA DE BAJA LOS ARTÍCULOS QUE QUEDARON COLGADOS DE UN REVERT VIEJO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Reporte de Keneth (2026-08-30): tras revertir varias cargas, el inventario seguía mostrando
 * **264 artículos en cero** —los vehículos de una concesionaria— porque hasta ese día
 * `revertDocument` dejaba la existencia en cero pero no daba de baja el artículo.
 *
 * El arreglo (`compensarInventario`) cubre los reverts de ahí en adelante y **no toca lo que
 * ya quedó colgado**. Este script es esa mitad: aplica exactamente el MISMO criterio, una vez,
 * sobre lo que ya está.
 *
 * ═══ EL CRITERIO ES EL DEL ARREGLO, PALABRA POR PALABRA ═══
 *
 * Se da de baja un artículo solo si:
 *   1. su existencia es cero, Y
 *   2. **todos** sus movimientos vienen de cargas revertidas o canceladas.
 *
 * La segunda condición es la que importa y la que hace seguro correr esto: un artículo que
 * alguien contó A MANO (movimiento con `document_id` NULL) sobrevive, y uno que sostiene una
 * carga viva también. Copiar el criterio en vez de inventar uno nuevo no es pereza: si este
 * script borrara con una regla distinta de la que usa el revert, el inventario quedaría en un
 * estado que el producto no sabe producir por sí solo.
 *
 * ⚠️ **Un artículo en cero NO es basura por sí solo.** Se agotó el stock y el dueño necesita
 * verlo — es justo cuando más lo necesita. Lo que lo vuelve basura es que ya no lo sostenga
 * ninguna carga viva ni ningún conteo humano.
 *
 * Es SOFT-DELETE, igual que el revert: la fila queda con `deleted_at` y su historial de
 * movimientos intacto. Nada se pierde, y volver a subir el archivo recrea el artículo.
 *
 * Uso:
 *   INVENTARIO_DATABASE_URL=postgres://... bun run scripts/limpiar-inventario-huerfano.ts
 *   INVENTARIO_DATABASE_URL=postgres://... bun run scripts/limpiar-inventario-huerfano.ts --aplicar
 *
 * **Sin `--aplicar` NO escribe nada**: lista lo que haría y sale. Es lo correcto para algo que
 * toca la contabilidad de un cliente — mirar primero, decidir después.
 *
 * La variable es propia y NO cae a `DATABASE_URL` a propósito (mismo criterio que
 * `restore-drill.ts` y `audit-staging-data.ts`): apuntarla explícitamente evita correr esto
 * contra el ambiente que resulte estar en `DATABASE_URL` en ese momento.
 */
import postgres from 'postgres';

const url = process.env.INVENTARIO_DATABASE_URL;
if (!url) {
  console.error(
    'INVENTARIO_DATABASE_URL no está seteada. Apúntala explícitamente a la base que quieres\n' +
      'limpiar y vuelve a correr. No cae a DATABASE_URL a propósito.',
  );
  process.exit(1);
}

const aplicar = process.argv.includes('--aplicar');
/**
 * Incluye los artículos que NO tienen un solo movimiento.
 *
 * Es opt-in y no el default por una razón concreta: sin movimientos no hay forma de saber si lo
 * creó una carga o una persona. Un artículo importado con existencia CERO no genera movimiento
 * —`recordMovement` rechaza cantidad 0, con razón— así que en los datos anteriores a la
 * migración 0038 los dos casos son **indistinguibles**.
 *
 * Desde 0038 el artículo guarda su `document_id`, así que para los datos NUEVOS esta bandera no
 * hace falta: el revert los alcanza solo. Existe para lo que quedó ANTES de esa migración, donde
 * ni siquiera hay `document_id` que consultar y la única evidencia es de contexto —240 vehículos
 * con nombre de auto y costo de seis cifras creados el mismo día no los dio de alta nadie a
 * mano—. Ese juicio le toca a una persona mirando la lista, no a una consulta.
 *
 * ⚠️ Con esta bandera **también entra** un artículo que alguien dio de alta a mano en cero y
 * nunca movió. Por eso es opt-in, por eso el ensayo lista todo antes, y por eso conviene
 * combinarla con el criterio de siempre: mirar la lista primero.
 */
const incluirSinMovimientos = process.argv.includes('--incluir-sin-movimientos');
const sql = postgres(url, { max: 1, ssl: 'prefer', onnotice: () => {} });

/**
 * Los huérfanos, con el contexto suficiente para que una persona pueda juzgar la lista antes
 * de aplicarla. Es la MISMA condición que `compensarInventario` — ver la nota de arriba.
 */
const huerfanos = await sql<
  Array<{
    id: string;
    company_id: string;
    empresa: string;
    sku: string;
    name: string;
    movimientos: number;
  }>
>`
  select i.id,
         i.company_id,
         c.name as empresa,
         i.sku,
         i.name,
         (select count(*) from inventory_movements m
           where m.company_id = i.company_id and m.item_id = i.id)::int as movimientos
    from inventory_items i
    join companies c on c.id = i.company_id
   where i.deleted_at is null
     and i.quantity_on_hand = 0
     -- Ni un solo movimiento que NO venga de una carga revertida o cancelada: ni manual
     -- (document_id NULL), ni de una carga que siga viva.
     --
     -- OJO: la primera rama (document_id NULL) es REDUNDANTE acá y se deja por legibilidad,
     -- no por efecto: un document_id NULL nunca casa contra documents, así que el not exists
     -- de abajo ya lo cubre. Comprobado por mutación: quitarla no cambia ni un resultado.
     -- NO es redundante en compensarInventario, donde un <> de por medio la vuelve necesaria
     -- y quitarla SÍ tumba tests. Vale saberlo antes de simplificar aquella copiando esta.
     and not exists (
       select 1 from inventory_movements m
        where m.company_id = i.company_id
          and m.item_id = i.id
          and (
            m.document_id is null
            or not exists (
              select 1 from documents d
               where d.id = m.document_id
                 and d.status in ('reverted', 'cancelled')
            )
          )
     )
     -- Un artículo SIN un solo movimiento no se toca por defecto: en los datos anteriores a la
     -- migración 0038 no hay forma de saber si lo creó una carga (importado con existencia 0,
     -- que no genera movimiento) o una persona. Con --incluir-sin-movimientos se incluyen; ver
     -- la nota de esa bandera.
     and (
       ${incluirSinMovimientos ? sql`true` : sql`false`}
       or exists (
         select 1 from inventory_movements m
          where m.company_id = i.company_id and m.item_id = i.id
       )
     )
   order by c.name, i.sku
`;

if (huerfanos.length === 0) {
  console.log('No hay artículos colgados de un revert. Nada que hacer.');
  await sql.end();
  process.exit(0);
}

type Huerfano = (typeof huerfanos)[number];
const porEmpresa = new Map<string, Huerfano[]>();
for (const h of huerfanos) {
  const previo = porEmpresa.get(h.empresa) ?? [];
  previo.push(h);
  porEmpresa.set(h.empresa, previo);
}

console.log(
  `\n${huerfanos.length} artículo(s) en cero cuya única historia son cargas ya revertidas:\n`,
);
for (const [empresa, items] of porEmpresa) {
  console.log(`  ${empresa} — ${items.length} artículo(s)`);
  for (const i of items.slice(0, 5)) {
    console.log(`    ${i.sku.padEnd(14)} ${i.name.slice(0, 40).padEnd(40)} ${i.movimientos} mov.`);
  }
  if (items.length > 5) console.log(`    … y ${items.length - 5} más`);
}

if (!aplicar) {
  console.log(
    '\nEsto es un ENSAYO: no se escribió nada. Revisa la lista y, si está bien, vuelve a\n' +
      'correr con --aplicar. Es soft-delete: la fila y su historial de movimientos quedan.',
  );
  await sql.end();
  process.exit(0);
}

const ids = huerfanos.map((h) => h.id);
const actualizados = await sql`
  update inventory_items
     set deleted_at = now(), updated_at = now()
   where id in ${sql(ids)}
     and deleted_at is null
  returning id
`;

console.log(`\n✅ ${actualizados.length} artículo(s) dados de baja (soft-delete).`);
console.log('   El historial de movimientos queda intacto y volver a subir el archivo los recrea.');
await sql.end();
