import { dobleDeModelo, serial, type LibroHostil, type Tipo, type Verdad } from './pipeline-doble';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * GENERADOR DE LIBROS CON VERDAD CONOCIDA — PARA DEJAR DE ENCONTRAR BUGS POR CAPTURA DE PANTALLA
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Los libros escritos a mano (`libros.ts`, `libro-la-ceiba.ts`) cubren los casos que ya
 * conocemos. El problema es que **los fallos de esta ingesta no viven en un filtro sino en la
 * COMBINACIÓN de filtros**, y ese espacio es demasiado grande para escribirlo a mano: doce
 * decisiones en cascada por cada forma de libro posible.
 *
 * La prueba de que hace falta: el acantilado de `MIN_VALORES_PARA_RELACION` (una hoja de cobros
 * con SEIS filas duplicaba el 45 % del ingreso, con ocho no) habría caído solo variando **un**
 * parámetro — la cantidad de filas. Doce libros escritos a mano no lo encontraron; una tarde de
 * permutaciones sí.
 *
 * ═══ POR QUÉ ESTO PUEDE AFIRMAR ALGO QUE UN TEST NORMAL NO ═══
 *
 * Porque la verdad **se genera junto con el archivo**: no se estima cuánto ingreso hay, se suma
 * al escribir cada fila. Así la aserción es la única que importa —las tres cifras del
 * dashboard— sobre libros que nadie diseñó para pasar.
 *
 * Y el modelo se sustituye por el doble determinista de `pipeline-doble.ts`, que acierta por
 * construcción. Eso **aísla la variable**: si con un modelo perfecto la cifra sale mal, el
 * defecto es del código. Es lo que resultó ser en los siete reportes de clientes.
 *
 * ═══ SEMILLA EXPLÍCITA, NUNCA `Math.random()` ═══
 *
 * Un fuzzer que no se puede reproducir es un test que falla en CI y pasa en tu máquina. Cada
 * libro sale de un entero, así que un fallo se reproduce con `generarLibro(1234)` y se puede
 * pegar tal cual en un test de regresión.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

/** PRNG determinista (mulberry32). No hace falta calidad criptográfica; hace falta REPETIBLE. */
function prng(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MESES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]; // prettier-ignore

/**
 * Las cinco formas en que un archivo real escribe una fecha.
 *
 * No cambian los totales —una fecha mal leída mueve el movimiento de mes, no lo borra— pero sí
 * deciden si la hoja SOBREVIVE: sin columna de fecha legible, `noPuedeProducirMovimientos` la
 * descarta entera y el dinero desaparece. Dos de estos formatos ya causaron ese fallo en
 * producción (el mes en español y el `MM/DD/YYYY`).
 */
type FormatoFecha = 'serial' | 'dmy' | 'iso' | 'palabras' | 'mdy';

function escribirFecha(iso: string, formato: FormatoFecha): unknown {
  const [a, m, d] = iso.split('-') as [string, string, string];
  switch (formato) {
    case 'serial':
      return serial(iso);
    case 'dmy':
      return `${d}/${m}/${a}`;
    case 'mdy':
      return `${m}/${d}/${a}`;
    case 'iso':
      return iso;
    case 'palabras':
      return `${Number(d)} de ${MESES_ES[Number(m) - 1]} de ${a}`;
  }
}

export interface OpcionesDeLibro {
  formatoFecha: FormatoFecha;
  /** Líneas de título por encima del encabezado real. */
  titulos: number;
  filasVentas: number;
  filasGastos: number;
  /** Los egresos se escriben en negativo, como hacen muchos exportes. */
  egresosNegativos: boolean;
  /** La hoja de ventas trae su costo en la misma línea. */
  costoEnLaVenta: boolean;
  /** Un renglón de TOTAL al final de las ventas. */
  renglonDeTotal: boolean;
  /** Un consolidado propio que empata con el detalle. NO debe sumar. */
  resumenPropio: boolean;
  /** Cabecera + detalle de compras. Solo la cabecera debe sumar. */
  cabeceraYDetalle: boolean;
  /** Catálogo de clientes con fecha y dinero. NO debe sumar. */
  catalogoDeClientes: boolean;
  /** Existencias. NO debe sumar. */
  inventario: boolean;
  /** Los gastos vienen como matriz concepto × mes en vez de como listado. */
  gastosEnMatriz: boolean;
  /** Facturación que devenga ingreso + cobros de ESAS facturas, que no devengan de nuevo. */
  facturacionYCobros: boolean;
  filasCobros: number;
  /** Hoja de texto libre, sin una cifra. */
  hojaBasura: boolean;
}

