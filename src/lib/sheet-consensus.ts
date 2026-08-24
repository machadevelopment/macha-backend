/**
 * Consenso de hoja: dejar de preguntarle al modelo lo que ya contestó 200 veces.
 *
 * ═══ EL RECIBO QUE MOTIVA ESTE ARCHIVO ═══
 *
 * `CasaViva_Registro_Operaciones_2025-2026.xlsx`, de House Products, subido el 2026-08-18.
 * Medido sobre `ai_usage_events` del documento `055d9a75-64b4-49f8-a391-3834346a4d67`:
 *
 *     216 llamadas · USD 15,82 · 14 minutos de reloj
 *     de esas, 205 llamadas (95 %) fueron UNA SOLA HOJA: `Ventas`, 18.034 filas
 *
 * Y el veredicto que devolvió el modelo en esas 205 llamadas fue, fila por fila, el mismo:
 * `transaction` / `revenue`. Las 18.034. Sin una sola excepción.
 *
 * O sea que se pagaron USD 15 y se hicieron esperar 14 minutos para que un modelo de lenguaje
 * dijera "esto es una venta" dieciocho mil veces seguidas sobre una hoja donde cada fila tiene
 * exactamente la misma forma que la anterior. Eso no es clasificar: es copiar.
 *
 * Es la misma regla de oro que ya justifica `sheet-classifier.ts` ("no mandarle a la IA lo que
 * resuelve el código"), aplicada un nivel más adentro: ahí se descartan HOJAS enteras por sus
 * encabezados; acá se dejan de mandar los LOTES de una hoja cuyo criterio ya quedó establecido.
 *
 * ═══ QUÉ SE CONSERVA DEL MODELO, Y NO ES NEGOCIABLE ═══
 *
 * El modelo sigue viendo la hoja. Los primeros lotes van íntegros y son los que ESTABLECEN el
 * criterio: el mapa de columnas, la entidad destino, el tipo contable y la categoría. Lo que se
 * deja de pagar es la repetición, no el juicio.
 *
 * Nada de esto se activa por defecto sobre una hoja cualquiera: hace falta que los lotes de
 * sonda coincidan de forma abrumadora entre sí. Una hoja variada —`Gastos_Operativos` del mismo
 * archivo, con nómina, alquiler, servicios e impuestos mezclados— NO alcanza consenso y sigue
 * yendo entera al modelo, que es lo correcto: ahí cada fila sí requiere criterio.
 *
 * ═══ EL SESGO, OTRA VEZ, VA HACIA PAGAR DE MÁS ═══
 *
 * Igual que en `sheet-classifier.ts`, los dos errores no cuestan lo mismo. Cortocircuitar de
 * más mete un veredicto equivocado en la contabilidad del cliente EN SILENCIO; cortocircuitar
 * de menos solo cuesta lo que ya cuesta hoy. Por eso cada umbral de acá está puesto del lado
 * caro, y por eso el cortocircuito exige homogeneidad casi perfecta en vez de mayoría.
 */

import type { ColumnMap, RowVerdict } from '@/lib/row-assembly';
import { asDate, asNumber } from '@/lib/row-assembly';

