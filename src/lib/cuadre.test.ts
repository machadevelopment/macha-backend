import { describe, expect, test } from 'bun:test';
import { evaluarCuadre, evaluarCuadrePorHoja, hayDescuadre, hojasDescuadradas } from './cuadre';

/**
 * La garantía: un fallo de ingesta en un archivo QUE NADIE VIO NUNCA queda registrado.
 *
 * Los tests cubren archivos que ya conocemos. Este chequeo es lo único que funciona sobre el
 * que va a subir el próximo cliente, y por eso se prueba contra los DIECISÉIS bugs reales
 * encontrados en la ingesta: si el detector no los hubiera visto, no sirve.
 */

const leido = (monto: number, costo = 0, moneda = 'GTQ') => [{ moneda, monto, costo }];
const aterrizado = (monto: number, moneda = 'GTQ') => [{ moneda, monto }];
/** Cuántas filas de ledger produjo el pipeline por fila medida. Ver `MARGEN` en el módulo. */
const SIN_EXPANSION = 1;

describe('los fallos reales de la ingesta quedan detectados', () => {
  test('hoja de gastos descartada por forma: Q 75.465 → 0', () => {
    const [c] = evaluarCuadre(leido(75_465.9), aterrizado(0));
    expect(c!.veredicto).toBe('nada_aterrizo');
  });

  test('nómina con fechas en español: la hoja entera desaparece', () => {
    const [c] = evaluarCuadre(leido(88_800), aterrizado(0));
    expect(c!.veredicto).toBe('nada_aterrizo');
  });

  test('resumen mensual procesado además del detalle: el doble', () => {
    // El pipeline no expandió nada: cada fila produjo una. El doble es plata duplicada.
    const [c] = evaluarCuadre(leido(239_588), aterrizado(479_176), SIN_EXPANSION);
    expect(c!.veredicto).toBe('sobra');
  });

  test('cobros contados como ventas nuevas: 1,52×', () => {
    /*
     * El más sutil de todos y el que justifica que la banda no sea generosa de más: no es un
     * ×2 limpio, es un 52 % de más. Con `MAXIMO` en 3,5 este caso solo se atrapa porque las
     * expansiones legítimas de ese libro no lo empujan más arriba.
     */
    const [c] = evaluarCuadre(leido(238_387), aterrizado(362_819), SIN_EXPANSION);
    expect(c!.veredicto).toBe('sobra');
  });

  test('media hoja perdida por fechas mal leídas', () => {
    // 59 % de las filas descartadas por `invalid_date`: el caso del libro en MM/DD/YYYY.
    const [c] = evaluarCuadre(leido(100_000), aterrizado(41_000), SIN_EXPANSION);
    expect(c!.veredicto).toBe('falta');
  });
});

describe('las expansiones LEGÍTIMAS no disparan', () => {
  /*
   * Es la mitad que hace usable el detector: si marcara cada carga normal, nadie lo miraría y
   * daría igual que existiera. Cada caso de acá es una regla documentada del pipeline.
   */
  test('una venta con su costo en la misma línea produce dos filas', () => {
    // Se leen 100 de monto y 45 de costo; aterrizan las dos.
    // El costo se lee del archivo, así que ya está en `leido`: no hay expansión que declarar.
    const [c] = evaluarCuadre(leido(100_000, 45_000), aterrizado(145_000), SIN_EXPANSION);
    expect(c!.veredicto).toBe('cuadra');
  });

  test('una factura emitida produce su cuenta por cobrar Y su ingreso', () => {
    // La misma plata dos veces en el ledger, por diseño: una en `invoices`, otra en
    // `transactions`. Es 2× sobre lo medido y NO es un error.
    // El pipeline produjo 2 filas de ledger por cada fila del archivo, y lo declara.
    const [c] = evaluarCuadre(leido(50_000), aterrizado(100_000), 2);
    expect(c!.veredicto).toBe('cuadra');
  });

  test('una factura con costo en la línea: hasta 3× sigue siendo legítimo', () => {
    const [c] = evaluarCuadre(leido(50_000), aterrizado(150_000), 3);
    expect(c!.veredicto).toBe('cuadra');
  });

  test('unas pocas filas en revisión no cuentan como falta', () => {
    // Un renglón de TOTAL, una fila sin fecha: pérdidas acotadas y normales.
    const [c] = evaluarCuadre(leido(100_000), aterrizado(96_000), SIN_EXPANSION);
    expect(c!.veredicto).toBe('cuadra');
  });
});