/** Deriva un juego de opciones reproducible a partir de una semilla. */
export function opcionesDeSemilla(semilla: number): OpcionesDeLibro {
  const r = prng(semilla);
  const elegir = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const quizas = (p = 0.5) => r() < p;

  return {
    formatoFecha: elegir<FormatoFecha>(['serial', 'dmy', 'iso', 'palabras', 'mdy']),
    titulos: elegir([0, 1, 2]),
    /*
     * Los tamaños chicos están a propósito y son el corazón del fuzzer: varios umbrales del
     * pipeline (8 valores para una relación, 8 filas para el dedup, 5 para juzgar una columna
     * de fechas) se apagan por debajo de cierto tamaño, y la contabilidad de una PYME chica
     * vive justo ahí. El acantilado de los cobros se encontró exactamente así.
     */
    filasVentas: elegir([4, 6, 9, 14, 25, 60]),
    filasGastos: elegir([3, 5, 8, 12, 30]),
    egresosNegativos: quizas(0.3),
    costoEnLaVenta: quizas(0.5),
    renglonDeTotal: quizas(0.4),
    resumenPropio: quizas(0.35),
    cabeceraYDetalle: quizas(0.35),
    catalogoDeClientes: quizas(0.5),
    inventario: quizas(0.4),
    gastosEnMatriz: quizas(0.35),
    facturacionYCobros: quizas(0.4),
    filasCobros: elegir([2, 3, 5, 6, 9, 12]),
    hojaBasura: quizas(0.3),
  };
}

const TASA_USD = 7.7;

/**
 * Construye un libro y su verdad de campo a partir de una semilla.
 *
 * Cada `mas(...)` ocurre en la misma línea en que se escribe la fila que lo genera, así que la
 * cifra esperada no es una estimación sobre el archivo: es el archivo.
 */
