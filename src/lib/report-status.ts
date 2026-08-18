/**
 * En qué estado está un reporte de cara al cliente — CU-868ktkuq0.
 *
 * ═══ POR QUÉ TRES Y NO DOS ═══
 *
 * Antes solo se preguntaba si había versión (`ready`), y la ausencia de versión significaba
 * dos cosas a la vez: "todavía se está generando" y "ya no se va a generar". La lista tenía
 * que elegir uno de los dos significados para pintar ese caso y elegía FALLÓ. Como la fila
 * de `reports` se crea ANTES de encolar el job —hay que devolverle un id al usuario—, todo
 * reporte recién pedido aparecía en rojo diciendo que no se generó, durante todo el rato
 * que la IA tardaba en escribirlo. Fue el reporte de QA: "mientras se hace el reporte que
 * diga in progress".
 *
 * ═══ EL ORDEN DE LECTURA NO ES ARBITRARIO ═══
 *
 * La versión manda: es la prueba material de que el reporte TIENE contenido. La marca de
 * fallo solo se mira cuando no hay versión, y por eso un reintento exitoso no puede quedar
 * mostrándose como fallido aunque su marca vieja siguiera puesta. Invertir el orden —fallo
 * primero— dejaría un reporte con contenido pintado como roto, que es el peor de los dos
 * errores: el usuario tiene el reporte y el producto le dice que no.
 */
export type ReportStatus = 'ready' | 'generating' | 'failed';

export function reportStatus(input: {
  currentVersionId: string | null;
  failedAt: Date | null;
}): ReportStatus {
  if (input.currentVersionId !== null) return 'ready';
  if (input.failedAt !== null) return 'failed';
  return 'generating';
}