/** El veredicto que una hoja homogénea aplica a sus filas restantes. */
export type VeredictoDominante = {
  targetEntity: 'transaction' | 'invoice' | 'bill';
  type: RowVerdict['type'];
  category: string | null;
  /**
   * La confianza PROMEDIO que el modelo le puso a las filas de este mismo veredicto en la
   * sonda. No 1,0 — no la estamos midiendo nosotros, la estamos heredando: es lo que el
   * modelo dijo sobre filas de la misma forma en la misma hoja. Inflarla a 1 sería afirmar
   * algo que nadie verificó, y `staging-rules.ts` decide qué va a revisión leyendo justo
   * este número.
   */
  confidence: number;
};

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * PARTE 1 — CANONICALIZAR EL NOMBRE DE LA CATEGORÍA
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ═══ EL BUG QUE ESTO ARREGLA, QUE NO ES DE COSTO SINO DE DATOS ═══
 *
 * En la misma hoja `Ventas`, sobre filas indistinguibles entre sí, el modelo devolvió:
 *
 *     sales          17.763 filas
 *     ventas             88 filas   ← un lote entero
 *     product_sales      88 filas   ← otro lote entero
 *
 * Los dos 88 son exactamente el tamaño de lote de esa corrida. O sea: no fueron filas
 * distintas, fueron LOTES distintos bautizando lo mismo de otra forma. Cada lote pide su
 * clasificación por separado y nada obligaba a que se pusieran de acuerdo en el nombre.
 *
 * Consecuencia en producción: House Products tiene hoy tres categorías en su dashboard para un
 * solo concepto, y cualquier agrupación por categoría —un reporte, una gráfica, un insight—
 * parte sus ventas en tres pedazos sin que nada falle.
 *
 * Es el MISMO modo de fallo que `fusionarMapaDeColumnas` ya cubre para el mapa de columnas
 * ("si el lote 3 dice que el monto es la columna 13 y el lote 7 dice que es la 8, media hoja
 * entra con el monto equivocado"), sobre el otro campo que el modelo decide por lote.
 *
 * ═══ POR QUÉ NO SE COLAPSA POR (ENTIDAD, TIPO), QUE SERÍA MÁS SIMPLE ═══
 *
 * Porque destruiría información real. `Gastos_Operativos` del mismo archivo trae 13 categorías
 * distintas —`payroll`, `rent`, `utilities`, `taxes`, `marketing`…— y TODAS son
 * `transaction`/`opex`. Colapsarlas por su tipo contable dejaría al cliente con un único rubro
 * "gastos" y le quitaría lo único que hace útil la pantalla de gastos.
 *
 * Así que se colapsa por SINONIMIA, no por tipo: `ventas` y `product_sales` se unifican con
 * `sales` porque nombran lo mismo; `rent` y `payroll` no se tocan porque no.
 *
 * ═══ LA PROPIEDAD QUE HACE ESTO SEGURO ═══
 *
 * El canonizador NUNCA inventa un nombre: solo puede mapear un nombre nuevo sobre uno que YA
 * apareció en esta misma hoja y bajo el mismo (entidad, tipo). Si la tabla de sinónimos de
 * abajo se queda corta, el peor caso es que no se unifique nada —exactamente lo de hoy— y no
 * que se unifique mal. El modo de fallo es el barato.
 */

/**
 * Palabras que MODIFICAN sin nombrar. Se descartan al comparar dos nombres de categoría.
 *
 * La lista es corta a propósito. Cada palabra que entra acá es una oportunidad de unificar dos
 * categorías que en realidad son distintas, así que solo van las que no pueden ser el sujeto
 * de una categoría contable: artículos, conectores, y los adjetivos de granularidad que las
 * hojas de PYME pegan a todo (`total`, `línea`, `producto`).
 *
 * `gasto`, `neto` y `bruto` NO están y no es olvido: `gasto_ventas` no es `ventas`, y utilidad
 * bruta no es utilidad neta. Descartarlos uniría cosas que el cliente lee como distintas.
 */
const PALABRAS_GENERICAS = new Set([
  'de',
  'del',
  'la',
  'las',
  'el',
  'los',
  'y',
  'e',
  'por',
  'of',
  'the',
  'and',
  'total',
  'totales',
  'general',
  'generales',
  'producto',
  'productos',
  'product',
  'products',
  'linea',
  'lineas',
  'line',
  'lines',
  'item',
  'items',
  'monto',
  'montos',
  'amount',
  'amounts',
]);

/**
 * Traducción ES↔EN a un concepto único, palabra por palabra.
 *
 * Hace falta porque el modelo mezcla los dos idiomas DENTRO de la misma hoja —está en los
 * datos: `ventas` y `sales` sobre las mismas filas—, y ningún truco de normalización
 * ortográfica acerca `ventas` a `sales`.
 *
 * Se normaliza hacia el inglés por comodidad de la tabla, no por preferencia: el nombre que
 * termina viendo el cliente es SIEMPRE el primero que el modelo usó en su hoja (ver
 * `CanonizadorDeCategorias`), así que si su archivo dice `ventas`, su dashboard dice `ventas`.
 * Esta tabla solo decide si dos nombres son el mismo concepto.
 */
const LEMAS: Record<string, string> = {
  venta: 'sale',
  vender: 'sale',
  ingreso: 'revenue',
  ingresos: 'revenue',
  compra: 'purchase',
  costo: 'cost',
  coste: 'cost',
  mercaderia: 'merchandise',
  mercancia: 'merchandise',
  inventario: 'inventory',
  /*
   * Vocabulario que faltó en archivos reales y cada ausencia costó un rubro partido en el
   * dashboard del cliente. Se agregan por MEDICIÓN, no por imaginación — ver la nota de
   * `conceptoDeCategoria` sobre por qué esta tabla nunca va a estar completa y qué la
   * respalda.
   */
  vehiculo: 'vehicle',
  auto: 'vehicle',
  automovil: 'vehicle',
  carro: 'vehicle',
  car: 'vehicle',
  importacion: 'import',
  aduana: 'customs',
  aduanas: 'customs',
  arancel: 'customs',
  /*
   * ═══ EXTRAÍDOS DE LAS 143 CATEGORÍAS QUE HAY HOY EN PRODUCCIÓN (auditoría 2026-08-24) ═══
   *
   * Cada línea de acá abajo es un rubro que un cliente REAL ve partido en dos en su dashboard.
   * No son traducciones imaginadas: son los pares que aparecen juntos en la misma empresa —
   * `capacitacion_personal` y `staff_training` en HeladosGT, `contabilidad` y
   * `accounting_fees` en Electro Hogar, `comisiones_ventas` y `sales_commissions` en CarsGT.
   *
   * La auditoría midió el tamaño del problema: 24 categorías de `opex` en House Products,
   * 20 en HeladosGT, 19 en CarsGT. No todas son duplicados —un negocio tiene muchos gastos
   * distintos— pero los pares ES/EN sí lo son, y son la mayoría de lo que sobra.
   *
   * ═══ LO QUE NO SE TOCA, Y ES UNA DECISIÓN ═══
   *
   * Los DESGLOSES no se unifican: `utilities_water` no se colapsa contra `utilities`, ni
   * `payroll_admin` contra `payroll`. Un dueño puede querer ver el agua separada de la luz, y
   * la regla de contención con su mínimo de dos lemas ya los deja aparte. Traducir es
   * objetivo; decidir que dos rubros distintos son uno es del cliente, no nuestro.
   */
  capacitacion: 'training',
  entrenamiento: 'training',
  personal: 'staff',
  suministro: 'supply',
  insumo: 'supply',
  bancaria: 'bank',
  contabilidad: 'accounting',
  contable: 'accounting',
  equipo: 'equipment',
  garantia: 'warranty',
  soporte: 'support',
  permiso: 'permit',
  licencia: 'license',
  seguridad: 'security',
  flotilla: 'fleet',
  reparto: 'delivery',
  entrega: 'delivery',
  refrigeracion: 'refrigeration',
  transportation: 'transport',
  reparacion: 'repair',
  legal: 'legal',
  honorario: 'fee',
  suscripcion: 'subscription',
  /*
   * Las dos formas INGLESAS de un lema que ya existía en español, para que el par caiga junto.
   * `comision` ya mapeaba a `fee` desde antes; sin `commission` aquí, `comisiones_ventas` daba
   * `fee|sale` y `sales_commissions` daba `commission|sale` — dos rubros donde hay uno.
   * `supplie` es la forma que produce `sinPlural` sobre `supplies`.
   */
  commission: 'fee',
  supplie: 'supply',
  /*
   * Segunda pasada, sobre la carga que CarsGT resubió ya con los lemas de arriba puestos
   * (documento `d17a8b9c`, 2026-08-24): `personnel_training` seguía separado de
   * `capacitacion_personal`, e `import_duties` de `import_customs`. Los dos son traducción
   * pura, que es lo único que esta tabla decide.
   */
  personnel: 'staff',
  duty: 'customs',
  dutie: 'customs',
  nomina: 'payroll',
  salario: 'payroll',
  sueldo: 'payroll',
  planilla: 'payroll',
  alquiler: 'rent',
  arrendamiento: 'rent',
  renta: 'rent',
  servicio: 'utility',
  servicios: 'utility',
  utilidad: 'utility',
  impuesto: 'tax',
  mantenimiento: 'maintenance',
  publicidad: 'marketing',
  mercadeo: 'marketing',
  seguro: 'insurance',
  transporte: 'transport',
  combustible: 'fuel',
  comision: 'fee',
  banco: 'bank',
  bancario: 'bank',
  bancarias: 'bank',
  oficina: 'office',
  papeleria: 'office',
  limpieza: 'cleaning',
  agua: 'water',
  electricidad: 'electricity',
  energia: 'electricity',
  luz: 'electricity',
  telefono: 'phone',
  internet: 'internet',
  flete: 'freight',
  envio: 'shipping',
  descuento: 'discount',
  devolucion: 'refund',
  cliente: 'customer',
  proveedor: 'supplier',
  goods: 'merchandise',
  sold: 'cost',
  cogs: 'cost',
  cmv: 'cost',
  utilities: 'utility',
  taxes: 'tax',
  fees: 'fee',
};

/** Sin acentos, en minúsculas, partido en palabras. */
/**
 * Los cuatro tipos contables, tal como el esquema los acota.
 *
 * Se usan para reconocer —y quitar— el prefijo que el modelo a veces pega delante de la
 * categoría. Ver `sinPrefijoDeTipo`.
 */
const TIPOS_CONTABLES = new Set(['revenue', 'cogs', 'opex', 'other']);

/**
 * Quita el `tipo.` que el modelo a veces antepone a la categoría.
 *
 * ═══ MEDIDO EN PRODUCCIÓN (auditoría 2026-08-24) ═══
 *
 *     opex.software           28 filas      software                28 filas
 *     cogs.hosting            21 filas      hosting                 ...
 *     opex.professional_fees   8 filas      professional_fees       ...
 *     opex.rent                4 filas      rent                    ...
 *     opex.utilities           4 filas      utilities               ...
 *     opex.marketing           4 filas      marketing               ...
 *
 * 69 filas de U3 TECH, y su dashboard muestra `opex.software` Y `software` como dos rubros.
 * El tipo contable YA viaja en su propio campo (`t`), así que repetirlo dentro del nombre no
 * agrega nada: es basura estructural.
 *
 * ═══ POR QUÉ ACÁ Y NO EN `PALABRAS_GENERICAS` ═══
 *
 * Porque `revenue` es un lema legítimo —`ingreso` mapea a él— y meterlo en las genéricas
 * dejaría a una categoría llamada `ingresos` sin ninguna palabra significativa. Lo que sobra
 * no es la palabra: es la palabra EN POSICIÓN DE PREFIJO, seguida de punto. Solo eso se quita.
 *
 * Y se quita del NOMBRE, no solo del concepto: el canonizador guarda el nombre tal como lo
 * escribió el primer lote, así que sin esto el cliente vería `opex.software` en su dashboard
 * aunque los dos rubros ya estuvieran unificados por dentro.
 */
export function sinPrefijoDeTipo(nombre: string): string {
  const punto = nombre.indexOf('.');
  if (punto <= 0) return nombre;
  const prefijo = nombre.slice(0, punto).trim().toLowerCase();
  if (!TIPOS_CONTABLES.has(prefijo)) return nombre;
  const resto = nombre.slice(punto + 1).trim();
  // `opex.` a secas no deja nada: se conserva el original antes que devolver vacío.
  return resto === '' ? nombre : resto;
}

function enPalabras(nombre: string): string[] {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '');
}

