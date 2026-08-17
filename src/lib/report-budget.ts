import type { ReportSection } from '@/lib/report-sections';

/**
 * Cuántos tokens de SALIDA se le dan a la narrativa de un reporte.
 *
 * ═══ POR QUÉ EXISTE ESTE ARCHIVO (CU-868krw2wn) ═══
 *
 * `generateReportNarrative` pedía `max_tokens: 2048` para todo reporte, y ese número se
 * eligió cuando el único reporte que existía era el del tick diario: dos secciones (KPIs y
 * recomendaciones) y una narrativa de 3-4 párrafos. Con la generación a demanda el usuario
 * puede pedir SEIS secciones, cada una con su directiva propia en el prompt, y la narrativa
 * que las cubre no cabe en el presupuesto de dos. El modelo escribía hasta agotarlo y
 * devolvía la frase por la mitad.
 *
 * El presupuesto se calcula, entonces, de lo único que de verdad predice el largo de la
 * salida: CUÁNTAS secciones se pidieron.
 *
 * ═══ DE DÓNDE SALEN LOS NÚMEROS ═══
 *
 * No de una intuición: de medir el prompt que ya existe. Cada directiva de
 * `report-prompt.ts` pide un tramo de prosa ejecutiva —un párrafo denso, no una lista— y
 * un párrafo de ese estilo en español ronda las 120-160 palabras. El español gasta
 * ~1,4 tokens por palabra (más que el inglés: acentos y palabras largas parten en más
 * piezas), así que una sección son ~250 tokens de texto. Se le da el DOBLE, 500, porque el
 * costo de pasarse es un reporte que hay que volver a pedir y el de sobrar es cero — los
 * tokens de salida se cobran por los EMITIDOS, no por los reservados. `max_tokens` es un
 * techo, no una compra.
 *
 * Los 800 de base cubren lo que no depende de las secciones: apertura, cierre, y las
 * transiciones entre secciones.
 *
 * ═══ EL TECHO ═══
 *
 * 6.000 es el tope duro. No es un límite del modelo (Sonnet da mucho más); es un límite de
 * PRODUCTO: una narrativa de más de ~4.000 palabras deja de ser un resumen ejecutivo para
 * el dueño de una PYME, que es exactamente lo que este reporte es. Si alguna vez se topa,
 * el problema a resolver es el prompt, no el presupuesto — y ahora se entera, porque
 * agotar `max_tokens` ya no pasa en silencio.
 */

const BASE = 800;
const POR_SECCION = 500;
const TECHO = 6_000;

export function presupuestoDeNarrativa(sections: readonly ReportSection[]): number {
  return Math.min(TECHO, BASE + POR_SECCION * sections.length);
}