describe('se compara POR MONEDA, nunca sumado', () => {
  test('un descuadre en una moneda no se esconde detrás de otra que cuadra', () => {
    /*
     * Sumar GTQ con USD daría un número que no es ninguna de las dos, y ahí un descuadre chico
     * en dólares desaparece dentro del total en quetzales. Es la misma regla que gobierna la
     * pantalla de conceptos pendientes.
     */
    const cuadres = evaluarCuadre(
      [
        { moneda: 'GTQ', monto: 100_000, costo: 0 },
        { moneda: 'USD', monto: 5_000, costo: 0 },
      ],
      [
        { moneda: 'GTQ', monto: 100_000 },
        { moneda: 'USD', monto: 0 },
      ],
    );
    expect(cuadres.find((c) => c.moneda === 'GTQ')!.veredicto).toBe('cuadra');
    expect(cuadres.find((c) => c.moneda === 'USD')!.veredicto).toBe('nada_aterrizo');
    expect(hayDescuadre(cuadres)).toBe(true);
  });

  test('una moneda que aterrizó sin haberse leído se reporta', () => {
    // El síntoma de `asCurrency` relabelando: aparece dinero en una moneda que el archivo no
    // traía. Sin separar por moneda, esto es invisible.
    const cuadres = evaluarCuadre(
      [{ moneda: 'EUR', monto: 1_000, costo: 0 }],
      [{ moneda: 'GTQ', monto: 1_000 }],
    );
    expect(cuadres.find((c) => c.moneda === 'EUR')!.veredicto).toBe('nada_aterrizo');
    expect(cuadres.find((c) => c.moneda === 'GTQ')!.veredicto).toBe('sin_datos');
  });
});

describe('bordes', () => {
  test('un archivo sin montos medibles no es un descuadre', () => {
    const cuadres = evaluarCuadre(leido(0), aterrizado(0));
    expect(cuadres[0]!.veredicto).toBe('sin_datos');
    expect(hayDescuadre(cuadres)).toBe(false);
  });

  test('una empresa sin operación (todo en cero) no dispara nada', () => {
    expect(hayDescuadre(evaluarCuadre([], []))).toBe(false);
  });

  test('el detalle está en lenguaje de operador, con las cifras adentro', () => {
    const [c] = evaluarCuadre(leido(75_465.9), aterrizado(0));
    expect(c!.detalle).toContain('75465.90');
    expect(c!.detalle).toContain('NO llegó nada');
  });
});

describe('la cota superior se calcula del pipeline, no se adivina', () => {
  /*
   * El primer intento fue una constante y no funciona: una expansión legítima llega a 3×
   * mientras el duplicado que hay que atrapar es ×2. Cualquier número fijo o deja pasar los
   * fallos o marca las cargas normales.
   *
   * Lo que resuelve la tensión es que la expansión NO es un misterio: el pipeline sabe cuántas
   * filas de ledger produjo por cada fila del archivo, porque él mismo las creó. La pregunta
   * pasa de "¿cuánto es demasiado?" —que no tiene respuesta general— a "¿lo aterrizado se
   * parece a lo que este pipeline dijo que iba a producir?".
   */
  test('el MISMO 2× cuadra o descuadra según lo que el pipeline declaró', () => {
    const conDuplicado = evaluarCuadre(leido(100_000), aterrizado(200_000), 1)[0]!;
    const conExpansion = evaluarCuadre(leido(100_000), aterrizado(200_000), 2)[0]!;
    expect(conDuplicado.veredicto).toBe('sobra');
    expect(conExpansion.veredicto).toBe('cuadra');
  });

  test('declarar una expansión que no ocurrió NO esconde una falta', () => {
    // La cota inferior no se mueve con la expansión: si el pipeline dice que iba a producir
    // 3× y aterrizó menos que lo leído, eso sigue siendo plata que falta.
    const [c] = evaluarCuadre(leido(100_000), aterrizado(10_000), 3);
    expect(c!.veredicto).toBe('falta');
  });

  test('el detalle dice cuánto expandió, para que el operador pueda juzgarlo', () => {
    const [c] = evaluarCuadre(leido(100_000), aterrizado(200_000), 1);
    expect(c!.detalle).toContain('el pipeline solo expandió 1.00×');
  });

  test('sin declarar expansión se usa la banda más ESTRECHA', () => {
    /*
     * El default es el lado seguro para un detector que no bloquea: reporta de más, nunca de
     * menos. Un falso descuadre cuesta que alguien lo mire; uno perdido cuesta la contabilidad
     * de un cliente.
     */
    expect(evaluarCuadre(leido(100_000), aterrizado(200_000))[0]!.veredicto).toBe('sobra');
  });
});