/**
 * Plural fuera, de la forma más tonta que funciona: quitar la `s` final.
 *
 * No se usa una librería de stemming ni reglas de irregulares. Lo único que hace falta acá es
 * que `ventas`/`venta` y `sales`/`sale` caigan juntos, y el costo de equivocarse es no
 * unificar. El umbral de 4 letras evita destrozar palabras cortas (`mes` → `me`).
 */
function sinPlural(token: string): string {
  return token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token;
}

/**
 * El CONCEPTO que nombra una categoría: su conjunto de palabras significativas, traducidas.
 *
 * Conjunto y no lista: `costo_de_ventas` y `ventas_costo` son el mismo concepto dicho en otro
 * orden, y ningún cliente los leería como dos rubros.
 */
/**
 * El lema de un token, probando las formas de plural que `sinPlural` no cubre.
 *
 * `sinPlural` quita la `s` final y con eso alcanza para `ventas`/`venta`. No alcanza para dos
 * formas que producción SÍ tiene (auditoría 2026-08-24):
 *
 *   · plural español en `-es`:  `comisiones` → `comisione`, y el lema es `comision`
 *   · plural inglés en `-ies`:  `supplies`   → `supplie`,   y el lema es `supply`
 *
 * Por eso `comisiones_ventas` y `sales_commissions` seguían siendo dos rubros en el dashboard
 * de CarsGT, igual que `cleaning_supplies` y `limpieza_suministros` en HeladosGT.
 *
 * Se prueban formas en orden y gana la primera que EXISTE en la tabla; si ninguna existe se
 * devuelve el token tal cual. O sea que agregar formas no puede unir de más: solo puede
 * encontrar un lema que ya estaba escrito.
 */