export function generarLibro(semilla: number, opciones?: Partial<OpcionesDeLibro>): LibroHostil {
  const o = { ...opcionesDeSemilla(semilla), ...opciones };
  const v: Verdad = { revenue: 0, cogs: 0, opex: 0 };
  const mas = (k: keyof Verdad, n: number) => (v[k] = r2(v[k] + n));

  const f = (iso: string) => escribirFecha(iso, o.formatoFecha);
  const dia = (i: number) => {
    const mes = (i % 8) + 1;
    const d = ((i * 3) % 27) + 1;
    return `2026-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  const hojas: [string, unknown[][]][] = [];
  const tipos: Record<string, Tipo> = {};
  const entidades: Record<string, 'transaction' | 'invoice' | 'bill'> = {};

  const conTitulos = (filas: unknown[][], nombre: string): unknown[][] => {
    const cabecera: unknown[][] = [];
    for (let i = 0; i < o.titulos; i++) {
      cabecera.push([i === 0 ? 'DISTRIBUIDORA DE PRUEBA, S.A.' : `${nombre} · ejercicio 2026`]);
    }
    return [...cabecera, ...filas];
  };

  /* ── Ventas: siempre, y siempre debe sumar ── */
  const encabezadoVentas = ['Fecha', 'Cliente', 'Producto', 'Cantidad', 'Monto'];
  if (o.costoEnLaVenta) encabezadoVentas.push('Costo Unitario');
  const ventas: unknown[][] = [encabezadoVentas];
  for (let i = 0; i < o.filasVentas; i++) {
    const cantidad = 1 + (i % 4);
    const monto = r2(180 + i * 37.5);
    const costoUnit = r2(60 + (i % 5) * 4);
    mas('revenue', monto);
    if (o.costoEnLaVenta) mas('cogs', r2(costoUnit * cantidad));
    const fila: unknown[] = [f(dia(i)), `Cliente ${i % 7}`, `Producto ${i % 5}`, cantidad, monto];
    if (o.costoEnLaVenta) fila.push(costoUnit);
    ventas.push(fila);
  }
  if (o.renglonDeTotal) {
    ventas.push(['', 'TOTAL', '', '', ventas.slice(1).reduce((a, x) => a + Number(x[4]), 0)]);
  }
  hojas.push(['Ventas', conTitulos(ventas, 'Ventas')]);
  tipos['Ventas'] = 'revenue';

  /* ── Gastos: listado o matriz por mes. Siempre debe sumar, entre por donde entre ── */
  if (o.gastosEnMatriz) {
    const rubros = ['Renta del local', 'Planilla', 'Servicios', 'Publicidad', 'Contabilidad'];
    const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio'];
    const matriz: unknown[][] = [['Concepto', ...meses]];
    for (const [k, rubro] of rubros.entries()) {
      const fila: unknown[] = [rubro];
      for (let m = 0; m < meses.length; m++) {
        const monto = r2(900 + k * 120 + m * 15);
        mas('opex', monto);
        fila.push(monto);
      }
      matriz.push(fila);
    }
    hojas.push(['Gastos_Mensuales', matriz]);
    tipos['Gastos_Mensuales'] = 'opex';
  } else {
    const gastos: unknown[][] = [['Fecha', 'Proveedor', 'Concepto', 'Monto']];
    for (let i = 0; i < o.filasGastos; i++) {
      const monto = r2(240 + i * 55);
      mas('opex', monto);
      gastos.push([
        f(dia(i + 2)),
        `Proveedor ${i % 4}`,
        ['Renta', 'Planilla', 'Luz', 'Internet'][i % 4],
        o.egresosNegativos ? -monto : monto,
      ]);
    }
    hojas.push(['Gastos', gastos]);
    tipos['Gastos'] = 'opex';
  }

  /* ── Un consolidado del propio libro: empata con Ventas y NO debe sumar ── */
  if (o.resumenPropio) {
    const porMes = new Map<number, number>();
    for (let i = 0; i < o.filasVentas; i++) {
      const mes = (i % 8) + 1;
      porMes.set(mes, r2((porMes.get(mes) ?? 0) + r2(180 + i * 37.5)));
    }
    const resumen: unknown[][] = [['Mes', 'Total Ventas']];
    for (const [mes, total] of [...porMes.entries()].sort((a, b) => a[0] - b[0])) {
      resumen.push([serial(`2026-${String(mes).padStart(2, '0')}-01`), total]);
    }
    hojas.push(['Resumen_Mensual', resumen]);
    tipos['Resumen_Mensual'] = 'revenue';
  }

  /* ── Cabecera y detalle de compras: solo la cabecera debe sumar ── */
  if (o.cabeceraYDetalle) {
    const ordenes: unknown[][] = [['IDOC', 'Fecha', 'Proveedor', 'Total']];
    const lineas: unknown[][] = [['IDLinea', 'IDOC', 'Producto', 'Cantidad', 'Costo Unitario']];
    for (let i = 0; i < 10; i++) {
      let total = 0;
      for (let k = 0; k < 3; k++) {
        const cant = 5 + ((i + k) % 7);
        const costo = r2(40 + k * 11);
        total = r2(total + costo * cant);
        lineas.push([`L-${i}${k}`, `OC-${i}`, `Producto ${k}`, cant, costo]);
      }
      mas('cogs', total);
      ordenes.push([`OC-${i}`, f(dia(i)), `Proveedor ${i % 3}`, total]);
    }
    hojas.push(['OrdenesCompra', ordenes]);
    hojas.push(['LineasOC', lineas]);
    tipos['OrdenesCompra'] = 'cogs';
    tipos['LineasOC'] = 'cogs';
  }

  /* ── Facturación en USD que devenga, y sus cobros que NO vuelven a devengar ── */
  if (o.facturacionYCobros) {
    const facturacion: unknown[][] = [
      ['No. Factura', 'Fecha Emision', 'Cliente', 'Moneda', 'Monto'],
    ];
    const nFacturas = Math.max(o.filasCobros + 2, 8);
    for (let i = 0; i < nFacturas; i++) {
      const monto = 300 + i * 45;
      mas('revenue', r2(monto * TASA_USD));
      facturacion.push([`FAC-${100 + i}`, f(dia(i)), `Cliente ${i % 6}`, 'USD', monto]);
    }
    const cobros: unknown[][] = [['No. Recibo', 'Fecha', 'No. Factura', 'Monto', 'Moneda']];
    for (let i = 0; i < o.filasCobros; i++) {
      cobros.push([`REC-${i}`, f(dia(i + 1)), `FAC-${100 + i}`, 300 + i * 45, 'USD']);
    }
    hojas.push(['Facturacion', facturacion]);
    hojas.push(['Cobros', cobros]);
    tipos['Facturacion'] = 'revenue';
    tipos['Cobros'] = 'revenue';
    entidades['Facturacion'] = 'invoice';
  }

  /* ── Ruido que NO debe sumar ── */
  if (o.catalogoDeClientes) {
    const clientes: unknown[][] = [
      [
        'Cliente',
        'NIT',
        'Contacto',
        'Telefono',
        'Condiciones',
        'Ultima compra',
        'Saldo por cobrar',
      ],
    ];
    for (let i = 1; i <= 14; i++) {
      clientes.push([
        `Cliente ${i}`,
        `${900000 + i * 13}-K`,
        `Contacto ${i}`,
        `5${1000000 + i}`,
        i % 2 ? 'Contado' : '30 días',
        serial(`2026-0${(i % 8) + 1}-10`),
        i % 3 ? 0 : 1500 + i * 40,
      ]);
    }
    hojas.push(['Clientes', clientes]);
  }

  if (o.inventario) {
    const inventario: unknown[][] = [
      ['SKU', 'Producto', 'Cantidad Disponible', 'Punto Reorden', 'Costo Unitario', 'Ubicacion'],
    ];
    for (let i = 0; i < 12; i++) {
      inventario.push([`SKU-${i}`, `Producto ${i % 5}`, 20 + i * 3, 10, r2(45 + i * 2), `A-${i}`]);
    }
    hojas.push(['Inventario', inventario]);
  }

  if (o.hojaBasura) {
    hojas.push([
      'Notas',
      [['Notas del contador'], ['Revisar reclasificación'], ['Pendiente conciliar caja']],
    ]);
  }

  return {
    archivo: `fuzz-${semilla}.xlsx`,
    titulo: `Libro generado (semilla ${semilla})`,
    rompe: JSON.stringify(o),
    hojas,
    verdad: v,
    base: 'GTQ',
    tasas: { USD: TASA_USD },
    clasificar: dobleDeModelo({ tipos, entidades }),
  };
}