describe('lo que espera revisión no es lo mismo que lo perdido', () => {
  /*
   * Un renglón de TOTAL o una fila sin fecha legible se guarda en staging con su monto y
   * espera a que alguien la resuelva: ese dinero está identificado y con dueño.
   *
   * Sin distinguirlo, el detector reportaba `falta` sobre cargas sanas —medido en el test de
   * integración: una hoja con un subtotal de Q 999.999 daba "falta el 89 %"— y un detector que
   * grita sobre lo normal es un detector que nadie mira.
   *
   * Y separarlos importa porque piden acciones OPUESTAS: `en_revision` necesita que alguien
   * mire la cola; `falta` necesita que alguien mire el pipeline, porque hay plata que nadie
   * sabe dónde quedó. En el mismo cajón, el segundo —el caro— se pierde entre decenas del
   * primero, que es rutina.
   */
  test('lo que falta está en revisión: no es un descuadre', () => {
    const cuadres = evaluarCuadre(
      leido(1_119_799),
      aterrizado(119_800),
      SIN_EXPANSION,
      aterrizado(999_999),
    );
    expect(cuadres[0]!.veredicto).toBe('en_revision');
    expect(hayDescuadre(cuadres)).toBe(false);
    expect(cuadres[0]!.detalle).toContain('no falta nada, falta resolverlo');
  });

  test('si lo pendiente NO explica el hueco, sigue siendo falta', () => {
    // La revisión no es una excusa universal: si falta plata que nadie tiene identificada,
    // el detector lo dice igual.
    const cuadres = evaluarCuadre(
      leido(100_000),
      aterrizado(10_000),
      SIN_EXPANSION,
      aterrizado(5_000),
    );
    expect(cuadres[0]!.veredicto).toBe('falta');
    expect(hayDescuadre(cuadres)).toBe(true);
  });

  test('lo pendiente NO tapa un exceso', () => {
    // Sobra plata: que haya filas en revisión no explica que aterrizara de más.
    const cuadres = evaluarCuadre(
      leido(100_000),
      aterrizado(200_000),
      SIN_EXPANSION,
      aterrizado(50_000),
    );
    expect(cuadres[0]!.veredicto).toBe('sobra');
  });
});

describe('una hoja suprimida a propósito NO es un descuadre', () => {
  /*
   * La hoja de COBROS de un libro real no aterriza nada, y eso es correcto: su ingreso ya lo
   * devengó la factura a la que apunta (`ventaYaRegistradaEnOtraHoja`). Su forma es idéntica a
   * la del fallo más caro —cero aterrizado habiendo dinero en el archivo— así que sin
   * distinguirlas el detector da un falso positivo en TODO libro que lleve cobros.
   *
   * Medido en producción el 2026-09-01: `12-la-ceiba.xlsx` salió con ingresos, costo y gastos
   * EXACTOS contra su verdad de campo, y el cuadre igual reportó DESCUADRE por `Cobros`
   * (USD 9.300,00). Un detector que se equivoca sobre lo correcto enseña a ignorarlo.
   */
  const cobros = {
    hoja: 'Cobros',
    leido: [{ moneda: 'USD', monto: 9300, costo: 0 }],
    aterrizado: [],
  };

  test('sin la bandera dice `nada_aterrizo` y ensucia la cola', () => {
    const [c] = evaluarCuadrePorHoja([cobros]);
    expect(c!.cuadres[0]!.veredicto).toBe('nada_aterrizo');
    expect(hojasDescuadradas([c!])).toHaveLength(1);
  });

  test('con la bandera dice `no_se_registra` y NO ensucia la cola', () => {
    const [c] = evaluarCuadrePorHoja([{ ...cobros, suprimida: true }]);
    expect(c!.cuadres[0]!.veredicto).toBe('no_se_registra');
    // Sigue PERSISTIDO y legible: omitir la hoja la volvería invisible, que es el problema
    // opuesto al que esto arregla.
    expect(c!.cuadres[0]!.detalle).toContain('ya cuenta ese dinero en otra hoja');
    expect(hojasDescuadradas([c!])).toHaveLength(0);
  });

  test('⚠️ `sobra` NO se reetiqueta: una hoja suprimida que aterriza dinero SÍ es un fallo', () => {
    // Significa que la supresión no funcionó, o sea el doble conteo que la regla evita.
    const [c] = evaluarCuadrePorHoja([
      {
        hoja: 'Cobros',
        leido: [{ moneda: 'USD', monto: 9300, costo: 0 }],
        aterrizado: [{ moneda: 'USD', monto: 18600 }],
        suprimida: true,
      },
    ]);
    expect(c!.cuadres[0]!.veredicto).not.toBe('no_se_registra');
    expect(hojasDescuadradas([c!])).toHaveLength(1);
  });
});
