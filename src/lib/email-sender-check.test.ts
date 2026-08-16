import { describe, expect, test } from 'bun:test';
import { evaluateEmailSender } from './email-sender-check';

/**
 * CU-868krkndr — el aviso de "este entorno no puede entregarle a nadie más que a ustedes".
 *
 * El caso que motivó todo esto está en el primer test: producción con
 * `RESEND_FROM_EMAIL=onboarding@resend.dev`, que es lo que había el 2026-08-16 en las
 * variables reales del servicio.
 */

const DEPLOY = { railwayEnvironment: 'production', nodeEnv: 'production' };
const LOCAL = { railwayEnvironment: '', nodeEnv: 'development' };

describe('remitente de caja de arena', () => {
  test('el caso real: onboarding@resend.dev en producción', () => {
    const status = evaluateEmailSender({
      apiKey: 're_algo',
      fromEmail: 'onboarding@resend.dev',
      ...DEPLOY,
    });
    expect(status.deliverable).toBe(false);
    // El aviso tiene que nombrar la variable y el valor: quien lo lee en los logs de
    // Railway necesita saber qué tocar sin abrir el código.
    expect(status.warning).toContain('RESEND_FROM_EMAIL');
    expect(status.warning).toContain('onboarding@resend.dev');
  });

  test('avisa también en local, porque ahí tampoco entrega', () => {
    // A diferencia de la clave ausente —normal en local y por eso silenciosa—, el
    // remitente de prueba es una elección explícita que engaña igual en todos lados: se
    // ve "enviado" y no llega. Si alguien prueba invitaciones en su máquina con esto
    // puesto, va a concluir que el código está roto.
    const status = evaluateEmailSender({
      apiKey: 're_algo',
      fromEmail: 'hola@resend.dev',
      ...LOCAL,
    });
    expect(status.deliverable).toBe(false);
    expect(status.warning).not.toBeNull();
  });

  test('un subdominio de resend.dev cuenta igual', () => {
    const status = evaluateEmailSender({
      apiKey: 're_algo',
      fromEmail: 'x@mail.resend.dev',
      ...DEPLOY,
    });
    expect(status.deliverable).toBe(false);
  });

  test('un dominio que solo TERMINA parecido no es de prueba', () => {
    // "notresend.dev" no es un subdominio de resend.dev. Comparar con un `endsWith`
    // pelado sobre la cadena entera lo daría por bueno y taparía un entorno sano con un
    // aviso falso — que es la forma más rápida de que se dejen de leer los avisos.
    const status = evaluateEmailSender({
      apiKey: 're_algo',
      fromEmail: 'hola@notresend.dev',
      ...DEPLOY,
    });
    expect(status.deliverable).toBe(true);
    expect(status.warning).toBeNull();
  });
});

describe('clave ausente', () => {
  test('en un deploy grita: nadie recibe nada', () => {
    const status = evaluateEmailSender({
      apiKey: '',
      fromEmail: 'notificaciones@macha.finance',
      ...DEPLOY,
    });
    expect(status.deliverable).toBe(false);
    expect(status.warning).toContain('RESEND_API_KEY');
  });

  test('en local calla: no tener Resend es el estado normal', () => {
    const status = evaluateEmailSender({
      apiKey: '',
      fromEmail: 'notificaciones@macha.finance',
      ...LOCAL,
    });
    expect(status.deliverable).toBe(false);
    expect(status.warning).toBeNull();
  });
});

/*
 * EL DOMINIO DE ESTOS EJEMPLOS ES `macha.finance`, NO `machafinance.com`.
 *
 * Son dos dominios distintos y los dos existen (verificado por DNS el 2026-08-16):
 *
 *   · `macha.finance`     → el dominio del PRODUCTO. Apunta a Vercel y sirve la app.
 *                           Es el que corresponde al remitente, y el que ya trae por
 *                           defecto `env.ts`.
 *   · `machafinance.com`  → el sitio corporativo (Squarespace) con Google Workspace
 *                           (`MX → smtp.google.com`). Ahí vive el correo del equipo, como
 *                           development@machafinance.com. NO se toca para esto.
 *
 * Se deja escrito porque confundirlos manda a verificar el dominio equivocado en Resend, y
 * el síntoma sería idéntico al bug original: correos que "se envían" y no llegan.
 */
describe('configuración sana', () => {
  test('dominio propio y clave puesta: ni una palabra', () => {
    const status = evaluateEmailSender({
      apiKey: 're_algo',
      fromEmail: 'notificaciones@macha.finance',
      ...DEPLOY,
    });
    expect(status.deliverable).toBe(true);
    expect(status.warning).toBeNull();
  });
});
