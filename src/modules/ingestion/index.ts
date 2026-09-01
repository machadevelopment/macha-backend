import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { intakeConfig } from '@/config/intake';
import { uploadKey, uploadObject } from '@/lib/s3';
import { inspectXlsxWorkbook, estimateBatchCount } from '@/lib/xlsx-inspect';
import { countCsvRows } from '@/lib/csv-inspect';
import { fileMentionsCurrency, isScannable } from '@/lib/currency-scan';
import { counterCurrency, loadFxCatalog, type Currency } from '@/lib/fx';
import { INTAKE_MESSAGES } from '@/lib/intake-messages';
import { cancelDocumentRows, revertDocument, encolarPromocionDeLoResuelto } from '@/lib/promotion';
import {
  costoDeCuentaPorPagar,
  esFilaDerivada,
  esTipoDeEgreso,
  yaTieneSuCosto,
} from '@/lib/derivacion-de-costo';
import { refreshExistingRollups } from '@/lib/rollups';
import { getActiveCreditRule, getCreditBalance, estimateRequiredCredits } from '@/lib/credits';
import { checkQueueGate, enforceTokenBucket, reportRateLimited } from '@/lib/rate-limit';
import { rateLimitConfig } from '@/config/rate-limit';
import { documents, companies, stagingRows, documentIngestBatches } from '@/db/schema';
import { enqueue, QUEUES, RETRY_POLICY } from '@/queue';
import {
  claveDeConcepto,
  textoDeConcepto,
  guardarReglasAprendidas,
  type ReglaAprendida,
} from '@/lib/category-dictionary';
// Una sola definición de "esto lo puede contestar el cliente", compartida con el worker que
// manda el correo: si el conteo del correo y la lista de esta pantalla se separan, el producto
// promete un número de preguntas y muestra otro.
import { esArreglablePorCategoria, quedaLimpiaAlContestar } from '@/lib/conceptos-pendientes';

const ALLOWED_MIME_EXT: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
};

const MESSAGES = INTAKE_MESSAGES;

