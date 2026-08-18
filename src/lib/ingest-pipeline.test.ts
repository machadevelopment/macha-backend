import { describe, expect, test } from 'bun:test';
import * as XLSX from 'xlsx';
import { canSkipSheet } from './sheet-classifier';
import { fingerprintSheet } from './row-fingerprint';
import { planBatchSize } from './sheet-batching';
import { assemblePayload, type ColumnMap } from './row-assembly';
import { evaluateFlagReason } from './staging-rules';

/**
 * ═══ EL SET DE PRUEBAS DE CLASIFICACIÓN ═══
 *
 * El documento de preparación del 2026-08-12 lo pone como REQUISITO, no como mejora, y con
 * razón: sin esto, achicar el esquema de salida y deduplicar antes de la IA se hicieron a
 * ciegas — nadie podía decir si la precisión bajó.
 *
 * Los otros archivos de test cubren cada pieza por separado (huella, pre-filtro, ensamblado,
 * lotes). Este cubre lo único que ninguno cubre: que las cinco piezas ENCADENADAS produzcan
 * filas que el validador de producción acepte. Es donde viven los errores de integración,
 * que son los que llegan al cliente.
 *
 * ═══ POR QUÉ SE CONSTRUYE EL .XLSX EN MEMORIA Y NO SE COMMITEA UNO ═══
 *
 * Un binario en el repo no se puede revisar en un PR: nadie ve qué cambió cuando cambia.
 * Construirlo desde una tabla literal deja el dato a la vista, y de paso el fixture pasa por
 * el MISMO `sheet_to_json` que usa el worker — incluidos los seriales de fecha de Excel, que
 * son la trampa que más silenciosamente rompe una contabilidad.
 *
 * Los encabezados y las filas son los REALES de los archivos que entregó el cliente
 * (Joyería Lunaria / Bella Piel / Luz de Cera, datos sintéticos de prueba), leídos con el
 * parser del producto. No están inventados.
 *
 * ═══ QUÉ NO CUBRE, Y HAY QUE DECIRLO ═══
 *
 * No llama al modelo. El mapa de columnas de abajo es el que devolvió una llamada REAL el
 * 2026-08-12, congelado. O sea que esto prueba "dado ese mapa, el resto funciona", no "el
 * modelo devuelve ese mapa" — para lo segundo hace falta gastar dinero, y se hace a mano
 * cuando se toca el prompt o el esquema.
 */

const VENTAS = [
  ['IDOrden','IDLinea','FechaOrden','IDTienda','Canal','IDCliente','SKU','Cantidad','PrecioUnitario','PorcentajeDescuento','MetodoPago','CostoUnitario','Categoría','TotalLinea','UtilidadBruta','MesOrden'],
  ['ORD-00068','LIN-00001',45878,'TDA-002','En Tienda','CLI-0070','JYL-ARE-0023',2,272.99,0.1,'Transferencia Bancaria',135.52,'Aretes',491.382,220.342,'2025-08'],
  ['ORD-00068','LIN-00002',45878,'TDA-002','En Tienda','CLI-0070','JYL-REL-0035',1,229.99,0,'Transferencia Bancaria',110.4,'Relojes',229.99,119.59,'2025-08'],
  ['ORD-00069','LIN-00001',45879,'TDA-001','En Línea','CLI-0012','JYL-ARE-0033',1,67.99,0,'Tarjeta',30.5,'Aretes',67.99,37.49,'2025-08'],
  ['ORD-00070','LIN-00001',45063,'TDA-003','En Tienda','CLI-0044','JYL-COL-0011',3,150,0.05,'Efectivo',70,'Collares',427.5,217.5,'2023-05'],
]; // prettier-ignore

const CLIENTES = [
  ['IDCliente','Nombre','Apellido','Email','Telefono','Ciudad','Estado','Pais','Género','AñoNacimiento','NivelLealtad','FechaRegistro','CanalPreferido'],
  ['CLI-0070','Ana','Morales','ana@example.com','5555-1234','Guatemala','Guatemala','GT','F',1990,'Oro',45000,'En Línea'],
  ['CLI-0012','Luis','Pérez','luis@example.com','5555-9876','Antigua','Sacatepéquez','GT','M',1985,'Plata',44800,'En Tienda'],
]; // prettier-ignore

const INVENTARIO = [
  ['SKU','IDTienda','CantidadDisponible','PuntoReorden','CantidadReorden','FechaÚltimoReabasto','Ubicación','NombreTienda','AlertaReorden'],
  ['JYL-ARE-0023','TDA-002',14,5,20,45870,'A-3','Zona 10',false],
]; // prettier-ignore

/** El mapa que devolvió el modelo en la llamada real del 2026-08-12 sobre esta misma hoja. */
const MAPA_VENTAS: ColumnMap = {
  date: 2,
  amount: 13,
  currency: null,
  description: null,
  counterparty: null,
  product: 6,
  quantity: 7,
  productCategory: 12,
  dueDate: null,
  costTotal: null,
  costUnit: null,
  store: null,
};

const EMPRESA = '11111111-1111-4111-8111-111111111111';

