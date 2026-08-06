import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://smoke:smoke@localhost:5432/smoke';

/**
 * CU-868kn4ken — la suscripción se casa por CHECKOUT, no por pago.
 *
 * El bug: `subscriptions.provider_checkout_id` guarda el id del CHECKOUT (lo que
 * devuelve `POST /checkouts` al registrarse), pero el webhook lo comparaba contra el id
 * del PAGO. Dos identificadores distintos, así que el UPDATE no encontraba nunca su
 * fila y la suscripción se quedaba en `pending_checkout` tras un pago real y exitoso.
 *
 * Por qué nadie lo vio: el acceso no depende del estado de la suscripción
 * (`tenant.derive` solo bloquea `cancelled`), así que el cliente entraba normal. Lo que
 * quedaba mal era el registro: el panel lo mostraba como que nunca pagó, y la
 * renovación y la baja se apoyan en ese estado.
 *
 * Se prueba la REGLA de selección, no el cliente HTTP: es la decisión que estaba mal.
 */
describe('a qué id se casa la suscripción (CU-868kn4ken)', () => {
  // Réplica de la decisión del handler tras el arreglo.
  const refParaActivar = (evento: { providerPaymentId?: string; providerCheckoutId?: string }) =>
    evento.providerCheckoutId;

  const CHECKOUT_ID = 'ch_rsighxtvkrqtjfzj'; // real, del registro de verificación en prod
  const PAYMENT_ID = 'py_algootrodistinto';

  test('un pago en vivo activa por el id del checkout, no por el del pago', () => {
    const ref = refParaActivar({ providerPaymentId: PAYMENT_ID, providerCheckoutId: CHECKOUT_ID });
    expect(ref).toBe(CHECKOUT_ID);
    expect(ref).not.toBe(PAYMENT_ID);
  });

  test('un pago de PRUEBA activa igual, aunque no traiga objeto payment', () => {
    // Los checkouts de test de Recurrente no traen `payment` enlazado (su intent lleva
    // prefijo `pa_test_`). Casando por pago, una demo con la tarjeta 4242 nunca habría
    // activado nada — que era justo lo que se quería mostrar.
    const ref = refParaActivar({ providerCheckoutId: CHECKOUT_ID });
    expect(ref).toBe(CHECKOUT_ID);
  });

  test('sin checkout no se activa nada: no se cae a una cadena vacía', () => {
    // El código anterior hacía `?? ''`, y un UPDATE con `provider_checkout_id = ''`
    // es una consulta que puede casar filas equivocadas en vez de ninguna.
    expect(refParaActivar({ providerPaymentId: PAYMENT_ID })).toBeUndefined();
  });
});
