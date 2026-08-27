import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  counterCurrency,
  ESQUEMA_TASA,
  missingFxFlagReason,
  missingFxRateMessage,
  resolveFromCatalog,
  MISSING_FX_FLAG,
} from '@/lib/fx';

describe('resolución de tasa contra un catálogo cargado (CU-868kjc6h1)', () => {
  // Orden descendente por fecha, tal como lo devuelve loadFxCatalog.
  const catalogo = [
    { rate: 7.9, effectiveDate: '2026-03-01' },
    { rate: 7.75, effectiveDate: '2026-01-15' },
    { rate: 7.7, effectiveDate: '2025-12-01' },
  ];

  test('toma la más reciente que no sea posterior a la fecha', () => {
    expect(resolveFromCatalog(catalogo, '2026-02-10')?.rate).toBe(7.75);
  });

  test('la del mismo día vale (vigencia inclusiva)', () => {
    expect(resolveFromCatalog(catalogo, '2026-03-01')?.rate).toBe(7.9);
  });

  /**
   * CAMBIÓ EL 2026-08-07. Antes esto devolvía `null` y la fila se retenía: "hay tasas, pero
   * ninguna vigente para esta fila". El resultado práctico era el footgun que se arregló —
   * el operador registraba una tasa siguiendo el mensaje, volvía a procesar, y no se
   * desbloqueaba nada porque su libro tenía movimientos anteriores a la tasa que acababa de
   * registrar. Para que funcionara tenía que adivinar que había que retrofecharla.
   */
  test('una fecha anterior a todo el catálogo cae a la tasa más antigua', () => {
    const hit = resolveFromCatalog(catalogo, '2025-06-30');
    expect(hit?.rate).toBe(7.7);
    // Y devuelve SU fecha, no la de la fila: es lo que se congela en `fx_rate_date` y lo que
    // deja ver después que la conversión usó una tasa de otro período.
    expect(hit?.effectiveDate).toBe('2025-12-01');
  });

  test('la preferencia sigue siendo la vigente: la caída es solo el último recurso', () => {
    // Si hay una que precede a la fecha, gana ella — la caída no debe "ganarle" nunca a una
    // tasa correcta, o toda conversión usaría la más antigua del catálogo.
    expect(resolveFromCatalog(catalogo, '2026-02-10')?.effectiveDate).toBe('2026-01-15');
  });

  test('sin ninguna tasa para el par no se inventa nada', () => {
    // El límite del cambio: caer a una tasa de otra fecha es una aproximación auditable;
    // inventar una (convertir por 1) escribiría dinero incorrecto en silencio. Sin catálogo
    // la fila se retiene, y eso se mantiene.
    expect(resolveFromCatalog([], '2026-02-10')).toBeNull();
  });

  test('un catálogo de una sola tasa sirve para cualquier fecha', () => {
    // El caso de onboarding: el operador registra UNA tasa y con eso el archivo completo
    // puede convertirse, sin importar qué tan atrás lleguen sus movimientos. Es exactamente
    // lo que antes no pasaba.
    const unaSola = [{ rate: 7.8, effectiveDate: '2026-08-07' }];
    expect(resolveFromCatalog(unaSola, '2025-01-01')?.rate).toBe(7.8);
    expect(resolveFromCatalog(unaSola, '2026-12-31')?.rate).toBe(7.8);
  });
});

describe('mensajes accionables (CU-868kjc6h1 criterio 3)', () => {
  test('el error de promoción dice qué falta, para qué fecha y dónde arreglarlo', () => {
    const msg = missingFxRateMessage({ quote: 'USD', base: 'GTQ', onOrBefore: '2026-07-01' });
    expect(msg).toContain('USD→GTQ');
    expect(msg).toContain('2026-07-01');
    expect(msg).toContain('panel admin');
    // Lo que se fue: el uuid de la empresa, que no le sirve a quien lee el monitoreo.
    expect(msg).not.toContain('company');
  });

  test('el flag de staging conserva moneda y fecha para poder triarlo', () => {
    expect(missingFxFlagReason('USD', '2026-07-01')).toBe(`${MISSING_FX_FLAG}:USD:2026-07-01`);
  });
});

describe('par de monedas', () => {
  test('la contraparte de la base es la otra moneda soportada', () => {
    expect(counterCurrency('GTQ')).toBe('USD');
    expect(counterCurrency('USD')).toBe('GTQ');
  });
});

describe('una tasa de cambio tiene que ser estrictamente positiva', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * EL CERO SE ACEPTABA, Y NO DEJABA RASTRO
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * Las dos rutas que escriben en `fx_rates` validaban con `t.Number()` a secas. Con una tasa
   * de 0 guardada, la ingesta hace `amount_base = originalAmount * 0` y **toda fila en la otra
   * moneda se promueve con importe cero**: sin marcarse, sin error, y con el cliente viendo
   * desaparecer esa parte de su contabilidad. Una negativa es peor todavía, porque invierte el
   * signo del movimiento.
   *
   * Se valida con `Value.Check` contra el esquema REAL —el mismo objeto que importan las dos
   * rutas— y no leyendo `exclusiveMinimum` de él. La diferencia importa: lo segundo comprueba
   * que alguien escribió una propiedad, y esto comprueba que TypeBox rechaza el valor.
   */
  test.each([
    ['cero', 0],
    ['negativa', -7.7],
  ])('rechaza una tasa %s', (_caso, valor) => {
    expect(Value.Check(ESQUEMA_TASA, valor)).toBe(false);
  });

  test.each([
    ['la tasa real GTQ/USD', 7.7],
    ['una fracción chica', 0.13],
  ])('acepta %s', (_caso, valor) => {
    expect(Value.Check(ESQUEMA_TASA, valor)).toBe(true);
  });

  /*
   * Las dos rutas comparten el objeto, no una copia. Es lo que impide que alguien endurezca una
   * y deje la otra abierta — que fue exactamente el estado del que venimos.
   */
  test('el esquema es UNO solo para las dos rutas que escriben', async () => {
    const cliente = await Bun.file('src/modules/metrics/fx-rate.ts').text();
    const admin = await Bun.file('src/modules/admin/fx-rates.ts').text();

    /*
     * Se mira solo el `body:` de cada ruta, y esa acotación la escribió un falso positivo:
     * la primera versión buscaba `rate: t.Number(` en el ARCHIVO entero y se disparaba con el
     * esquema de RESPUESTA de `GET /fx-rate/display`, donde un número suelto es correcto —ahí
     * la tasa se devuelve, no se acepta—. Lo que hay que proteger es la puerta de entrada.
     */
    const cuerpoDe = (fuente: string) => {
      const i = fuente.indexOf('body: t.Object(');
      expect(i).toBeGreaterThan(-1);
      return fuente.slice(i, fuente.indexOf('}),', i));
    };

    for (const cuerpo of [cuerpoDe(cliente), cuerpoDe(admin)]) {
      expect(cuerpo).toContain('rate: ESQUEMA_TASA,');
      expect(cuerpo).not.toMatch(/rate: t\.Number\(/);
    }
  });
});
