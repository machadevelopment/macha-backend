// Rate limiting por company_id — decisión CU-868kfv97f (2026-07-24). Jose confirmó
// separar el token-bucket en dos: acciones caras de IA (excel/chat/insight) y lectura
// barata (dashboard/status polling) — compartir un solo cupo bloqueaba el chat cuando
// la empresa tenía Excels grandes en cola. El gate de profundidad de cola se mantiene
// en N=3 sin cambios.
//
// PLACEHOLDER: el split numérico exacto (cuánto más generoso debe ser `read` que `ai`)
// no llegó de Jose (tabla vacía en el comentario de ClickUp). Mientras tanto `read`
// usa el mismo valor que `ai` — la ESTRUCTURA de dos buckets ya es correcta, solo uno
// de los dos números es un placeholder igual al otro. Ajustar en cuanto se confirme.
//
// Implementación real (middleware, Redis, integración con guards) es T38 — este
// ticket solo fija los valores/estructura.
export const rateLimitConfig = {
  /** Gate de profundidad de cola (pg-boss, llave company_id). Confirmado, sin cambios. */
  queueGateMaxJobs: Number(process.env.RATE_LIMIT_QUEUE_GATE_MAX_JOBS ?? 3),
  /** Token-bucket para excel/chat/insight (llave company_id). Aprobado. */
  ai: {
    rpm: Number(process.env.RATE_LIMIT_AI_RPM ?? 60),
    burst: Number(process.env.RATE_LIMIT_AI_BURST ?? 120),
  },
  /**
   * Token-bucket para lectura barata (dashboard/status polling). PLACEHOLDER: mismo
   * valor que `ai` hasta tener la cifra real de Jose; no se inventa un multiplicador.
   */
  read: {
    rpm: Number(process.env.RATE_LIMIT_READ_RPM ?? 60),
    burst: Number(process.env.RATE_LIMIT_READ_BURST ?? 120),
  },
};

// Respuestas de error acordadas (para T38):
// - Token-bucket agotado: HTTP 429 con cabecera Retry-After.
// - Gate de cola lleno: HTTP 429 con cuerpo que distingue el motivo (para que la UI
//   muestre "Ya tienes 3 archivos procesándose, espera a que terminen").
// - Ambos casos registran evento en Sentry con company_id.