function lemaDe(token: string): string {
  const candidatos = [token];
  if (token.endsWith('e')) candidatos.push(token.slice(0, -1)); // comisione → comision
  if (token.endsWith('ie')) candidatos.push(`${token.slice(0, -2)}y`); // supplie → supply
  for (const c of candidatos) {
    const l = LEMAS[c];
    if (l !== undefined) return l;
  }
  return token;
}

export function conceptoDeCategoria(nombreCrudo: string): string {
  const nombre = sinPrefijoDeTipo(nombreCrudo);
  const palabras = enPalabras(nombre)
    .map(sinPlural)
    .filter((t) => !PALABRAS_GENERICAS.has(t))
    .map(lemaDe)
    .map(sinPlural);

  // Todo genérico (una categoría llamada "total_general"): se devuelve el nombre normalizado
  // completo en vez de la cadena vacía, que uniría cualquier par de nombres inútiles entre sí.
  const significativas = palabras.length > 0 ? palabras : enPalabras(nombre).map(sinPlural);
  return [...new Set(significativas)].sort().join('|');
}

/**
 * Cuántos lemas significativos hacen falta para que un subconjunto cuente como el mismo
 * concepto.
 *
 * DOS y no uno, y el uno rompe algo concreto: `gasto` está deliberadamente FUERA de
 * `PALABRAS_GENERICAS` porque "gasto_ventas no es ventas", y con un solo lema compartido
 * `{gasto}` sería subconjunto de `{gasto, sale}` y los uniría. Exigiendo dos, un nombre de una
 * sola palabra nunca absorbe a otro.
 */
const MIN_LEMAS_PARA_SUBCONJUNTO = 2;

