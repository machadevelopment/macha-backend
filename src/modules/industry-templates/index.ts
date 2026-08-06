import { Elysia } from 'elysia';
import * as XLSX from 'xlsx';
import { eq } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { companies } from '@/db/schema';
import { resolveIndustryTemplate } from '@/lib/industry-template';

const COLUMNS = ['fecha', 'descripción', 'categoría', 'monto', 'moneda'];

/**
 * CU-868kfva7z (criterio 2): plantilla Excel descargable por industria, para que el
 * cliente sepa qué columnas llenar antes de subir su propio archivo. Distinta de
 * industry_templates/-_versions (esas son el diccionario de sinónimos + few-shot que
 * usa Claude para clasificar, no un archivo descargable) — aquí solo se REUSA la
 * industria de la empresa y las categorías canónicas de esa versión para dar
 * ejemplos de fila realistas; no hay tabla propia para "plantilla descargable".
 * Generado on-the-fly (xlsx ya es dependencia del worker de ingesta) en vez de un
 * asset estático en S3 — no hay contenido curado por industria todavía más allá de
 * las categorías ya seedeadas (scripts/seed.ts: solo "retail" por ahora).
 */
export const industryTemplateDownload = new Elysia({ prefix: '/industry-templates' })
  .use(tenantDerive)
  .get('/download', async ({ companyId, role, set, db }) => {
    assertClientCapability(role, 'upload_excel', set);

    const [company] = await db
      .select({ industry: companies.industry, baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company) {
      set.status = 404;
      return { error: 'Company not found' };
    }

    // Mismo resolver que usa la ingesta (lib/industry-template.ts). Antes esta ruta
    // tenía su propio fallback a tres categorías inventadas a mano, que no correspondían
    // a nada que el clasificador supiera mapear: el archivo de ejemplo enseñaba a llenar
    // categorías que el worker no reconocía. Ahora los ejemplos salen SIEMPRE del mismo
    // diccionario con el que se va a clasificar el archivo que el cliente devuelva.
    const template = await resolveIndustryTemplate(db, company.industry);
    const exampleCategories = Object.keys(template.synonyms).slice(0, 3);

    const rows = [
      COLUMNS,
      ...exampleCategories.map((category) => [
        '2026-01-15',
        `Ejemplo — ${category}`,
        category,
        '1000.00',
        company.baseCurrency,
      ]),
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Transacciones');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    set.headers['content-type'] =
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    set.headers['content-disposition'] =
      `attachment; filename="plantilla-${company.industry}.xlsx"`;
    return buffer;
  });
