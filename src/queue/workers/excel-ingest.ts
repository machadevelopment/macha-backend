import * as XLSX from 'xlsx';
import { eq } from 'drizzle-orm';
import { registerWorker, enqueue, QUEUES } from '@/queue';
import { withCompanyScope } from '@/lib/db-scope';
import { downloadObject } from '@/lib/s3';
import { documents, companies, industryTemplates, industryTemplateVersions } from '@/db/schema';
import { intakeConfig } from '@/config/intake';
import { INTAKE_MESSAGES } from '@/lib/intake-messages';
import { classifySheetRows } from '@/lib/anthropic';
import { insertStagingRows } from '@/lib/staging';
import { insertAiUsageEvent } from '@/lib/ai-usage';
import { promoteDocument } from '@/lib/promotion';
import { refreshExistingRollups } from '@/lib/rollups';
import { getActiveCreditRule, estimateRequiredCredits, debitCredits } from '@/lib/credits';

type ExcelIngestPayload = { documentId: string; companyId: string };

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0 || items.length <= size) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * CU-868kfva8v: worker de estandarización, mayor riesgo del MVP. Cada paso que toca
 * DB usa su propia transacción corta (withCompanyScope) — NO se envuelve todo el
 * worker en una sola transacción, porque el trabajo entre pasos incluye llamadas de
 * red lentas (descarga S3, Claude) que no deben mantener una conexión reservada del
 * pool abierta durante minutos bajo carga concurrente.
 *
 * Sin Excels de muestra reales de Macha (CU-868kfv9cb, en backlog) todavía — el
 * prompt/mapeo (ver lib/anthropic.ts) es un primer pase razonable sobre la taxonomía
 * fija del PRD, a recalibrar cuando lleguen muestras reales.
 */
export function startExcelIngestWorker(): Promise<string> {
  return registerWorker<ExcelIngestPayload>(
    QUEUES.excelIngest,
    async ({ documentId, companyId }) => {
      try {
        await withCompanyScope(companyId, (db) =>
          db.update(documents).set({ status: 'processing' }).where(eq(documents.id, documentId)),
        );

        const { templateVersion, s3Key, creditRule, locale } = await withCompanyScope(
          companyId,
          async (db) => {
            const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
            if (!doc) throw new Error(`document ${documentId} not found for company ${companyId}`);

            const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
            if (!company) throw new Error(`company ${companyId} not found`);

            const [template] = await db
              .select()
              .from(industryTemplates)
              .where(eq(industryTemplates.industry, company.industry));
            if (!template?.currentVersionId) {
              throw new Error(
                `No hay plantilla de industria configurada para "${company.industry}"`,
              );
            }

            const [templateVersion] = await db
              .select()
              .from(industryTemplateVersions)
              .where(eq(industryTemplateVersions.id, template.currentVersionId));
            if (!templateVersion) {
              throw new Error(`Versión de plantilla ${template.currentVersionId} no encontrada`);
            }

            // Frozen once per document (same pattern as fx_rate in promotion.ts) —
            // consistent even if the rule version changes mid-processing.
            const creditRule = await getActiveCreditRule(db, 'excel');

            return { templateVersion, s3Key: doc.s3Key, creditRule, locale: company.locale };
          },
        );

        const fileBuffer = await downloadObject(s3Key);
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });

        // CU-868kh8man: backstop de caps sobre el libro YA parseado. Necesario para
        // `.xls` (binario legacy, sin inspección barata posible en la recepción — ver
        // modules/ingestion/index.ts) y gratis como red de seguridad para el resto:
        // el conteo del intake sale del atributo `dimension` del XML (xlsx) o de un
        // escaneo de bytes (csv), ambos aproximaciones que un archivo raro podría
        // burlar. Va ANTES del bucle de hojas, así que un archivo fuera de norma no
        // gasta ni una llamada a Claude.
        const parsedSheetCount = workbook.SheetNames.length;
        if (parsedSheetCount > intakeConfig.maxSheetsPerWorkbook) {
          throw new Error(
            INTAKE_MESSAGES[locale].tooManySheets(
              intakeConfig.maxSheetsPerWorkbook,
              parsedSheetCount,
            ),
          );
        }
        const parsedRowTotal = workbook.SheetNames.reduce((total, name) => {
          const sheet = workbook.Sheets[name];
          if (!sheet) return total;
          const ref = sheet['!ref'];
          if (!ref) return total;
          const decoded = XLSX.utils.decode_range(ref);
          return total + (decoded.e.r - decoded.s.r + 1);
        }, 0);
        if (parsedRowTotal > intakeConfig.maxRowsPerFile) {
          throw new Error(
            INTAKE_MESSAGES[locale].tooManyRows(intakeConfig.maxRowsPerFile, parsedRowTotal),
          );
        }

        let totalRowsProcessed = 0;

        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          if (!sheet) continue;

          const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            blankrows: false,
          });
          if (rows.length === 0) continue;

          // Hojas grandes en lotes (CU-868kfv972, aprobado por Jose); hojas pequeñas
          // van en una sola llamada.
          const batchSize =
            rows.length > intakeConfig.largeSheetRowThreshold
              ? intakeConfig.batchSize
              : rows.length;

          for (const batch of chunk(rows, batchSize)) {
            const result = await classifySheetRows({ templateVersion, sheetName, rows: batch });

            await withCompanyScope(companyId, async (db) => {
              await insertAiUsageEvent(db, {
                companyId,
                kind: 'excel',
                refId: documentId,
                model: result.model,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                billableUnits: batch.length,
              });
              await insertStagingRows(db, companyId, documentId, result.rows);

              // Débito por lote (CU-868kfvaa6): la regla `excel` es variable, 1
              // crédito/lote (scripts/seed.ts). Sin regla activa = sin cap, per v1
              // (no bloquea ni descuenta) — mismo comportamiento que antes de F0.
              if (creditRule) {
                await debitCredits(db, {
                  companyId,
                  actionKind: 'excel',
                  credits: estimateRequiredCredits(creditRule, 1),
                  creditRuleId: creditRule.id,
                  refId: documentId,
                });
              }
            });

            totalRowsProcessed += batch.length;
          }
        }

        const promotedThisRun = await withCompanyScope(companyId, async (db) => {
          const promotion = await promoteDocument(db, companyId, documentId);
          if (!promotion.promoted) {
            // Filas pendientes/marcadas: queda para revisión interna (US-17). La
            // promoción atómica (CU-868kfva9z) se reintenta cuando staff las resuelva.
            await db
              .update(documents)
              .set({ status: 'review', rowCount: totalRowsProcessed })
              .where(eq(documents.id, documentId));
            return false;
          }
          // CU-868kfvab1: cache-aside — recomputa solo los rollups que la empresa ya
          // había visto antes; los nunca vistos se llenan perezosamente en /metrics.
          await refreshExistingRollups(db, companyId);
          return true;
        });

        if (promotedThisRun) {
          // CU-868kfvad3: evaluación de alertas tras cada Excel exitoso, desacoplada
          // vía la cola interna (no una llamada directa) — mismo patrón que el resto
          // de este worker.
          await enqueue(QUEUES.alertEvaluate, { companyId, documentId });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await withCompanyScope(companyId, (db) =>
          db
            .update(documents)
            .set({ status: 'failed', errorReason: message })
            .where(eq(documents.id, documentId)),
        ).catch(() => {
          // best-effort status update; never mask the original error below
        });
        throw err; // re-thrown so pg-boss applies the excel.ingest retry policy
      }
    },
  );
}