function libro(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  for (const [nombre, filas] of [
    ['Ventas', VENTAS],
    ['Clientes', CLIENTES],
    ['Inventario', INVENTARIO],
  ] as const) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), nombre);
  }
  return wb;
}

/** Lee una hoja igual que el worker: `header: 1`, sin filas en blanco. */
const leer = (wb: XLSX.WorkBook, hoja: string): unknown[][] =>
  XLSX.utils.sheet_to_json(wb.Sheets[hoja]!, { header: 1, blankrows: false });

describe('la cadena completa, del .xlsx a la fila validada', () => {
  test('las hojas de catálogo se caen antes de gastar un token', () => {
    const wb = libro();
    expect(canSkipSheet(leer(wb, 'Clientes')[0]!)).toBe(true);
    expect(canSkipSheet(leer(wb, 'Inventario')[0]!)).toBe(true);
    expect(canSkipSheet(leer(wb, 'Ventas')[0]!)).toBe(false);
  });

  test('cada fila de Ventas se arma y PASA el validador de producción', () => {
    /*
     * El test que de verdad importa. `evaluateFlagReason` es el mismo código que decide, en
     * producción, si una fila entra limpia o se va a revisión interna. Si el ensamblado
     * produjera una fecha corrida o un monto negativo, acá se ve — y no en la bandeja de
     * revisión del staff tres días después.
     */
    const filas = leer(libro(), 'Ventas').slice(1);
    const razones = filas.map((row) =>
      evaluateFlagReason({
        targetEntity: 'transaction',
        confidence: 0.9,
        payload: assemblePayload({
          verdict: {
            i: 0,
            targetEntity: 'transaction',
            type: 'revenue',
            category: 'sales',
            confidence: 0.9,
          },
          row,
          columns: MAPA_VENTAS,
          baseCurrency: 'GTQ',
        }),
      }),
    );
    expect(razones).toEqual([null, null, null, null]);
  });

  test('los seriales de Excel llegan como la fecha correcta hasta el final', () => {
    // Convertir mal un serial desplaza TODOS los movimientos del cliente en silencio: no
    // falla nada, solo queda su contabilidad corrida. Se comprueba en la salida de la
    // cadena, no en la función de fecha aislada, que ya tiene su propio test.
    const filas = leer(libro(), 'Ventas').slice(1);
    const fechas = filas.map(
      (row) =>
        assemblePayload({
          verdict: {
            i: 0,
            targetEntity: 'transaction',
            type: 'revenue',
            category: 'sales',
            confidence: 0.9,
          },
          row,
          columns: MAPA_VENTAS,
          baseCurrency: 'GTQ',
        }).date,
    );
    // La primera fila trae además `MesOrden: "2025-08"`: el propio archivo corrobora el mes.
    expect(fechas).toEqual(['2025-08-09', '2025-08-09', '2025-08-10', '2023-05-17']);
  });

  test('resubir el mismo libro no manda ni una fila al modelo', () => {
    /*
     * El caso del cliente semanal, extremo a extremo. La primera pasada registra las huellas;
     * la segunda no encuentra ninguna nueva. Sin esto, cada semana se vuelve a pagar el
     * archivo completo.
     */
    const filas = leer(libro(), 'Ventas');
    const semana1 = new Set(
      fingerprintSheet({ companyId: EMPRESA, sheetName: 'Ventas', rows: filas }),
    );
    const semana2 = fingerprintSheet({ companyId: EMPRESA, sheetName: 'Ventas', rows: filas });

    expect(semana2.filter((h) => !semana1.has(h))).toHaveLength(0);
  });

  test('resubir con filas nuevas manda SOLO las nuevas', () => {
    const filas = leer(libro(), 'Ventas');
    const nueva = ['ORD-00071','LIN-00001',45880,'TDA-001','En Línea','CLI-0012','JYL-ANI-0002',1,899,0,'Tarjeta',400,'Anillos',899,499,'2025-08']; // prettier-ignore

    const antes = new Set(
      fingerprintSheet({ companyId: EMPRESA, sheetName: 'Ventas', rows: filas }),
    );
    const ahora = fingerprintSheet({
      companyId: EMPRESA,
      sheetName: 'Ventas',
      rows: [...filas, nueva],
    });

    expect(ahora.filter((h) => !antes.has(h))).toHaveLength(1);
  });

  test('el libro entero cabe en una sola tanda de llamadas', () => {
    /*
     * La promesa de tiempo, medida sobre la cadena y no sobre una hoja de cálculo aparte:
     * lo que llega al modelo, partido con el planificador real, tiene que caber en pocas
     * llamadas. Con este fixture (4 filas de datos) es una sola.
     */
    const wb = libro();
    const lotes = wb.SheetNames.reduce((total, hoja) => {
      const filas = leer(wb, hoja);
      if (canSkipSheet(filas[0] ?? [])) return total;
      const datos = filas.slice(1);
      return datos.length === 0 ? total : total + Math.ceil(datos.length / planBatchSize(datos));
    }, 0);

    expect(lotes).toBe(1);
  });
});