/**
 * ¿El concepto de `a` está CONTENIDO en el de `b`?
 *
 * ═══ EL CASO QUE LO MOTIVA, MEDIDO EN PRODUCCIÓN (2026-08-24) ═══
 *
 * Un mismo gasto de una concesionaria salió con TRES nombres, uno por lote:
 *
 *     import_customs         11 filas   {custom, import}
 *     importacion_aduanas     8 filas   {custom, import}   ← ya lo une la tabla de lemas
 *     import_customs_duties   6 filas   {custom, dutie, import}
 *
 * El tercero no lo une ningún diccionario razonable: `duties` es un matiz que el modelo
 * agregó en ese lote y nada más. Pero sus palabras significativas CONTIENEN enteras a las del
 * primero, y eso es una señal estructural: nombran el mismo concepto con un detalle de más.
 *
 * Y no era solo cosmético. Como los tres contaban como veredictos distintos, el lote de
 * `import_customs_duties` no pudo heredar la confianza que el modelo ya le había dado al
 * mismo concepto en otro lote, y sus 6 filas se fueron a revisión interna.
 *
 * ═══ POR QUÉ ESTO SÍ Y NO "COMPARTEN ALGUNA PALABRA" ═══
 *
 * Compartir una palabra es barato y uniría cosas distintas: `servicios_publicos` y
 * `servicios_profesionales` comparten `utility`, son ambos `opex`, y colapsarlos le quitaría
 * al cliente la pantalla de gastos que este archivo ya defiende en otro test. Con la regla de
 * CONTENCIÓN ninguno de los dos contiene al otro —cada uno tiene una palabra propia que el
 * otro no tiene— así que siguen separados.
 *
 * La contención es asimétrica a propósito: dice "esto es aquello, con más detalle", que es
 * exactamente lo que un lote hace cuando agrega un matiz al nombre del anterior.
 */
function conceptoContenidoEn(a: string, b: string): boolean {
  const la = new Set(a.split('|').filter(Boolean));
  const lb = new Set(b.split('|').filter(Boolean));
  if (la.size < MIN_LEMAS_PARA_SUBCONJUNTO) return false;
  if (la.size >= lb.size) return false; // igual tamaño ya lo cubre la comparación exacta
  for (const t of la) if (!lb.has(t)) return false;
  return true;
}

/** ¿Dos nombres de categoría nombran lo mismo? */
export function sonElMismoConcepto(a: string, b: string): boolean {
  const ca = conceptoDeCategoria(a);
  const cb = conceptoDeCategoria(b);
  return ca === cb || conceptoContenidoEn(ca, cb) || conceptoContenidoEn(cb, ca);
}

/**
 * Fija el nombre de cada categoría DENTRO de una hoja: el primero que llegó, gana.
 *
 * Que gane el primero y no el más frecuente es la misma decisión —y por la misma razón— que
 * toma el mapa de columnas canónico: elegir el más frecuente exigiría esperar a que terminen
 * todos los lotes, que es justo el momento en que las filas ya están insertadas y el daño ya
 * está hecho.
 *
 * La clave incluye (entidad, tipo) además de la hoja: unificar nombres ENTRE tipos contables
 * distintos no tendría sentido —un `costo_de_ventas` que es `cogs` y uno que es `opex` son dos
 * hechos distintos aunque se llamen igual— y abriría la puerta a colapsos que nadie pidió.
 */
export class CanonizadorDeCategorias {
  /** `hoja\0entidad\0tipo\0concepto` → el nombre tal como lo escribió el primer lote. */
  private readonly canonicos = new Map<string, string>();

  /** Cuántas veces se reescribió un nombre. Solo para el log: es la prueba de que sirve. */
  private reescrituras = 0;

  private clave(sheetName: string, entity: string, type: string | null, categoria: string): string {
    return `${sheetName}\u0000${entity}\u0000${type ?? ''}\u0000${conceptoDeCategoria(categoria)}`;
  }

  /**
   * Devuelve el nombre canónico para esta categoría, registrándola si es la primera de su
   * concepto. Nunca devuelve un nombre que el modelo no haya escrito en esta hoja.
   */
  canonizar(
    sheetName: string,
    entity: string,
    type: string | null,
    categoria: string | null,
  ): string | null {
    if (categoria === null) return null;
    // El prefijo del tipo se quita del NOMBRE, no solo del concepto: es lo que el cliente lee.
    const limpia = sinPrefijoDeTipo(categoria.trim()).trim();
    if (limpia === '') return null;

    const k = this.clave(sheetName, entity, type, limpia);
    const yaFijada = this.canonicos.get(k);
    if (yaFijada === undefined) {
      this.canonicos.set(k, limpia);
      return limpia;
    }
    if (yaFijada !== limpia) this.reescrituras++;
    return yaFijada;
  }

