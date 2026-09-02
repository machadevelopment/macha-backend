import { dobleDeModelo, serial, type LibroHostil, type Verdad } from './pipeline-doble';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL ABISMO: EL LIBRO QUE SOLO SE ARREGLA DECIDIENDO
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `libro-el-infierno` junta todos los modos de fallo que el PIPELINE tiene que resolver solo.
 * Éste es el complemento exacto: junta los que el pipeline **no puede** resolver solo, porque
 * la información que falta no está en el archivo — está en la cabeza del dueño.
 *
 * Cada hoja de acá entra MAL por defecto, con alta confianza y sin que nada falle, y se
 * endereza con una decisión concreta del dueño en la pantalla de confirmación. O sea que este
 * libro no prueba el pipeline: prueba **el portón y la tarjeta de conceptos**, que son lo que
 * se construyó entre el 2026-09-01 y el 2026-09-02.
 *
 * ⚠️ La diferencia con el infierno importa para leer un fallo: si el infierno se rompe, hay un
 * bug en un filtro. Si el abismo se rompe **sin que nadie toque nada**, no hay bug — así es
 * como debe entrar. El fallo es que la corrección NO arregle la cifra.
 *
 * ═══ LAS SEIS TRAMPAS, Y QUÉ TIENE QUE HACER EL DUEÑO ═══
 *
 *  1. `Vehiculos_Stock` — inventario serializado por VIN que NINGUNA otra hoja referencia.
 *     Entra como GASTO: es el hueco medido de Q 1.864.500 que nadie desembolsó. El esquema del
 *     libro no puede verlo (nada la apunta) y la firma de existencias tampoco (no dice
 *     "stock" ni trae columna de cantidad).
 *     → **"Mi inventario"**, y el egreso falso desaparece.
 *
 *  2. `Cobros_Recibidos` — cobros de las facturas de `Facturacion`. Tienen fecha, cliente y
 *     monto, así que el modelo los lee como ventas nuevas: el ingreso se cuenta DOS veces.
 *     Acá el enlace SÍ existe (`No. Factura`), así que `ventaYaRegistradaEnOtraHoja` debería
 *     suprimirlos — está puesto para verificar que esa guarda sigue viva.
 *     → nada que hacer si el pipeline acierta; si no, **"Una cuenta por cobrar"**.
 *
 *  3. `Anticipos_Socios` — movimientos que NO son ni ingreso ni costo ni gasto. Entran como
 *     `other`, se guardan y **no aparecen en ninguna cifra**. Es el único caso donde la
 *     pantalla tiene que decir "no suma en ninguna pantalla" en tono de aviso.
 *     → el dueño ve el aviso y decide: dejarlo así o reclasificarlo.
 *
 *  4. `Ventas_Sucursales` — ventas CON producto Y tienda. No es una trampa: está para que los
 *     chips de destino tengan algo que mostrar. Una fila de acá llega a CUATRO pantallas
 *     (Ingresos, Flujo de caja, Ventas por producto, Ventas por tienda) y ese es justamente el
 *     caso que el portón callaba antes.
 *
 *  5. `Compras_Credito` — cuentas por pagar SIN tipo. El modelo no sabe si es mercadería o
 *     alquiler, y elegir por él inflaría el margen bruto de cualquier comercio. Llegan
 *     marcadas y las contesta el cliente; contestar tiene que MOVER el costo (regla del
 *     2026-09-01: contestar una cuenta por pagar produce su costo).
 *
 *  6. `Consultoria_Q1` — la trampa fina: se ve idéntica a una hoja de gastos y en realidad son
 *     los honorarios que la empresa COBRA. Alta confianza, categoría plausible, y el signo del
 *     resultado invertido. Ninguna señal automática puede saberlo — solo el dueño.
 *     → **"Un ingreso"** desde la tarjeta de conceptos.
 *
 * ═══ LA VERDAD DE CAMPO ES LA DE DESPUÉS DE CORREGIR ═══
 *
 * `verdad` es lo que el dashboard tiene que mostrar **una vez que el dueño hizo las tres
 * correcciones**. Al subirlo tal cual, las cifras van a estar mal a propósito, y por cuánto
 * está escrito abajo en `rompe`. Ese delta ES la prueba.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

function contador() {
  const v: Verdad = { revenue: 0, cogs: 0, opex: 0 };
  return { v, mas: (k: keyof Verdad, n: number) => (v[k] = r2(v[k] + n)) };
}