export const ingestion = new Elysia({ prefix: '/documents' })
  .use(tenantDerive)
  .post(
    '/',
    async ({ body, companyId, userId, role, set, db }) => {
      assertClientCapability(role, 'upload_excel', set);

      const [company] = await db
        .select({ locale: companies.locale, baseCurrency: companies.baseCurrency })
        .from(companies)
        .where(eq(companies.id, companyId));
      const msg = MESSAGES[company?.locale ?? 'es'];

      const file = body.file;
      const mime = file.type;
      const ext = ALLOWED_MIME_EXT[mime];

      // Hard rejection at receipt, BEFORE queueing a job or persisting to S3 — none of
      // the checks below touch S3/documents until every cap passes.
      if (!ext) {
        set.status = 415;
        return { error: msg.unsupportedType(mime) };
      }

      const sizeMb = file.size / (1024 * 1024);
      if (sizeMb > intakeConfig.maxFileSizeMb) {
        set.status = 413;
        return { error: msg.fileTooLarge(intakeConfig.maxFileSizeMb, sizeMb) };
      }

      const buffer = new Uint8Array(await file.arrayBuffer());

      // Pre-check barato, sin parseo completo (CU-868kfv972: "parsear el libro entero
      // para contar ya es procesar"). También alimenta el bloqueo por créditos de
      // abajo (CU-868kfvaa6): la regla `excel` se cobra por lote, así que hace falta
      // estimar cuántos lotes serán ANTES de encolar.
      //
      // CU-868kh8man: cada formato se inspecciona con lo que permite su estructura.
      // Antes solo se validaba `.xlsx` y el resto pasaba nada más por el cap de
      // tamaño, así que un CSV de 9 MB con cientos de miles de filas entraba entero.
      let estimatedBatches = 1;
      let sheetRowCounts: number[] | null = null;

      if (ext === 'xlsx') {
        sheetRowCounts = inspectXlsxWorkbook(buffer).sheetRowCounts;
      } else if (ext === 'csv') {
        // Un CSV es una sola "hoja"; contar registros respetando comillas es barato
        // (un escaneo de bytes) y no materializa ninguna fila.
        sheetRowCounts = [countCsvRows(buffer)];
      }
      // `.xls` (binario legacy OLE2) no tiene forma barata de inspección: sus caps se
      // aplican en el worker, después del parseo que igual tiene que hacer y ANTES de
      // cualquier llamada a Claude (ver queue/workers/excel-ingest.ts). No queda sin
      // validar, solo se valida más tarde.

      if (sheetRowCounts) {
        if (sheetRowCounts.length > intakeConfig.maxSheetsPerWorkbook) {
          set.status = 413;
          return {
            error: msg.tooManySheets(intakeConfig.maxSheetsPerWorkbook, sheetRowCounts.length),
          };
        }

        const totalRows = sheetRowCounts.reduce((a, b) => a + b, 0);
        if (totalRows > intakeConfig.maxRowsPerFile) {
          set.status = 413;
          return { error: msg.tooManyRows(intakeConfig.maxRowsPerFile, totalRows) };
        }

        estimatedBatches = estimateBatchCount(
          sheetRowCounts,
          intakeConfig.largeSheetRowThreshold,
          intakeConfig.batchSize,
        );
      }

      // CU-868kjc6h1 criterio 2: moneda extranjera sin NINGUNA tasa registrada. Es el
      // único caso en que se puede afirmar en la recepción que la carga no tiene salida
      // — sin una sola fila en el catálogo, cualquier monto en esa moneda tumbaría la
      // promoción entera, que es atómica. Con al menos una tasa el archivo pasa: si
      // faltara la de una fecha concreta, esa fila se marca para revisión al
      // clasificarla (lib/staging.ts) en vez de tumbar el documento.
      //
      // Va aquí, junto al resto de caps, por la misma razón que ellos: nada se ha
      // subido a S3 ni encolado todavía, así que un rechazo no deja rastro que limpiar.
      if (company && isScannable(ext)) {
        const base = company.baseCurrency as Currency;
        const quote = counterCurrency(base);
        if (fileMentionsCurrency(buffer, ext, quote)) {
          const catalog = await loadFxCatalog(db, companyId, base, quote);
          if (catalog.length === 0) {
            set.status = 422;
            return { error: msg.missingFxRate(quote, base), reason: 'missing_fx_rate' };
          }
        }
      }

      // Hard block on insufficient credits (CU-868kfvaa6, CU-868kfv97x): verify BEFORE
      // enqueueing the AI job — no call, no consumption row, if the balance is short.
      // No active rule for `excel` (v1 default, see scripts/seed.ts) means no cap.
      const creditRule = await getActiveCreditRule(db, 'excel');
      if (creditRule) {
        const requiredCredits = estimateRequiredCredits(creditRule, estimatedBatches);
        const balance = await getCreditBalance(db, companyId);
        if (balance < requiredCredits) {
          set.status = 402;
          return { error: msg.insufficientCredits(requiredCredits, balance) };
        }
      }

      // Gate de profundidad de cola (CU-868kfvaah, valores de CU-868kfv97f): rechazo
      // sin subir a S3 ni encolar si ya hay demasiados jobs pesados activos/encolados.
      const gate = await checkQueueGate(companyId, 'excel');
      if (!gate.allowed) {
        set.status = 429;
        // CU-868kh92fz: el otro mecanismo de 429. Se reporta con el mismo formato que
        // el token-bucket para poder contar ambos juntos y distinguirlos por tag.
        reportRateLimited({
          mechanism: 'queue_gate',
          companyId,
          route: 'POST /documents',
          detail: 'excel',
        });
        return { error: msg.queueFull(rateLimitConfig.queueGate.maxJobs), reason: 'queue_full' };
      }

      // All caps passed — now (and only now) persist original + create documents row.
      const documentId = randomUUID();
      const s3Key = uploadKey(companyId, documentId, ext);
      await uploadObject(s3Key, buffer, mime);

      const [doc] = await db
        .insert(documents)
        .values({
          id: documentId,
          companyId,
          uploadedBy: userId,
          s3Key,
          originalFilename: file.name,
          fileSizeBytes: file.size,
          mimeType: mime,
          status: 'queued',
        })
        .returning();

      await enqueue(QUEUES.excelIngest, { documentId, companyId });

      set.status = 202;
      return { documentId: doc!.id, status: doc!.status };
    },
    {
      body: t.Object({
        // Outer bound only (well above the real cap) so obviously-abusive uploads never
        // reach the handler; the precise, locale-aware rejection happens inside it.
        file: t.File({ maxSize: '50m' }),
      }),
    },
  )
  // CU-868kfva7z: list + single-document status polling for the upload UI's
  // pipeline (queued/processing/review/promoted/failed). No separate capability
  // gate — view_dashboard_reports covers all client roles same as upload_excel.
  .get(
    '/',
    async ({ companyId, role, query, set, db }) => {
      assertClientCapability(role, 'view_dashboard_reports', set);

      // CU-868kh8qhp: bucket `read`.
      const limited = await enforceTokenBucket('read', companyId, set, 'GET /documents');
      if (limited) return limited;

      // CU-868kh913c: antes era un `.limit(50)` fijo SIN parámetros de paginación —
      // el cliente no podía llegar al documento 51 nunca, y nada se lo decía. Un
      // subconjunto truncado en silencio es peor que uno lento. Mismo patrón
      // "load more" (limit+1 para saber si hay más sin un COUNT aparte) que ya usan
      // /admin/staging-rows y /admin/documents.
      const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
      const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
      const rows = await db
        .select({
          id: documents.id,
          originalFilename: documents.originalFilename,
          status: documents.status,
          rowCount: documents.rowCount,
          flaggedCount: documents.flaggedCount,
          errorReason: documents.errorReason,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(eq(documents.companyId, companyId))
        .orderBy(desc(documents.createdAt))
        .limit(limit + 1)
        .offset(offset);
      return { documents: rows.slice(0, limit), hasMore: rows.length > limit };
    },
    { query: t.Object({ limit: t.Optional(t.String()), offset: t.Optional(t.String()) }) },
  )
  /**
   * CU-868kh8nhy: expone la reversión, que existía como `revertDocument()` en
   * lib/promotion.ts desde CU-868kfva9z pero no la alcanzaba ninguna ruta — el
   * criterio "reversión soft-delete por document_id" estaba implementado y muerto.
   *
   * Atomicidad: `db` aquí ya viene dentro de una transacción por request
   * (tenant.derive → reserveCompanyConnection abre `begin`), así que los
   * soft-deletes de transactions/invoices/bills y el cambio de estado del documento
   * se confirman o se revierten juntos.
   */
  /**
   * Cancelar una carga en curso.
   *
   * ═══ LA SALIDA QUE NO EXISTÍA ═══
   *
   * Un documento en `queued`/`processing` no tenía ninguna: `revert` exige `promoted` y
   * devuelve 409, y reintentar no aplica porque el job sigue vivo. Si una carga se colgaba,
   * el cliente se quedaba mirando "PROCESSING" sin poder hacer nada. Reportado el
   * 2026-08-14 ("llevo aca como 10min... tampoco tengo forma de parar el upload") y hubo que
   * destrabarlo a mano contra la base.
   *
   * ═══ LA CANCELACIÓN ES COOPERATIVA, Y NO PUEDE SER DE OTRA FORMA ═══
   *
   * Esto NO mata el job: no se puede interrumpir una llamada a Claude ya pagada ni abortar
   * una transacción en vuelo desde otra request. Lo que hace es marcar el documento, y el
   * worker lo consulta ANTES de cada lote y se detiene.
   *
   * Consecuencia que hay que aceptar de frente: si el worker está a mitad de un lote, ese
   * lote se termina y se cobra. Cancelar acota el gasto, no lo corta en seco. Prometer lo
   * segundo sería mentir sobre lo que el sistema puede hacer.
   *
   * CU-868kttzb1: lo ya promovido SÍ se deshace (soft-delete), igual que al revertir.
   *
   * Antes no, con este razonamiento: "esos lotes se pagaron y sus huellas quedan
   * registradas, así que volver a subir cobra solo lo que falta". La primera mitad seguía
   * siendo cierta —las huellas no se borran nunca— pero la segunda escondía un agujero:
   * `findSeenFingerprints` solo deja bloquear a las huellas de documentos CON DATOS VIVOS, y
   * `cancelled` está excluido de esa lista. O sea que las filas se quedaban en el ledger sin
   * nada que impidiera volver a insertarlas. Resubir el archivo duplicaba los números.
   */
  .post('/:id/cancel', async ({ companyId, role, params, set, db }) => {
    // Mismo permiso que revertir: las dos son "deshacer mi propia carga".
    assertClientCapability(role, 'revert_upload', set);

    const [doc] = await db
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }

    // Idempotente, igual que revert: un doble clic o un reintento de red no es un error.
    if (doc.status === 'cancelled') {
      return { id: doc.id, status: 'cancelled' as const, alreadyCancelled: true };
    }

    /*
     * Solo tiene sentido sobre una carga EN CURSO. Cancelar una ya terminada escondería un
     * malentendido detrás de un 200 — y sobre todo, cancelar una `promoted` no desharía sus
     * filas: para eso está `revert`, y el mensaje lo dice para que nadie use una por la otra.
     *
     * ⚠️ `awaiting_confirmation` ENTRA, y sin eso el portón (0042) dejaba cargas trabadas SIN
     * SALIDA (verificado en producción 2026-09-01: tres cargas de la empresa `test` que el
     * cliente no podía sacarse de encima, con `cancel` devolviendo 409). No tocan el
     * dashboard —el portón las retiene— pero se quedan en su lista para siempre pidiéndole una
     * decisión sobre un archivo que ya no quiere, y la única alternativa que le queda es
     * PUBLICAR datos que sabe que están mal para después revertirlos.
     *
     * Es seguro por construcción y no por suerte: el portón se afirma en los DOS llamadores de
     * la promoción, así que una carga en ese estado no tiene una sola fila promovida. Y
     * `cancelDocumentRows` deshace igual lo que encuentre, así que la garantía no depende de
     * que esa premisa siga siendo cierta.
     *
     * Es la forma exacta que el portón vino a crear: reintroduce el "trámite bloqueante" que la
     * migración 0020 eliminó, pero sobre la carga entera. Cancelar es la puerta de salida.
     */
    const CANCELABLES = ['queued', 'processing', 'awaiting_confirmation'];
    if (!CANCELABLES.includes(doc.status)) {
      set.status = 409;
      return {
        error:
          doc.status === 'promoted'
            ? 'Esta carga ya terminó. Para deshacer sus datos usa "revertir", no "cancelar".'
            : `Solo se puede cancelar una carga en curso (estado actual: ${doc.status}).`,
      };
    }

    const [empresa] = await db
      .select({ locale: companies.locale })
      .from(companies)
      .where(eq(companies.id, companyId));

    /*
     * CU-868kttzb1: cancelar DESHACE lo que alcanzó a promoverse.
     *
     * Antes esto solo cambiaba el estado. La promoción es parcial e incremental (migración
     * 0020), así que una carga cancelada a medias dejaba filas VIVAS — y como
     * `findSeenFingerprints` excluye `cancelled` de los estados con datos vivos, sus huellas
     * dejaban de bloquear: resubir el mismo archivo las metía otra vez. Ese era el bug de
     * los números duplicados.
     *
     * El `errorReason` se escribe en el mismo update de estado que hace `cancelDocumentRows`
     * no: se pone después, sobre la fila que esa función ya dejó en `cancelled`.
     */
    await cancelDocumentRows(db, companyId, params.id);
    /*
     * ═══ CANCELAR TAMBIÉN TIENE QUE REFRESCAR EL CACHÉ, POR EL MISMO MOTIVO QUE REVERTIR ═══
     *
     * `revert` lo hacía desde el principio y esto no, y la asimetría no era una decisión:
     * cuando `cancel` solo cambiaba el estado no había filas que deshacer, así que no había
     * caché que corregir. Desde CU-868kttzb1 cancelar DESHACE lo que alcanzó a promoverse
     * (promoción parcial, migración 0020) — o sea que sí las hay, y el refresco se quedó del
     * otro lado del cambio.
     *
     * El síntoma es el peor de esta casa porque no falla nada: las cifras del dashboard salen
     * de `metric_rollups`, que es un CACHÉ, así que seguían contando transacciones ya
     * soft-borradas hasta que alguna otra carga de esa empresa lo recalculara de rebote. El
     * cliente ve un ingreso que ya no existe, el asesor —que consulta `transactions`— ve el
     * verdadero, y las dos cifras se contradicen sin que ninguna se pueda desmentir.
     *
     * Va acá y no dentro de `cancelDocumentRows` a propósito: esa función es el DESHACER de
     * las filas y corre también desde el worker, dentro de la transacción del documento;
     * `refreshExistingRollups` escribe un caché de toda la empresa y no tiene nada que hacer
     * dentro de esa transacción. Es la misma división que ya tiene `revert` unas líneas abajo.
     */
    await refreshExistingRollups(db, companyId);
    await db
      .update(documents)
      .set({ errorReason: MESSAGES[empresa?.locale ?? 'es'].cancelledByUser() })
      .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));

    return { id: doc.id, status: 'cancelled' as const, alreadyCancelled: false };
  })
  .post('/:id/revert', async ({ companyId, role, params, set, db }) => {
    assertClientCapability(role, 'revert_upload', set);

    const [doc] = await db
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }

    // Idempotente: revertir dos veces no duplica efectos ni es un error para quien
    // llama (p. ej. un doble clic o un reintento de red).
    if (doc.status === 'reverted') {
      return { id: doc.id, status: 'reverted' as const, alreadyReverted: true };
    }

    // Solo un documento promovido tiene filas de negocio que deshacer. Revertir uno
    // en cola/proceso/fallido no tiene sentido y ocultaría un malentendido del
    // usuario detrás de un 200.
    if (doc.status !== 'promoted') {
      set.status = 409;
      return {
        error: `Solo se puede revertir un documento promovido (estado actual: ${doc.status}).`,
      };
    }

    await revertDocument(db, companyId, params.id);
    // Las cifras del dashboard salen de metric_rollups; sin esto seguirían contando
    // las transacciones recién soft-borradas hasta la próxima ingesta.
    await refreshExistingRollups(db, companyId);

    return { id: doc.id, status: 'reverted' as const, alreadyReverted: false };
  })
  /**
   * Reintento de un documento fallido, sin volver a subir el archivo.
   *
   * Por qué se puede: el original sigue en S3 (`documents.s3_key`) y el worker ya es
   * REANUDABLE, no solo idempotente (CU-868kkgypv): lleva la marca de cada lote
   * confirmado en `document_ingest_batches` y se salta los ya hechos ANTES de llamar a
   * Claude. Reencolar es exactamente lo que hace pg-boss en sus propios reintentos, así
   * que esto no abre un camino nuevo — expone el que ya existía, que hasta ahora se
   * agotaba en silencio y dejaba al cliente sin más salida que volver a subir el mismo
   * archivo, pagando de nuevo TODOS los lotes.
   *
   * Solo desde `failed`: reencolar uno en cola/proceso duplicaría el job, y uno
   * promovido/revertido no tiene nada que reintentar.
   */
  .post('/:id/retry', async ({ companyId, role, params, set, db }) => {
    assertClientCapability(role, 'upload_excel', set);

    const [doc] = await db
      .select({
        id: documents.id,
        status: documents.status,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }

    /*
     * ═══ TAMBIÉN SE PUEDE DESATASCAR UNA CARGA COLGADA (Jose, 2026-08-14) ═══
     *
     * Síntoma textual: *"ahorita se quedó trabada la ingesta"*.
     *
     * Antes esto exigía `failed` y nada más. Pero un documento puede quedarse en
     * `processing` PARA SIEMPRE, y ese estado no lo escribe ningún fallo:
     *
     *   · pg-boss VENCE el job (`expireInSeconds`, una hora para la ingesta) y abandona la
     *     promesa del worker. El `catch` que escribe `status='failed'` nunca corre.
     *   · Con `retryLimit: 3` agotado, pg-boss marca el job fallido en SUS tablas — pero
     *     nadie escribe `documents.status`. El documento queda en `processing` sin ningún
     *     job vivo detrás.
     *   · El proceso muere a media carga (deploy, OOM) después del último reintento.
     *
     * En los tres casos el documento quedaba **irrecuperable desde la interfaz**: no se
     * puede revertir (exige `promoted`), no se puede cancelar (el worker que leería la
     * cancelación ya no existe) y no se podía reintentar. La única salida era volver a
     * subir el archivo — y desde el bug de las huellas, ni eso funcionaba.
     *
     * ES SEGURO REENCOLARLO, y no por optimismo: el worker es REANUDABLE, no solo
     * idempotente. Lleva la marca de cada lote confirmado en `document_ingest_batches` y se
     * los salta ANTES de llamar a Claude, así que un reintento cubre exactamente lo que
     * falta. Es la misma garantía sobre la que ya se apoyan los reintentos de pg-boss.
     *
     * EL UMBRAL ES EL VENCIMIENTO DE LA COLA, no un número inventado: pasado ese tiempo
     * pg-boss ya dio el job por muerto, así que no puede haber uno vivo con el que chocar.
     * Y aunque lo hubiera, la reanudación por lote acota el daño a repetir un lote.
     *
     * `updated_at` NO se mantiene (no hay trigger y ningún UPDATE lo escribe), así que en la
     * práctica la referencia es la hora de CREACIÓN del documento. Es el lado conservador a
     * propósito: exige que pase más tiempo, no menos, y no depende de una columna que hoy
     * miente. Si algún día se agrega el trigger, este código empieza a ser más preciso solo.
     */
    const vencimientoMs = (RETRY_POLICY[QUEUES.excelIngest].expireInSeconds ?? 3_600) * 1_000;
    const referencia = doc.updatedAt ?? doc.createdAt;
    const colgado =
      (doc.status === 'processing' || doc.status === 'queued') &&
      referencia !== null &&
      Date.now() - new Date(referencia).getTime() > vencimientoMs;

    if (doc.status !== 'failed' && !colgado) {
      set.status = 409;
      return {
        error:
          doc.status === 'processing' || doc.status === 'queued'
            ? `Esta carga todavía está en curso. Si sigue así en un rato, vuelve a intentarlo (estado actual: ${doc.status}).`
            : `Solo se puede reintentar un documento fallido o una carga colgada (estado actual: ${doc.status}).`,
      };
    }

    // Mismo gate de profundidad de cola que la subida: un reintento cuesta lo mismo que
    // una carga nueva y no debe poder saltárselo.
    const gate = await checkQueueGate(companyId, 'excel');
    if (!gate.allowed) {
      set.status = 429;
      reportRateLimited({
        mechanism: 'queue_gate',
        companyId,
        route: 'POST /documents/:id/retry',
        detail: 'excel',
      });
      const [company] = await db
        .select({ locale: companies.locale })
        .from(companies)
        .where(eq(companies.id, companyId));
      return {
        error: MESSAGES[company?.locale ?? 'es'].queueFull(rateLimitConfig.queueGate.maxJobs),
        reason: 'queue_full',
      };
    }

    // `error_reason` se limpia acá y no al terminar: mientras el job corre, el error
    // anterior ya no describe el estado del documento.
    await db
      .update(documents)
      .set({ status: 'queued', errorReason: null })
      .where(eq(documents.id, params.id));

    await enqueue(QUEUES.excelIngest, { documentId: params.id, companyId });

    return { id: doc.id, status: 'queued' as const };
  })
  .get('/:id', async ({ companyId, role, params, set, db }) => {
    assertClientCapability(role, 'view_dashboard_reports', set);

    // CU-868kh8qhp: bucket `read`. Esta es LA ruta de polling de estado del pipeline
    // de ingesta — el caso concreto que config/rate-limit.ts cita al justificar por
    // qué el bucket `read` es generoso (120 rpm) en vez de compartir cupo con `ai`.
    const limited = await enforceTokenBucket('read', companyId, set, 'GET /documents/:id');
    if (limited) return limited;

    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }
    return {
      id: doc.id,
      originalFilename: doc.originalFilename,
      status: doc.status,
      rowCount: doc.rowCount,
      flaggedCount: doc.flaggedCount,
      errorReason: doc.errorReason,
      createdAt: doc.createdAt,
      /*
       * CU-868krmrcj: qué entendió el sistema de ESTE archivo — hojas procesadas, descartadas
       * con su motivo, y de qué columna salió cada campo.
       *
       * Va en el detalle y no en el listado a propósito: es un objeto por documento que solo
       * tiene sentido mirar de a uno, y meterlo en la lista lo mandaría por la red en cada
       * poll de estado (esta ruta es la de polling del pipeline) multiplicado por documento.
       *
       * `null` = documento anterior a la migración 0028, o que nunca llegó a procesarse. La UI
       * lo distingue de un resumen vacío: al primero no le debe una explicación al cliente,
       * del segundo sí.
       */
      readSummary: doc.readSummary ?? null,
    };
  })

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════
   * LO QUE EL SISTEMA NO ENTENDIÓ, PARA QUE LO CONTESTE QUIEN SÍ SABE
   * ═════════════════════════════════════════════════════════════════════════════════════════
   *
   * Decisión de Semi, 2026-08-20: cuando queda un concepto sin clasificar, se le pregunta al
   * CLIENTE durante la subida — **no** va a revisión interna. El motivo es simple y no es de
   * costos: es la persona que sabe qué es "Cropa" en su propio libro. Nosotros podemos
   * adivinar; el dueño lo sabe.
   *
   * ═══ SE PREGUNTA POR CONCEPTO, NO POR FILA — Y ES LO QUE HACE VIABLE LA PANTALLA ═══
   *
   * Un archivo con 400 filas marcadas puede tener seis conceptos distintos. Preguntar por fila
   * serían 400 preguntas y nadie las contesta: sería revisión interna con otro nombre, en la
   * cara del cliente. Preguntar por concepto son seis, y cada respuesta arregla todas sus
   * filas de una vez y **queda aprendida para las cargas siguientes**.
   *
   * ═══ SOLO LO QUE UNA CATEGORÍA PUEDE ARREGLAR ═══
   *
   * Se filtran los motivos de marcado que una respuesta del cliente resuelve de verdad: no
   * saber qué es (`low_confidence`), no haber podido nombrarlo (`missing_category`) o haberlo
   * nombrado con un tipo inválido (`invalid_type`).
   *
   * Una fila marcada por `invalid_date` o `invalid_amount` NO aparece acá, y eso es
   * deliberado: su problema es el dato, no el nombre. Mostrarla sería pedirle al cliente una
   * respuesta que no cambia nada — y peor, dejarle la impresión de que ya lo arregló. Esas
   * siguen su camino por revisión interna.
   */
  .get('/:id/conceptos-pendientes', async ({ companyId, role, params, set, db }) => {
    assertClientCapability(role, 'upload_excel', set);

    const [doc] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));
    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }

    /*
     * El filtro por `companyId` va ADEMÁS del documento, no en su lugar. El documento ya se
     * verificó arriba, así que es redundante — y se pone igual porque es la regla que este
     * proyecto no negocia: ninguna consulta a una tabla de negocio sin `company_id`. Una
     * consulta correcta por accidente deja de serlo la primera vez que alguien la copia.
     */
    const filas = await db
      .select({
        payload: stagingRows.payload,
        targetEntity: stagingRows.targetEntity,
        flagReason: stagingRows.flagReason,
      })
      .from(stagingRows)
      .where(
        and(
          eq(stagingRows.companyId, companyId),
          eq(stagingRows.documentId, params.id),
          eq(stagingRows.reviewStatus, 'pending'),
          isNull(stagingRows.promotedAt),
        ),
      );

    /*
     * El agrupado se hace en CÓDIGO y no con un `GROUP BY`. No es pereza: la clave del grupo
     * es `claveDeConcepto(textoDeConcepto(payload))`, la MISMA normalización que usa el
     * diccionario para guardar y para buscar. Un `GROUP BY lower(...)` en SQL agruparía
     * distinto —sin quitar acentos, sin colapsar palabras funcionales— y el cliente vería
     * "Pago a CLARO" y "pago claro" como dos preguntas, contestaría las dos, y la segunda
     * regla pisaría a la primera.
     */
    const porConcepto = new Map<
      string,
      {
        concepto: string;
        ejemplo: string;
        filas: number;
        entity: string;
        /** Totales POR MONEDA. Ver la nota de abajo: sumarlas juntas daría una cifra falsa. */
        montos: Map<string, number>;
      }
    >();

    for (const f of filas) {
      if (!esArreglablePorCategoria(f.flagReason)) continue;
      /*
       * Y además tiene que quedar LISTA con la respuesta. `evaluateFlagReason` devuelve
       * `low_confidence` antes de mirar fecha, monto y moneda, así que una fila con un
       * problema de dato se presenta como contestable con su problema real escondido detrás.
       * Preguntarla es pedirle al cliente una respuesta que no cambia nada — y peor, dejarle
       * la impresión de que lo resolvió. Ver `quedaLimpiaAlContestar`.
       */
      if (!quedaLimpiaAlContestar(f)) continue;
      const p = f.payload as {
        description?: unknown;
        product?: unknown;
        counterparty?: unknown;
        originalAmount?: unknown;
        originalCurrency?: unknown;
      };
      /*
       * El texto sale de `description`, `product` o `counterparty` — el primero que exista.
       * Antes salía SOLO de `description`, y las 1.739 filas de producción que no la traen
       * quedaban invisibles para el cliente: su pantalla mostraba cero conceptos y las sesenta
       * filas se iban enteras a revisión interna. Ver `textoDeConcepto`.
       */
      const texto = textoDeConcepto(p);
      const clave = claveDeConcepto(texto);
      if (clave === null) continue;

      const monto = typeof p.originalAmount === 'number' ? Math.abs(p.originalAmount) : 0;
      /*
       * ═══ LOS MONTOS VAN SEPARADOS POR MONEDA, NO SUMADOS ═══
       *
       * Estas filas están en STAGING: traen `originalAmount` + `originalCurrency` y todavía no
       * tienen `amount_base`, porque la conversión ocurre al promover (`lib/promotion.ts`, con
       * la tasa snapshoteada por fila). O sea que acá no hay una cifra convertida que sumar.
       *
       * Sumar GTQ con USD daría un número que no es ninguna de las dos cosas, mostrado al lado
       * del nombre de un concepto como si fuera plata de verdad. En una herramienta de CFO eso
       * no es un detalle de formato: un USD contado como un quetzal subestima ~7,7 veces, y el
       * cliente no tiene forma de notarlo.
       *
       * Se agrupa por moneda y la pantalla las muestra por separado. Para el caso común —una
       * sola moneda— se ve exactamente igual que un total.
       */
      const moneda = typeof p.originalCurrency === 'string' ? p.originalCurrency : 'GTQ';

      const actual = porConcepto.get(clave);
      if (actual) {
        actual.filas++;
        actual.montos.set(moneda, (actual.montos.get(moneda) ?? 0) + monto);
      } else {
        porConcepto.set(clave, {
          concepto: clave,
          // El texto CRUDO de la primera fila, no la clave normalizada: el cliente reconoce
          // lo que él escribió en su archivo, no `pago|claro`. Y es el MISMO texto del que
          // salió la clave — con `p.description` a secas, una fila identificada por su
          // producto le mostraría la palabra "null" como nombre del concepto.
          ejemplo: String(texto),
          filas: 1,
          entity: f.targetEntity,
          montos: new Map([[moneda, monto]]),
        });
      }
    }

    /*
     * Ordenado por PLATA y no por cantidad de filas. Si el cliente contesta tres de seis y se
     * va, que las tres que contestó sean las que más mueven su contabilidad. Cien filas de
     * Q 5 pesan menos que dos de Q 40.000, y el orden de una lista es lo único que decide qué
     * se contesta cuando nadie la termina.
     *
     * El criterio es el MAYOR total de una sola moneda, no la suma de todas: sumarlas para
     * ordenar volvería a mezclar lo que arriba se separó, y con una tasa implícita de 1:1 el
     * orden podría quedar al revés para un cliente que factura en dólares.
     */
    const conceptos = [...porConcepto.values()]
      .map((c) => ({
        concepto: c.concepto,
        ejemplo: c.ejemplo,
        filas: c.filas,
        entity: c.entity,
        montos: [...c.montos.entries()]
          .map(([currency, total]) => ({ currency, total }))
          .sort((a, b) => b.total - a.total),
      }))
      .sort((a, b) => (b.montos[0]?.total ?? 0) - (a.montos[0]?.total ?? 0));

    return { conceptos, total: conceptos.length };
  })

  /**
   * La respuesta del cliente: qué es cada concepto.
   *
   * Hace dos cosas en una transacción, y las dos importan por separado:
   *
   *  1. **Guarda la regla** con `source: 'confirmado_por_cliente'`, que es la autoridad más
   *     alta del diccionario. De acá en adelante no se le vuelve a preguntar, y ninguna
   *     inferencia posterior del modelo la pisa (ver `category-dictionary.ts`).
   *  2. **Arregla las filas de ESTA carga** que quedaron esperando por ese concepto, y encola
   *     su promoción. Sin este segundo paso el cliente contestaría y su dashboard seguiría
   *     igual — la pregunta se sentiría inútil y con razón.
   *
   * ═══ QUÉ DECIDE EL CLIENTE Y QUÉ NO ═══
   *
   * Decide `type` (ingreso / costo directo / gasto / otro) y `category` (el nombre del rubro).
   * NO decide `entity` —transacción, factura o cuenta por pagar—: esa es una forma contable
   * que el sistema ya determinó al leer la fila, y preguntársela sería pedirle una decisión
   * de contabilidad en vez de una de su negocio. Se conserva la que la fila ya tenía.
   *
   * El `type` viene acotado por el esquema a los cuatro válidos. Si llegara cualquier otro,
   * `staging-rules` volvería a marcar la fila y el cliente habría contestado para nada.
   */
  .post(
    '/:id/conceptos',
    async ({ companyId, userId, role, params, body, set, db }) => {
      assertClientCapability(role, 'upload_excel', set);

      const [doc] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));
      if (!doc) {
        set.status = 404;
        return { error: 'Document not found' };
      }

      const pendientes = await db
        .select({
          id: stagingRows.id,
          payload: stagingRows.payload,
          targetEntity: stagingRows.targetEntity,
          flagReason: stagingRows.flagReason,
          // La hoja se HEREDA en la fila derivada: sin esto el cuadre por hoja (migración
          // 0039) contaría el costo fuera de la hoja que lo produjo y reportaría un
          // descuadre en las dos.
          sheetName: stagingRows.sheetName,
        })
        .from(stagingRows)
        .where(
          and(
            eq(stagingRows.companyId, companyId),
            eq(stagingRows.documentId, params.id),
            eq(stagingRows.reviewStatus, 'pending'),
            isNull(stagingRows.promotedAt),
          ),
        );

      /* Las respuestas, indexadas por la MISMA clave normalizada con la que se preguntó. */
      const respuestas = new Map<string, { type: string; category: string }>();
      for (const r of body.respuestas) {
        const clave = claveDeConcepto(r.concepto) ?? claveDeConcepto(r.ejemplo ?? null);
        if (clave === null) continue;
        respuestas.set(clave, { type: r.type, category: r.category.trim() });
      }
      if (respuestas.size === 0) {
        set.status = 422;
        return { error: 'Ninguna respuesta trae un concepto reconocible' };
      }

      let filasResueltas = 0;
      const reglas: ReglaAprendida[] = [];
      const vistos = new Set<string>();

      for (const fila of pendientes) {
        if (!esArreglablePorCategoria(fila.flagReason)) continue;
        /*
         * ⚠️ Y NO SE LIMPIA UNA MARCA QUE SOBREVIVE A LA RESPUESTA. Medido en producción con
         * `libro-el-infierno`: una venta en EUR llegó con confianza baja, se ofreció como
         * concepto, el cliente la contestó, la marca se limpió — y al promover `resolveFxRate`
         * no encontró tasa para EUR y LANZÓ. La promoción es UNA transacción, así que se cayó
         * la de las otras 17 filas resueltas: el cliente contestó 18 cosas, vio los conceptos
         * vaciarse, y no aterrizó ni una. Sin error en ninguna parte.
         */
        if (!quedaLimpiaAlContestar(fila)) continue;
        const p = fila.payload as Record<string, unknown>;
        /*
         * EL MISMO criterio que usa el GET, y tiene que serlo: si acá se buscara solo por
         * `description`, el cliente vería el concepto en su pantalla —porque el GET ya lo
         * encuentra por `product`— contestaría, y ninguna fila cambiaría. Peor que no
         * mostrarlo: le diría que resolvió algo que sigue igual.
         */
        const texto = textoDeConcepto(p);
        const clave = claveDeConcepto(texto);
        if (clave === null) continue;
        const r = respuestas.get(clave);
        if (!r) continue;

        /*
         * ⚠️ UNA CUENTA POR PAGAR NECESITA QUE ALGUIEN LE DERIVE SU COSTO, Y ACÁ NADIE LO
         * HACÍA (2026-09-01). `construirFilas` la deriva solo cuando el MODELO dio el tipo;
         * cuando no lo dio, la fila llega marcada hasta acá — y este handler actualizaba el
         * payload, limpiaba el flag y promovía. La fila iba a `bills` y `rollups.ts` suma
         * `cogs`/`opex` únicamente de `transactions`, así que el estado de resultados no la
         * veía nunca.
         *
         * Medido en producción con `12-la-ceiba.xlsx`: 12 órdenes de compra por GTQ 56.391,00
         * —el 82 % del costo real del libro—. El cliente contestó, las filas marcadas bajaron
         * de 15 a 3, y la cifra no se movió. Es el bug de U3TECH del lado del cliente, y peor,
         * porque le dijimos que ya estaba resuelto.
         *
         * `yaTieneSuCosto` mira el payload ANTES de aplicar la respuesta, que es el único
         * momento en que se puede distinguir "el modelo no supo" de "la ingesta lo suprimió a
         * propósito" o "ya lo derivó".
         */
        const derivarCosto =
          fila.targetEntity === 'bill' && esTipoDeEgreso(r.type) && !yaTieneSuCosto(p)
            ? costoDeCuentaPorPagar({ payload: p, type: r.type, category: r.category })
            : null;

        /*
         * ⚠️ UNA FILA DERIVADA CONSERVA SU TIPO. Ver `ES_DERIVADA`: el costo de una venta, el
         * ingreso devengado de una factura y el costo de una cuenta por pagar los crea el
         * pipeline por una REGLA CONTABLE, no leyendo el texto de la fila. Y comparten
         * `product`/`counterparty` con su fila origen, así que caen en el MISMO concepto.
         *
         * Medido en producción: el concepto "Aceite 1 L" agrupaba la venta de GTQ 1.890 y su
         * costo derivado de GTQ 1.160. El dueño contestó "es un ingreso" —cierto de su venta—
         * y con eso convirtió el costo en ingreso: +1.160 de ingreso y −1.160 de costo. El
         * total del archivo cuadraba al centavo, así que era invisible; lo que se movía era el
         * MARGEN BRUTO.
         *
         * Se le limpia la marca igual (su duda era la confianza heredada, y su dinero tiene que
         * aterrizar), pero el tipo y la categoría se quedan como los puso la regla.
         */
        const derivada = esFilaDerivada(p);

        await db
          .update(stagingRows)
          .set({
            payload: derivada ? p : { ...p, type: r.type, category: r.category },
            /*
             * `confidence` sube a 1: lo dijo el dueño de la contabilidad. Si se dejara la
             * confianza vieja —la baja que la marcó—, `staging-rules` la volvería a marcar por
             * `low_confidence` y la respuesta del cliente no serviría de nada.
             */
            confidence: '1.0000',
            flagReason: null,
            reviewStatus: 'approved',
            /*
             * El userId del CLIENTE. La columna no tiene FK y hasta ahora solo guardaba
             * staff; que ahora guarde ambos no la vuelve ambigua, porque la procedencia real
             * de la decisión queda en `company_category_rules.source`
             * (`confirmado_por_cliente` vs `corregido_por_staff`), que es append-only.
             */
            reviewedBy: userId,
            reviewedAt: new Date(),
          })
          .where(and(eq(stagingRows.id, fila.id), eq(stagingRows.companyId, companyId)));
        filasResueltas++;

        /*
         * La transacción de costo entra como fila NUEVA de staging, ya aprobada, para que la
         * promueva el mismo camino que todo lo demás. Comparte `document_id` y `sheet_name`
         * con su cuenta por pagar, así que el revert se las lleva juntas y el cuadre por hoja
         * la cuenta donde corresponde.
         */
        if (derivarCosto !== null) {
          await db.insert(stagingRows).values({
            companyId,
            documentId: params.id,
            sheetName: fila.sheetName,
            targetEntity: 'transaction',
            payload: derivarCosto,
            confidence: '1.0000',
            flagReason: null,
            reviewStatus: 'approved',
            reviewedBy: userId,
            reviewedAt: new Date(),
          });
        }

        if (!vistos.has(clave)) {
          vistos.add(clave);
          reglas.push({
            // El mismo texto del que salió la clave: la regla se guarda para que la próxima
            // carga la ENCUENTRE, y `buscar()` normaliza por esa misma vía.
            texto: String(texto),
            entity: fila.targetEntity,
            type: r.type,
            category: r.category,
          });
        }
      }

      /*
       * La regla se guarda para las cargas SIGUIENTES; las filas de esta ya quedaron
       * arregladas arriba. Si esto falla, el cliente no pierde su respuesta —su contabilidad
       * de hoy está bien— pero se le volvería a preguntar la próxima vez. Es molesto y
       * recuperable, así que no tumba la respuesta: se registra y sigue.
       */
      let reglasGuardadas = 0;
      try {
        reglasGuardadas = await guardarReglasAprendidas(db, companyId, reglas, {
          source: 'confirmado_por_cliente',
          createdBy: userId,
        });
      } catch (err) {
        console.error('[documents/conceptos] no se pudo guardar el diccionario:', err);
      }

      // Cierra el ciclo: lo aprobado entra a la contabilidad. Mismo camino que usa el staff
      // al resolver una fila, para que no haya dos formas de promover lo resuelto.
      if (filasResueltas > 0) {
        await encolarPromocionDeLoResuelto(db, companyId, params.id);
      }

      return { filasResueltas, reglasGuardadas, conceptosRecibidos: respuestas.size };
    },
    {
      body: t.Object({
        respuestas: t.Array(
          t.Object({
            /** La clave normalizada que devolvió `GET /conceptos-pendientes`. */
            concepto: t.String({ minLength: 1 }),
            /** El texto crudo, como respaldo si el cliente manda el ejemplo en vez de la clave. */
            ejemplo: t.Optional(t.String()),
            type: t.Union([
              t.Literal('revenue'),
              t.Literal('cogs'),
              t.Literal('opex'),
              t.Literal('other'),
            ]),
            category: t.String({ minLength: 1, maxLength: 80 }),
          }),
          { minItems: 1, maxItems: 100 },
        ),
      }),
    },
  )
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * EL PORTÓN: QUÉ ENTENDIMOS DE TU ARCHIVO, ANTES DE PUBLICARLO (migración 0042, 2026-09-01)
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * Decisión de Keneth. Hasta hoy la carga se promovía sola; ahora el dueño ve PRIMERO el
   * resumen por hoja con el dinero que cada una aporta, y su contabilidad entra recién cuando
   * dice que está bien.
   *
   * ═══ POR QUÉ POR HOJA Y NO POR FILA ═══
   *
   * Porque los siete fallos de ingesta de esta semana NO fueron filas dudosas: fueron
   * decisiones sobre HOJAS, tomadas con alta confianza y equivocadas — una cartera de clientes
   * leída como ingresos (Q 13.362), un consolidado propio contado dos veces (+945), un
   * presupuesto entrando como dinero real, cobros devengando otra vez (+52 %). Ninguna la
   * habría atrapado una revisión fila por fila; todas se ven de un vistazo en una lista de
   * hojas con su monto al lado.
   *
   * Y se devuelven las DOS cosas en una sola respuesta —las hojas y los conceptos que solo el
   * dueño sabe— porque son una sola parada. Dos pantallas seguidas para la misma carga es la
   * forma más segura de que la segunda no se conteste.
   */
  .get('/:id/confirmacion', async ({ companyId, role, params, set, db }) => {
    assertClientCapability(role, 'upload_excel', set);

    const [doc] = await db
      .select({
        id: documents.id,
        status: documents.status,
        confirmedAt: documents.confirmedAt,
        readSummary: documents.readSummary,
        rowCount: documents.rowCount,
        flaggedCount: documents.flaggedCount,
      })
      .from(documents)
      .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));

    if (!doc) {
      set.status = 404;
      return { error: 'Document not found' };
    }

    /*
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * LA MUESTRA: TRES FILAS DE CADA HOJA, YA INTERPRETADAS (2026-09-01)
     * ═══════════════════════════════════════════════════════════════════════════════════════
     *
     * Sin esto, la pantalla le pide al cliente que apruebe un nombre de hoja y un total. Eso
     * alcanza para detectar una hoja de más o de menos —que es lo que atrapó los siete fallos
     * de esta semana— pero **no alcanza para el que queda**: leer la columna equivocada.
     *
     * Es el fallo que `sheet-header` documenta como el peor de su clase: "no falla nada
     * visible, los datos salen de las columnas equivocadas". El total puede verse perfecto y
     * cada fila estar mal. Lo único que lo delata es ver tres filas como quedaron y
     * reconocerlas —o no— contra el archivo que el dueño tiene abierto al lado.
     *
     * Tres y no diez: la pantalla es para decidir, no para auditar. Y se toman las PRIMERAS de
     * cada hoja, no una muestra al azar, porque el cliente puede compararlas con su archivo sin
     * buscarlas.
     */
    const muestras = await db
      .select({
        hoja: stagingRows.sheetName,
        payload: stagingRows.payload,
        entidad: stagingRows.targetEntity,
      })
      .from(stagingRows)
      .where(
        and(
          eq(stagingRows.companyId, companyId),
          eq(stagingRows.documentId, params.id),
          isNotNull(stagingRows.sheetName),
        ),
      )
      .orderBy(asc(stagingRows.id))
      .limit(400);

    const porHoja = new Map<string, { muestra: unknown[]; tipos: Record<string, number> }>();
    for (const m of muestras) {
      const clave = m.hoja!;
      const e = porHoja.get(clave) ?? { muestra: [], tipos: {} };
      const p = m.payload as Record<string, unknown>;
      // El TIPO con el que entró cada fila, contado por hoja: es lo que permite decir "esta
      // hoja entró como ingreso" y ofrecer cambiarla entera.
      const tipo = typeof p.type === 'string' ? p.type : m.entidad;
      e.tipos[tipo] = (e.tipos[tipo] ?? 0) + 1;
      if (e.muestra.length < 3) {
        e.muestra.push({
          fecha: (p.date ?? p.issueDate ?? null) as string | null,
          concepto: (p.description ?? p.product ?? p.counterparty ?? null) as string | null,
          monto: typeof p.originalAmount === 'number' ? p.originalAmount : null,
          moneda: typeof p.originalCurrency === 'string' ? p.originalCurrency : null,
          tipo,
          categoria: typeof p.category === 'string' ? p.category : null,
        });
      }
      porHoja.set(clave, e);
    }

    return {
      documentId: doc.id,
      status: doc.status,
      /** `null` = todavía no la confirmó. Es lo que decide si la pantalla es un portón. */
      confirmedAt: doc.confirmedAt?.toISOString() ?? null,
      filas: doc.rowCount ?? 0,
      marcadas: doc.flaggedCount ?? 0,
      /** Por hoja: qué tipos produjo y tres filas como quedaron. Ver el bloque de arriba. */
      detalle: Object.fromEntries(porHoja),
      /*
       * El MISMO resumen que ya se le muestra después de procesar (`read-summary`), no una
       * segunda lectura: si el portón dijera una cosa y el resumen otra sobre la misma carga,
       * el cliente dejaría de creerle a los dos. Ver `lib/read-summary.ts`.
       */
      hojas: doc.readSummary?.hojas ?? [],
    };
  })

  /**
   * "Todo correcto, publicar" — y opcionalmente "esta hoja no la cuentes".
   *
   * ⚠️ `confirmed_at` se escribe ANTES de encolar la promoción, no después: el portón lo
   * pregunta `promoteDocument`, así que encolar primero produce una promoción que se rechaza a
   * sí misma y el cliente aprieta publicar y no pasa nada. Es el mismo orden que ya cuesta caro
   * en este archivo cuando se invierte.
   *
   * Las hojas que el cliente EXCLUYE se rechazan fila por fila (`review_status: 'rejected'`),
   * que es el único estado que `promoteDocument` nunca promueve — y es el mismo camino que usa
   * staff, no uno paralelo. No se BORRAN: el rastro de qué decidió el dueño sobre su propio
   * archivo tiene que quedar.
   *
   * Lo que este endpoint NO hace es volver a incluir una hoja que se descartó. Eso exige
   * reprocesar el archivo con el modelo y es un trabajo distinto; hoy esa hoja se reporta y
   * queda visible en el resumen con su motivo, que es lo que permite que alguien la desmienta.
   */
  .post(
    '/:id/confirmar',
    async ({ companyId, userId, role, params, body, set, db }) => {
      assertClientCapability(role, 'upload_excel', set);

      const [doc] = await db
        .select({ id: documents.id, status: documents.status, confirmedAt: documents.confirmedAt })
        .from(documents)
        .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));

      if (!doc) {
        set.status = 404;
        return { error: 'Document not found' };
      }

      // Confirmar dos veces no es un error: el cliente puede haber apretado dos veces, o
      // vuelto por el enlace del correo. Es idempotente y se le dice que ya estaba.
      if (doc.confirmedAt !== null) {
        return { confirmado: true, yaEstaba: true, hojasExcluidas: 0, hojasReclasificadas: 0 };
      }

      /*
       * ⚠️ UNA CARGA DADA DE BAJA NO SE PUBLICA (2026-09-01).
       *
       * Este handler solo miraba `confirmed_at`, así que un documento `cancelled`, `reverted` o
       * `failed` se podía "publicar": se le escribía `confirmed_at`, se encolaba la promoción y
       * **volvían al dashboard filas que el cliente había dado de baja**. Sus `staging_rows`
       * siguen ahí —`cancelDocumentRows` marca el documento y da de baja el ledger, no toca
       * staging— así que había con qué reinsertar.
       *
       * Es EXACTAMENTE la lección que `encolarPromocionDeLoResuelto` ya tiene escrita —*"sin el
       * filtro, resolver una fila vieja de un documento `reverted` o `failed` lo resucitaría a
       * `promoted`, reinsertando en producción datos que alguien había dado de baja"*— aprendida
       * en un llamador y sin aplicar en el otro. El mismo patrón que este repo ya pagó con el
       * banner y el correo.
       *
       * Se volvió ALCANZABLE al permitir cancelar una carga en el portón: antes esa secuencia
       * —descartar y después publicar— no existía, así que el hueco estaba tapado por casualidad.
       */
      const PUBLICABLES = ['awaiting_confirmation', 'review', 'promoted'];
      if (!PUBLICABLES.includes(doc.status)) {
        set.status = 409;
        return {
          error: `Esta carga ya no se puede publicar (estado actual: ${doc.status}).`,
        };
      }

      /*
       * ═════════════════════════════════════════════════════════════════════════════════════
       * RECLASIFICAR UNA HOJA ENTERA (2026-09-01)
       * ═════════════════════════════════════════════════════════════════════════════════════
       *
       * Excluir una hoja resuelve "esto no debería contar". Lo que faltaba es "esto SÍ cuenta,
       * pero no es lo que ustedes creen" — y es un caso distinto y más común: el modelo
       * clasificó bien la FORMA de la hoja y mal su naturaleza.
       *
       * Va por HOJA y no fila por fila porque una hoja es homogénea por construcción: quien
       * escribe `Servicios_Varios` no mete ventas ahí. Preguntar concepto por concepto lo que
       * el dueño puede decir de un golpe convierte una decisión en un formulario — que es
       * exactamente lo que la pantalla de conceptos existe para evitar.
       *
       * ⚠️ NO toca las filas DERIVADAS. Ver `ES_DERIVADA`: el costo de una venta y el ingreso
       * devengado de una factura los crea una regla contable, no la naturaleza de la hoja.
       * Reclasificar `Ventas` como gasto no puede convertir su costo derivado en gasto también
       * — es el mismo fallo que se midió con el concepto "Aceite 1 L", a escala de hoja.
       *
       * Tampoco toca `invoice`/`bill`: la forma contable de una fila (factura, cuenta por
       * pagar) la determinó su estructura, y el cliente está diciendo qué ES, no dónde vive.
       */
      const reclasificar = body.reclasificar ?? [];
      let hojasReclasificadas = 0;
      for (const r of reclasificar) {
        const filas = await db
          .select({ id: stagingRows.id, payload: stagingRows.payload })
          .from(stagingRows)
          .where(
            and(
              eq(stagingRows.companyId, companyId),
              eq(stagingRows.documentId, params.id),
              eq(stagingRows.sheetName, r.hoja),
              eq(stagingRows.targetEntity, 'transaction'),
              isNull(stagingRows.promotedAt),
            ),
          );
        let tocadas = 0;
        for (const f of filas) {
          const p = f.payload as Record<string, unknown>;
          if (esFilaDerivada(p)) continue;
          await db
            .update(stagingRows)
            .set({
              payload: { ...p, type: r.type, ...(r.category ? { category: r.category } : {}) },
              // Lo dijo el dueño: la confianza sube y la marca se limpia, igual que al
              // contestar un concepto. Sin esto `staging-rules` la vuelve a marcar.
              confidence: '1.0000',
              flagReason: null,
              reviewStatus: 'approved',
              reviewedBy: userId,
              reviewedAt: new Date(),
            })
            .where(and(eq(stagingRows.id, f.id), eq(stagingRows.companyId, companyId)));
          tocadas++;
        }
        if (tocadas > 0) hojasReclasificadas++;
      }

      const excluidas = body.excluir ?? [];
      let hojasExcluidas = 0;
      for (const hoja of excluidas) {
        const r = await db
          .update(stagingRows)
          .set({ reviewStatus: 'rejected', reviewedBy: userId, reviewedAt: new Date() })
          .where(
            and(
              eq(stagingRows.companyId, companyId),
              eq(stagingRows.documentId, params.id),
              eq(stagingRows.sheetName, hoja),
              isNull(stagingRows.promotedAt),
            ),
          )
          .returning({ id: stagingRows.id });
        if (r.length > 0) hojasExcluidas++;
      }

      await db
        .update(documents)
        .set({ confirmedAt: new Date(), confirmedBy: userId })
        .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));

      // Y recién ahora se promueve. Ver la nota del orden arriba.
      await encolarPromocionDeLoResuelto(db, companyId, params.id);

      return { confirmado: true, yaEstaba: false, hojasExcluidas, hojasReclasificadas };
    },
    {
      body: t.Object({
        /** Nombres de hoja que el cliente dice que NO debe contarse. */
        excluir: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 200 }), { maxItems: 50 })),
        /** Hojas cuya naturaleza el cliente corrige. Ver el bloque de `reclasificar`. */
        reclasificar: t.Optional(
          t.Array(
            t.Object({
              hoja: t.String({ minLength: 1, maxLength: 200 }),
              type: t.Union([
                t.Literal('revenue'),
                t.Literal('cogs'),
                t.Literal('opex'),
                t.Literal('other'),
              ]),
              category: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
            }),
            { maxItems: 50 },
          ),
        ),
      }),
    },
  )
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * "ESTA HOJA SÍ DEBERÍA CONTAR" / "EL MONTO ESTÁ EN ESTA OTRA COLUMNA" (migración 0043)
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * Los dos casos que el portón mostraba sin darles salida, y son los caros:
   *
   *  · Una hoja descartada por error. **Perder una hoja en silencio es el fallo más caro que
   *    tiene esta ingesta** —el dashboard de KapePrueba en cero con la contabilidad bien
   *    leída— y hasta hoy el cliente lo VEÍA en la pantalla y no podía hacer nada.
   *  · Un dato leído de la columna equivocada. No falla nada visible: el total puede verse
   *    perfecto y cada fila estar mal. Ahora el panel expandido lo muestra, así que tiene que
   *    poder corregirse.
   *
   * Los dos se resuelven igual —reprocesar ESA hoja con la corrección— y por eso son un solo
   * endpoint. Se re-encola la ingesta completa y no una parcial: el worker ya es reanudable por
   * lote (`document_ingest_batches` tiene índice único), así que las hojas ya procesadas se
   * saltan solas y la corrida nueva solo paga el modelo de la hoja corregida.
   *
   * ⚠️ NO vuelve a cobrar crédito: el débito de la ingesta es UNA vez por CARGA
   * (`cargaYaDebitada`), no por corrida. Es la misma garantía que hace seguro el reintento.
   *
   * ⚠️ Y NO se puede sobre una carga ya confirmada: sus filas están en el ledger, y reprocesar
   * encima las duplicaría. Ahí el camino es revertir y volver a subir, que ya existe.
   */
  .post(
    '/:id/corregir-hoja',
    async ({ companyId, role, params, body, set, db }) => {
      assertClientCapability(role, 'upload_excel', set);

      const [doc] = await db
        .select({
          id: documents.id,
          status: documents.status,
          confirmedAt: documents.confirmedAt,
          overrides: documents.sheetOverrides,
        })
        .from(documents)
        .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));

      if (!doc) {
        set.status = 404;
        return { error: 'Document not found' };
      }
      if (doc.confirmedAt !== null) {
        // Ver la nota de arriba: encima de lo ya publicado, reprocesar duplica.
        set.status = 409;
        return { error: 'Esta carga ya se publicó. Revierte y vuelve a subirla para corregirla.' };
      }

      const previo = doc.overrides ?? {};
      const forzar = new Set(previo.forzar ?? []);
      if (body.forzar) forzar.add(body.hoja);
      const columnas = { ...(previo.columnas ?? {}) };
      if (body.columnas) {
        columnas[body.hoja] = { ...(columnas[body.hoja] ?? {}), ...body.columnas };
      }

      await db
        .update(documents)
        .set({
          sheetOverrides: { forzar: [...forzar], columnas },
          // Vuelve a procesarse: el estado lo fija el worker al terminar.
          status: 'processing',
        })
        .where(and(eq(documents.id, params.id), eq(documents.companyId, companyId)));

      /*
       * Las filas que esa hoja ya había producido se borran antes de reprocesar. Sin esto, una
       * corrección de columna DUPLICA la hoja: las filas viejas (leídas mal) siguen ahí y las
       * nuevas se suman. Solo las de ESA hoja y solo si no se promovieron — que no pueden
       * haberse promovido, porque la carga no está confirmada.
       */
      await db
        .delete(stagingRows)
        .where(
          and(
            eq(stagingRows.companyId, companyId),
            eq(stagingRows.documentId, params.id),
            eq(stagingRows.sheetName, body.hoja),
            isNull(stagingRows.promotedAt),
          ),
        );
      /*
       * Y sus LOTES confirmados, o el worker los saltaría por reanudación y la hoja quedaría
       * sin filas. Es la contraparte exacta del borrado de arriba: los dos existen para que la
       * hoja se lea de nuevo desde cero.
       */
      await db
        .delete(documentIngestBatches)
        .where(
          and(
            eq(documentIngestBatches.companyId, companyId),
            eq(documentIngestBatches.documentId, params.id),
            eq(documentIngestBatches.sheetName, body.hoja),
          ),
        );

      await enqueue(QUEUES.excelIngest, { documentId: params.id, companyId });
      return { reprocesando: true, hoja: body.hoja };
    },
    {
      body: t.Object({
        hoja: t.String({ minLength: 1, maxLength: 200 }),
        /** "Esta hoja SÍ debería contar": salta los filtros de descarte para ella. */
        forzar: t.Optional(t.Boolean()),
        /** "El monto está en esta otra columna": índice 0-based por campo. */
        columnas: t.Optional(t.Record(t.String(), t.Number())),
      }),
    },
  );