  get nombresUnificados(): number {
    return this.reescrituras;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * PARTE 2 — DECIDIR SI LA HOJA ES HOMOGÉNEA
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Lotes de SONDA: cuántas llamadas reales se hacen antes de poder decidir.
 *
 * Tres y no uno. Un solo lote no distingue "hoja homogénea" de "los primeros 57 renglones
 * resultaron parecidos" — y las hojas de PYME suelen venir ordenadas por fecha, así que el
 * arranque de una hoja no es una muestra representativa de nada. Tres lotes separados que
 * coinciden entre sí ya son un patrón.
 *
 * Tres y no diez porque el ahorro se lo come el peaje: en una hoja de 5 lotes, sondear 10 es
 * no cortocircuitar nunca; y el costo de la sonda es el piso de lo que cualquier hoja va a
 * costar siempre.
 */
export const SONDA_LOTES = 3;

/**
 * Filas mínimas observadas antes de decidir. Cubre el caso de la hoja corta: tres lotes de 4
 * filas coinciden por casualidad, no por homogeneidad. Con menos filas que esto no se
 * cortocircuita nada — y tampoco hace falta, porque una hoja así ya cuesta centavos.
 */
export const SONDA_MIN_FILAS = 120;

/**
 * Qué proporción de las filas de la sonda tiene que compartir el MISMO veredicto completo
 * (entidad + tipo + categoría canónica) para dar la hoja por homogénea.
 *
 * 98 % y no 100 %: exigir unanimidad haría que una sola fila rara —un ajuste, una devolución
 * suelta— desactivara el ahorro en una hoja de 18.000 filas que por lo demás es un bloque.
 * 98 % y no 90 %: el 10 % de 18.000 filas son 1.800 movimientos del cliente clasificados por
 * inercia, que es demasiado para un ahorro.
 *
 * Medido contra el archivo real: `Ventas` da 100 % y pasa; `Gastos_Operativos`, cuya categoría
 * más frecuente cubre el 11 %, no se acerca y sigue yendo entera al modelo.
 */
export const UMBRAL_HOMOGENEIDAD = 0.98;

/**
 * Tope de filas que el modelo declaró "no son datos" (`skip`) en la sonda.
 *
 * Una hoja con subtotales intercalados cada tantas filas —muy común en un Excel hecho a mano—
 * tiene estructura que el cortocircuito no puede leer: aplicaría el veredicto dominante a un
 * renglón de subtotal y le sumaría al cliente un ingreso que no existe. `staging-rules.ts`
 * atraparía a la mayoría por fecha inválida, pero un subtotal CON fecha pasaría, y ese es el
 * error que no queremos correr. Si la hoja trae ruido estructural, va entera al modelo.
 */
export const MAX_SKIP_EN_SONDA = 0.02;

/**
 * Cuáles de los `total` lotes de una hoja forman la sonda: REPARTIDOS, no los primeros.
 *
 * ═══ POR QUÉ NO LOS PRIMEROS, QUE ERA LO OBVIO ═══
 *
 * Las hojas de PYME vienen ordenadas por fecha, así que los primeros lotes son enero y los
 * últimos son el mes pasado. Peor: un Excel hecho a mano cierra su tabla con un renglón de
 * TOTAL, y a veces con subtotales por trimestre — todo eso vive al FINAL de la hoja, que es
 * exactamente lo que una sonda de "los primeros tres" nunca ve.
 *
 * Ese era un punto ciego real del tope de `skip`: mide ruido estructural sobre una muestra
 * tomada donde el ruido no está. Con la sonda repartida —primero, medio, último— un cierre de
 * tabla entra en la muestra, sube la tasa de `skip` y el consenso se deniega, que es lo
 * correcto.
 *
 * Cuesta lo mismo: son las mismas `cuantos` llamadas, solo a otros lotes.
 */
export function elegirSonda(total: number, cuantos: number = SONDA_LOTES): number[] {
  if (total <= cuantos) return Array.from({ length: total }, (_, i) => i);

  // Extremos incluidos y el resto repartido parejo. El `Set` cubre el redondeo: con total 4 y
  // cuantos 3, dos posiciones podrían caer en el mismo lote.
  const elegidos = new Set<number>();
  for (let k = 0; k < cuantos; k++) {
    elegidos.add(Math.round((k * (total - 1)) / (cuantos - 1)));
  }
  // Si el redondeo colapsó alguna, se rellena con los primeros que falten: la sonda nunca
  // devuelve menos lotes de los que se pidieron, porque `decidir` cuenta lotes para decidir.
  for (let i = 0; elegidos.size < cuantos && i < total; i++) elegidos.add(i);
  return [...elegidos].sort((a, b) => a - b);
}

export type Homogeneidad =
  { homogenea: true; veredicto: VeredictoDominante } | { homogenea: false; motivo: string };

/**
 * Acumula los veredictos crudos de los lotes de sonda de UNA hoja y decide si el resto de sus
 * lotes puede resolverse sin el modelo.
 */
export class ConsensoDeHoja {
  private lotes = 0;
  private filas = 0;
  private skips = 0;
  /** `entidad\0tipo\0categoría canónica` → { veces, suma de confianzas }. */
  private readonly conteos = new Map<string, { n: number; sumaConf: number }>();

  /**
   * Registra un lote YA CANONICALIZADO. Recibe los veredictos crudos del modelo (incluidos los
   * `skip`, que son parte de la evidencia sobre la forma de la hoja) y no las filas armadas: en
   * las filas armadas cada venta con costo aparece DOS veces —la de ingreso y la de costo que
   * `construirFilas` deriva— y contar la derivada haría ver como mezclada una hoja que es
   * perfectamente uniforme.
   */
  registrarLote(veredictos: { e: string; t: string | null; c: string | null; cf: number }[]): void {
    this.lotes++;
    for (const v of veredictos) {
      this.filas++;
      if (v.e === 'skip') {
        this.skips++;
        continue;
      }
      const k = `${v.e}\u0000${v.t ?? ''}\u0000${v.c ?? ''}`;
      const prev = this.conteos.get(k) ?? { n: 0, sumaConf: 0 };
      prev.n++;
      prev.sumaConf += typeof v.cf === 'number' && Number.isFinite(v.cf) ? v.cf : 0;
      this.conteos.set(k, prev);
    }
  }

  get lotesObservados(): number {
    return this.lotes;
  }

  /**
   * ¿Se puede dejar de llamar al modelo para esta hoja?
   *
   * Devuelve el motivo cuando no, y no un simple `false`, porque este es el número que dice si
   * el ahorro está funcionando en producción y por qué no lo hace en un archivo concreto. Sin
   * el motivo, diagnosticar "¿por qué esta hoja sigue costando USD 15?" obliga a reproducir la
   * carga.
   */
  decidir(columns: ColumnMap): Homogeneidad {
    if (this.lotes < SONDA_LOTES) {
      return { homogenea: false, motivo: `solo ${this.lotes} lote(s) de sonda` };
    }
    if (this.filas < SONDA_MIN_FILAS) {
      return { homogenea: false, motivo: `solo ${this.filas} filas observadas` };
    }

    /*
     * Sin columna de MONTO no hay forma de comprobar que una fila se parece a las que el
     * modelo bendijo, y sin esa comprobación el cortocircuito sería fe. La de FECHA se exige
     * por lo mismo y además porque es lo que distingue un movimiento de un subtotal.
     */
    if (columns.amount === null || columns.date === null) {
      return { homogenea: false, motivo: 'la hoja no tiene columna de fecha y monto mapeadas' };
    }

    const utiles = this.filas - this.skips;
    if (utiles <= 0) return { homogenea: false, motivo: 'la sonda no produjo filas de datos' };
    if (this.skips / this.filas > MAX_SKIP_EN_SONDA) {
      return {
        homogenea: false,
        motivo: `${this.skips} de ${this.filas} filas de la sonda no son datos (estructura mezclada)`,
      };
    }

    let mejorClave: string | null = null;
    let mejor = { n: 0, sumaConf: 0 };
    for (const [k, v] of this.conteos) {
      if (v.n > mejor.n) {
        mejorClave = k;
        mejor = v;
      }
    }
    if (mejorClave === null) return { homogenea: false, motivo: 'sin veredictos' };

    const cobertura = mejor.n / utiles;
    if (cobertura < UMBRAL_HOMOGENEIDAD) {
      return {
        homogenea: false,
        motivo: `el veredicto más común cubre ${Math.round(cobertura * 100)} % de las filas (hace falta ${Math.round(UMBRAL_HOMOGENEIDAD * 100)} %)`,
      };
    }

    const [e, t, c] = mejorClave.split('\u0000') as [string, string, string];
    return {
      homogenea: true,
      veredicto: {
        targetEntity: e as VeredictoDominante['targetEntity'],
        type: (t === '' ? null : t) as VeredictoDominante['type'],
        category: c === '' ? null : c,
        confidence: mejor.sumaConf / mejor.n,
      },
    };
  }
}

/**
 * ¿Esta fila se parece lo suficiente a las que el modelo ya clasificó?
 *
 * Es el último candado del cortocircuito, y el que evita el error que más caro sale: aplicarle
 * el veredicto de una venta a un renglón que no es una venta. Un Excel de PYME mete títulos de
 * sección, subtotales por mes y una fila de TOTAL al final de la tabla; ninguno tiene fecha y
 * monto a la vez en las columnas donde los tienen los movimientos.
 *
 * Solo se exige eso —fecha y monto legibles en las columnas que el mapa señala— y no un
 * parecido más fino, porque es exactamente el mínimo que `staging-rules.ts` va a exigir después
 * para promover la fila. Pedir más marcaría filas buenas; pedir menos dejaría pasar renglones
 * que no son movimientos.
 *
 * Las filas que no pasan NO se descartan: van a revisión interna. Ver el worker.
 */
export function filaAptaParaCortocircuito(row: unknown[], columns: ColumnMap): boolean {
  if (columns.amount === null || columns.date === null) return false;

  const monto = asNumber(row[columns.amount]);
  if (monto === null || monto === 0) return false;

  return asDate(row[columns.date]) !== null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONFIANZA UNIFORME EN UN LOTE ES UN JUICIO SOBRE EL LOTE, NO SOBRE LA FILA
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Tercer campo que el modelo decide por lote, después del mapa de columnas (lo cubre
 * `assertMismoMapa`) y de la categoría (lo cubre `CanonizadorDeCategorias`). Era el único de
 * los tres sin protección, y se vio en producción.
 *
 * `Concesionaria_Guatemala`, CarsGT, 2026-08-24 — la hoja `Ventas`, 240 filas indistinguibles
 * entre sí, en tres lotes:
 *
 *     lote 0   87 filas   cf 0,92   → pasan
 *     lote 1   83 filas   cf 0,75   → pasan
 *     lote 2   74 filas   cf 0,60   → LAS 148 FILAS MARCADAS DEL REPORTE
 *
 * Los tres números son EXACTOS y uniformes dentro de su lote: ni una fila difiere de sus
 * vecinas. Eso no es el modelo dudando de 74 ventas concretas — es el modelo poniéndole una
 * nota al lote. Con `CONFIDENCE_THRESHOLD` en 0,7, esa nota decidió el destino de filas
 * individuales: **la misma venta pasa o va a revisión interna según en qué lote cayó.**
 *
 * El staff que abría esa cola veía "Mazda 3, Sucursal Vista Hermosa, 2026-06-10, Q 200.400,
 * venta_vehiculos" y no encontraba qué revisar, porque no había nada que revisar.
 *
 * ═══ LA REGLA, Y POR QUÉ NO DESACTIVA LA RED DE SEGURIDAD ═══
 *
 * Solo se unifica cuando la confianza es UNIFORME en todo el lote. Si el modelo dio números
 * distintos dentro del mismo lote, esa variación SÍ distingue filas —es exactamente el juicio
 * por fila que el prompt pide— y se respeta tal cual, sin tocarla.
 *
 * Y solo se SUBE, nunca se baja, hasta el máximo que el modelo ya le dio a ESE MISMO veredicto
 * en ESTA MISMA hoja. No es un número inventado: es el propio modelo diciendo, sobre filas
 * indistinguibles, que las entiende bien. Si nunca dio uno más alto, la confianza queda como
 * está y la fila se marca igual que hoy.
 *
 * ═══ LO QUE SIGUE PROTEGIENDO A LA FILA ═══
 *
 * `staging-rules` valida fecha, monto y categoría POR SEPARADO de la confianza. Una fila sin
 * fecha legible se marca por `invalid_date` aunque su confianza sea 1,0, así que subirla no
 * mete basura en la contabilidad: lo único que deja de pasar es que una fila buena vaya a
 * revisión por el lote en que le tocó viajar.
 *
 * ═══ DEPENDE DEL ORDEN, Y ESO ES ACEPTABLE — PERO HAY QUE DECIRLO ═══
 *
 * Se compara contra el máximo visto HASTA AHORA, porque las filas se insertan lote a lote y
 * no hay forma de consultar el futuro sin retener la carga entera en memoria. Si el lote más
 * confiado llega último, los anteriores ya se marcaron. El peor caso es entonces exactamente
 * lo que pasa hoy, y el mejor lo arregla del todo: no hay forma de quedar peor. Es la misma
 * concesión que hace el canonizador con "el primero que llegó gana", y por la misma razón.
 */
/** Lo mínimo que este ajuste necesita de un veredicto; `cf` se modifica en el sitio. */
export interface VeredictoDeFila {
  e: string;
  t: string | null;
  c: string | null;
  cf: number;
}

export class ConfianzaPorHoja {
  /** `hoja\0entidad\0tipo\0categoría` → la mayor confianza vista para ese veredicto. */
  private readonly techos = new Map<string, number>();

  /** Cuántas filas se elevaron. Solo para el log: es la prueba de que sirve. */
  private elevadas = 0;

  private clave(sheetName: string, v: { e: string; t: string | null; c: string | null }): string {
    return `${sheetName}\u0000${v.e}\u0000${v.t ?? ''}\u0000${v.c ?? ''}`;
  }

  /**
   * Ajusta las confianzas de un lote YA CANONICALIZADO, en el sitio.
   *
   * Recibe el lote entero y no fila por fila porque la pregunta que decide —"¿es uniforme?"—
   * no se puede contestar mirando una sola fila.
   */
  registrarLote(sheetName: string, veredictos: VeredictoDeFila[]): void {
    const utiles = veredictos.filter((v) => v.e !== 'skip');
    if (utiles.length === 0) return;

    /*
     * Los `skip` quedan fuera del juicio de uniformidad: son filas que el modelo declaró que
     * no son datos, y su confianza no habla del criterio con que clasificó las demás.
     */
    const uniforme = utiles.every((v) => v.cf === utiles[0]!.cf);

    for (const v of utiles) {
      const k = this.clave(sheetName, v);
      const techo = this.techos.get(k);

      if (techo === undefined || v.cf > techo) {
        this.techos.set(k, v.cf);
        continue;
      }

      // Solo se eleva lo que el modelo no distinguió. Una variación dentro del lote es juicio
      // por fila y se deja intacta.
      if (uniforme && techo > v.cf) {
        v.cf = techo;
        this.elevadas++;
      }
    }
  }

  get filasElevadas(): number {
    return this.elevadas;
  }
}