export function libroElAbismo(): LibroHostil {
  const { v, mas } = contador();

  /* ── 1. El inventario que nadie referencia ────────────────────────────────────────────── */
  const vehiculos: unknown[][] = [
    ['No. Serie', 'Marca', 'Linea', 'Modelo', 'Color', 'Costo Adquisicion', 'Fecha Ingreso'],
  ];
  let costoStock = 0;
  for (let i = 0; i < 18; i++) {
    const costo = 92_000 + i * 4_150;
    costoStock = r2(costoStock + costo);
    vehiculos.push([
      `9BWZZZ377VT${String(400_100 + i * 7)}`,
      ['Toyota', 'Mazda', 'Kia'][i % 3],
      ['Hilux', 'CX-5', 'Sportage'][i % 3],
      2024 + (i % 2),
      ['Blanco', 'Gris', 'Negro'][i % 3],
      costo,
      serial(`2026-0${(i % 6) + 1}-${String(3 + (i % 22)).padStart(2, '0')}`),
    ]);
  }
  // NO entra a la verdad: son existencias, no un egreso. Ese es el punto del libro.

  /* ── 2. Facturación y sus cobros ──────────────────────────────────────────────────────── */
  const facturacion: unknown[][] = [
    ['Fecha Emision', 'No. Factura', 'Cliente', 'Monto', 'Moneda', 'Fecha Vencimiento'],
  ];
  const cobros: unknown[][] = [['Fecha Cobro', 'No. Factura', 'Cliente', 'Monto Recibido']];
  for (let i = 0; i < 14; i++) {
    const monto = 18_400 + i * 725;
    mas('revenue', monto); // Devenga UNA vez, al emitir.
    const doc = `FAC-2026-${2100 + i}`;
    facturacion.push([
      serial(`2026-0${(i % 7) + 1}-${String(2 + (i % 24)).padStart(2, '0')}`),
      doc,
      `Corporación ${String.fromCharCode(65 + (i % 6))} S.A.`,
      monto,
      'GTQ',
      serial(`2026-0${(i % 7) + 2}-${String(2 + (i % 24)).padStart(2, '0')}`),
    ]);
    // Solo se cobraron 9 de las 14: la cartera abierta tiene que quedar en Por cobrar.
    if (i < 9) {
      cobros.push([
        serial(`2026-0${(i % 7) + 2}-${String(10 + (i % 15)).padStart(2, '0')}`),
        doc,
        `Corporación ${String.fromCharCode(65 + (i % 6))} S.A.`,
        monto,
      ]);
    }
  }

  /* ── 3. Los movimientos que no son de nadie ───────────────────────────────────────────── */
  const anticipos: unknown[][] = [['Fecha', 'Concepto', 'Monto', 'Moneda']];
  for (let i = 0; i < 5; i++) {
    anticipos.push([
      serial(`2026-0${i + 2}-15`),
      i % 2 === 0 ? 'Anticipo a cuenta de socio' : 'Traslado entre cuentas propias',
      12_000 + i * 500,
      'GTQ',
    ]);
  }
  // No entra a la verdad: `other` no lo suma ninguna pantalla, y eso es correcto.

  /* ── 4. Ventas con producto Y tienda ──────────────────────────────────────────────────── */
  const sucursales: unknown[][] = [
    ['Fecha', 'Sucursal', 'Producto', 'Categoria', 'Cantidad', 'Precio Unitario', 'Total'],
  ];
  const CATALOGO: [string, string, number][] = [
    ['Café Kapel 500g', 'Bebidas', 78],
    ['Molino Manual', 'Equipo', 465],
    ['Filtro V60', 'Accesorios', 112],
    ['Taza Cerámica', 'Accesorios', 89],
  ];
  const TIENDAS = ['Zona 10', 'Zona 4', 'Cayalá'];
  for (let i = 0; i < 24; i++) {
    const [prod, cat, precio] = CATALOGO[i % 4]!;
    const cantidad = 3 + (i % 7);
    const total = r2(cantidad * precio);
    mas('revenue', total);
    sucursales.push([
      serial(`2026-0${(i % 8) + 1}-${String(5 + (i % 20)).padStart(2, '0')}`),
      TIENDAS[i % 3],
      prod,
      cat,
      cantidad,
      precio,
      total,
    ]);
  }

  /* ── 5. Cuentas por pagar sin tipo ────────────────────────────────────────────────────── */
  const compras: unknown[][] = [
    ['Fecha', 'No. Orden', 'Proveedor', 'Descripcion', 'Monto', 'Vence'],
  ];
  /*
   * Tres conceptos, no doce filas sueltas: la tarjeta pregunta por CONCEPTO, así que un archivo
   * con doce proveedores distintos daría doce preguntas y no probaría el agrupado — que es lo
   * que hace contestable la pantalla.
   */
  const PROVEEDORES: [string, string, 'cogs' | 'opex'][] = [
    ['Tostaduría del Sur', 'Grano verde para tostar', 'cogs'],
    ['Inmobiliaria Reforma', 'Renta del local comercial', 'opex'],
    ['Empaques Guatemala', 'Bolsas y etiquetas', 'cogs'],
  ];
  for (let i = 0; i < 12; i++) {
    const [prov, desc, tipo] = PROVEEDORES[i % 3]!;
    const monto = 6_800 + i * 340;
    // Contestarlas tiene que MOVER esta cifra: es la regla de "contestar produce su costo".
    mas(tipo, monto);
    compras.push([
      serial(`2026-0${(i % 9) + 1}-${String(6 + (i % 18)).padStart(2, '0')}`),
      `OC-${5400 + i}`,
      prov,
      desc,
      monto,
      serial(`2026-0${(i % 9) + 2}-${String(6 + (i % 18)).padStart(2, '0')}`),
    ]);
  }

  /* ── 6. La trampa fina: honorarios COBRADOS que parecen gastos ────────────────────────── */
  const consultoria: unknown[][] = [['Fecha', 'Concepto', 'Monto', 'Moneda']];
  for (let i = 0; i < 6; i++) {
    const monto = 24_500 + i * 1_200;
    // Es INGRESO en la verdad. El modelo lo va a leer como gasto y nadie puede desmentirlo
    // desde el archivo: "Servicios de consultoría" se ve igual comprado que vendido.
    mas('revenue', monto);
    consultoria.push([
      serial(`2026-0${i + 1}-20`),
      'Servicios de consultoría profesional',
      monto,
      'GTQ',
    ]);
  }

  /* ── Ruido honesto: un catálogo y una portada ─────────────────────────────────────────── */
  const portada: unknown[][] = [
    ['LIBRO CONTABLE 2026'],
    ['Preparado por: Contabilidad Externa'],
    [],
    ['Uso interno. No distribuir.'],
  ];
  const catalogoProductos: unknown[][] = [
    ['Codigo', 'Producto', 'Categoria', 'Precio Lista', 'Costo Unitario'],
    ...CATALOGO.map(([p, c, precio], i) => [`SKU-${100 + i}`, p, c, precio, r2(precio * 0.62)]),
  ];

  return {
    archivo: '14-el-abismo.xlsx',
    titulo: 'El libro que solo se arregla DECIDIENDO (portón + tarjeta de conceptos)',
    rompe:
      'MEDIDO contra el pipeline: tal cual se sube, el dashboard muestra ingresos 349.403,00 · ' +
      'costo de ventas 2.290.950,00 · gastos 165.000,00, y **nada falla**. Las tres cifras ' +
      'están mal, cada una por su motivo. (1) COSTO DE VENTAS: son ' +
      `GTQ ${costoStock.toLocaleString('es-GT')} de vehículos EN STOCK — el egreso completo es ` +
      'inventado, y el costo REAL de la empresa (69.360,00, sus compras a crédito) no está, ' +
      'porque `Compras_Credito` llega sin tipo. La cifra correcta es 1/33 de la que se ve. ' +
      '(2) GASTOS: los 165.000,00 son honorarios que la empresa COBRA, leídos como gasto. ' +
      '(3) INGRESOS: faltan esos mismos 165.000,00, así que la utilidad sale mal por el doble ' +
      '— falta arriba y sobra abajo. Se endereza con TRES decisiones: «Mi inventario» sobre ' +
      'Vehiculos_Stock, «Un ingreso» sobre el concepto de consultoría, y contestar los tres ' +
      'conceptos de `Compras_Credito`. La verdad de la tabla es la de DESPUÉS de corregir. ' +
      'Y lo que ya tiene que estar bien SIN tocar nada: `Cobros_Recibidos` no devenga de ' +
      'nuevo (0 movimientos, la guarda sigue viva), `Anticipos_Socios` entra como `other` y ' +
      'la pantalla lo avisa, y `Portada`/`Productos` no producen nada.',
    hojas: [
      ['Portada', portada],
      ['Facturacion', facturacion],
      ['Cobros_Recibidos', cobros],
      ['Ventas_Sucursales', sucursales],
      ['Compras_Credito', compras],
      ['Consultoria_Q1', consultoria],
      ['Vehiculos_Stock', vehiculos],
      ['Anticipos_Socios', anticipos],
      ['Productos', catalogoProductos],
    ],
    verdad: v,
    /*
     * El doble es IGNORANTE a propósito, igual que el del infierno: clasifica bien lo que se le
     * da y hace lo ÚNICO razonable con lo que no. Sobre el stock ve costo + fecha + producto y
     * concluye "costo de ventas", que es exactamente lo que hizo el modelo real con CarsGT; y
     * sobre la consultoría ve un concepto de servicio y concluye "gasto". Un doble omnisciente
     * taparía justo lo que este libro existe para medir.
     */
    clasificar: dobleDeModelo({
      tipos: {
        Facturacion: 'revenue',
        Cobros_Recibidos: 'revenue',
        Ventas_Sucursales: 'revenue',
        Consultoria_Q1: 'opex',
        Vehiculos_Stock: 'cogs',
        Anticipos_Socios: 'other',
      },
      entidades: { Facturacion: 'invoice', Compras_Credito: 'bill' },
    }),
    /*
     * ⚠️ NO se fija un número de marcadas, y es deliberado. Cuántas filas quedan a revisión
     * depende de la confianza del MODELO REAL sobre `Compras_Credito` y `Consultoria_Q1`, y
     * este libro se sube por la aplicación de verdad — no por el doble. Fijarlo acá sería
     * afirmar sobre algo que este archivo no controla.
     */
  };
}
