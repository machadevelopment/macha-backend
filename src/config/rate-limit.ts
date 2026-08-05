// Rate limiting por company_id — CU-868kfv97f. Valores REALES aprobados por Jose
// (confirmados sin cambios en su revisión final). No es "IA vs. lectura" plano: el
// gate de cola y el token-bucket cubren cosas distintas.
//
// Gate de profundidad de cola (pg-boss, llave company_id): compartir un solo cupo
// entre excel/chat/insight bloqueaba el chat cuando había Excels grandes en cola.
// Por eso solo los jobs PESADOS (excel, report_generation) pasan por el gate;
// chat/insight son interactivos y NUNCA pasan por el gate — se controlan solo con
// el token-bucket.
//
// Token-bucket en Redis (llave company_id): dos familias, no una.
// - `read`: API general de lectura (dashboard, status polling). Generoso porque no
//   cuesta — el default anterior de 60/min era GLOBAL y se agotaba solo con 5
//   usuarios navegando + polling de estado, sin que hubiera abuso.
// - `ai`: endpoints de IA interactivos (chat, insight). Estricto porque sí cuesta.
//
// Implementación real (middleware, integración con guards) es T38 (CU-868kfvaah) —
// este ticket solo fija los valores/estructura.
export const rateLimitConfig = {
  queueGate: {
    maxJobs: Number(process.env.RATE_LIMIT_QUEUE_GATE_MAX_JOBS || 3),
    /** Solo estos kinds pasan por el gate; chat/insight quedan explícitamente fuera. */
    appliesTo: ['excel', 'report_generation'] as const,
  },
  tokenBucket: {
    /** API general de lectura (dashboard, status polling). */
    read: {
      rpm: Number(process.env.RATE_LIMIT_READ_RPM || 120),
      burst: Number(process.env.RATE_LIMIT_READ_BURST || 240),
    },
    /** Endpoints de IA interactivos: chat, insight. Excel/reporte NO pasan por aquí
     * — se controlan solo por el gate de cola de arriba. */
    ai: {
      rpm: Number(process.env.RATE_LIMIT_AI_RPM || 20),
      burst: Number(process.env.RATE_LIMIT_AI_BURST || 30),
    },
  },
};

// Respuestas de error acordadas (para T38/CU-868kfvaah):
// - Token-bucket agotado: HTTP 429 con cabecera Retry-After. → IMPLEMENTADO.
// - Gate de cola lleno: HTTP 429 con cuerpo que distingue el motivo (para que la UI
//   muestre "Ya tienes 3 archivos procesándose, espera a que terminen"). → IMPLEMENTADO.
// - Ambos casos registran evento en Sentry con company_id. → IMPLEMENTADO en
//   CU-868kh92fz vía `reportRateLimited()` (src/lib/rate-limit.ts). Se registra como
//   evento de nivel WARNING, no como excepción: un rate limit que rechaza es el
//   mecanismo funcionando, y ensuciar el feed de errores haría que se ignore.
//   `company_id` va como tag (no en el mensaje) para que Sentry agrupe por mecanismo
//   y permita desglosar qué empresas topan y con qué frecuencia.
//
// Consumo real de los buckets (CU-868kh8qhp):
// - `ai`: chat (POST /chats/:id/messages) e insight (POST /insights).
// - `read`: /metrics, /ar-ap, /documents (lista y polling de estado), /reports
//   (lista, detalle y /view) y /credits/balance.
// - `/admin/*` NO pasa por ningún bucket: es staff, no tenant, y estos se llavean por
//   company_id. Limitar el backoffice sería otra decisión, con su propio criterio.
