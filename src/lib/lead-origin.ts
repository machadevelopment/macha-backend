import { createHmac } from 'node:crypto';
import { env } from '@/lib/env';

/**
 * Del origen de una solicitud pública se guarda un HASH, nunca la IP.
 *
 * ═══ PARA QUÉ SE NECESITA EL ORIGEN, Y PARA QUÉ NO ═══
 *
 * El endpoint del formulario de demo es público: cualquiera puede llamarlo, así que hace falta un
 * freno por origen ("¿cuántas solicitudes vinieron del mismo lugar en las últimas 24 horas?").
 * Contar es TODO lo que se necesita, y un hash cuenta exactamente igual que la IP.
 *
 * Guardar la IP tendría dos costos y ningún beneficio adicional: queda un dato personal en una
 * tabla que lee todo el staff y que además es append-only (o sea, no se puede limpiar nunca), y si
 * la tabla se filtra es un mapa de quién visitó el sitio.
 *
 * ═══ HMAC Y NO UN SHA256 PELADO ═══
 *
 * El espacio de IPv4 son 4.300 millones de valores: un `sha256(ip)` sin clave se revierte
 * probando todas en minutos. O sea que un hash SIN SAL no protege nada — parece que sí, que es
 * peor. Con HMAC y una clave del servidor, el hash solo es reversible por quien tenga la clave.
 *
 * ═══ DE DÓNDE SALE LA CLAVE, Y POR QUÉ NO ES UNA VARIABLE NUEVA ═══
 *
 * Usa `WORKOS_API_KEY`, que ya existe en todo entorno donde la app arranca, con un SEPARADOR DE
 * DOMINIO (`macha:lead-origin:v1`) para que este uso no se mezcle con ningún otro derivado de la
 * misma clave.
 *
 * La alternativa —una variable `DEMO_IP_SALT` propia— es más pura y en la práctica peor: nadie la
 * setearía en el primer deploy, y el modo de fallo de una sal ausente es silencioso y grave
 * (vuelve al sha256 pelado de arriba, que se lee como protección y no lo es). Una clave que YA
 * está garantizada por otros diez caminos no puede faltar.
 *
 * Si algún día se rota `WORKOS_API_KEY`, los hashes viejos dejan de casar con los nuevos. La única
 * consecuencia es que el contador por origen se reinicia — el freno se afloja un día, no se rompe
 * nada ni se pierde ninguna fila. Es un intercambio aceptable y por eso está escrito acá.
 */
const SEPARADOR = 'macha:lead-origin:v1';

/**
 * Extrae la IP del cliente de las cabeceras del proxy.
 *
 * `x-forwarded-for` puede traer una cadena ("cliente, proxy1, proxy2") y el PRIMER valor es el
 * cliente. Tomar el último daría la IP del proxy de Railway, que es la misma para todo el tráfico:
 * el freno por origen contaría a todo el mundo junto y bloquearía a todos con la quinta solicitud
 * del día.
 *
 * Si no hay cabecera, devuelve `'desconocido'` en vez de lanzar. Un origen que no se puede
 * determinar no debe impedir que alguien pida una demo; lo que hace es caer todo en el mismo
 * balde, que es el comportamiento conservador correcto.
 */
export function ipDeCabeceras(headers: Record<string, string | undefined>): string {
  const xff = headers['x-forwarded-for'];
  if (xff) {
    const primera = xff.split(',')[0]?.trim();
    if (primera) return primera;
  }
  return headers['x-real-ip']?.trim() || 'desconocido';
}

/** Hash estable del origen. Ver la nota de arriba: HMAC con clave del servidor, no sha256 pelado. */
export function hashDeOrigen(ip: string): string {
  return createHmac('sha256', `${SEPARADOR}:${env.workosApiKey}`).update(ip).digest('hex');
}
