import { Elysia } from 'elysia';
import * as XLSX from 'xlsx';
import { desc, eq } from 'drizzle-orm';
import { tenantDerive } from '@/guards/tenant.derive';
import { assertClientCapability } from '@/guards/require-capability';
import { companies, industryStarterTemplates } from '@/db/schema';
import { normalizeIndustry, resolveIndustryTemplate } from '@/lib/industry-template';
import { TARGET_INDUSTRIES } from '@/config/industries';
import { downloadObject } from '@/lib/s3';

const COLUMNS = ['fecha', 'descripción', 'categoría', 'monto', 'moneda'];

/**
 * El nombre del archivo, saneado para una cabecera `Content-Disposition`.
 *
 * El nombre lo escribió una persona en el panel admin, así que puede traer comillas, saltos de
 * línea o punto y coma — y en una cabecera HTTP eso no es un detalle estético: una comilla
 * cierra el valor antes de tiempo y lo que sigue se interpreta como otro parámetro de la
 * cabecera. Se conserva lo legible y se cae a un nombre fijo si no queda nada.
 */
function nombreSeguro(nombre: string): string {
  const limpio = nombre.replace(/[^\w\s.,()\u00C0-\u017F-]/g, '').trim();
  return limpio.length > 0 ? limpio.slice(0, 120) : 'plantilla.xlsx';
}

/**
 * CU-868kfva7z (criterio 2): plantilla Excel descargable por industria, para que el
 * cliente sepa qué columnas llenar antes de subir su propio archivo. Distinta de
 * industry_templates/-_versions (esas son el diccionario de sinónimos + few-shot que
 * usa Claude para clasificar, no un archivo descargable).
 *
 * ═══ AHORA HAY DOS FUENTES, Y EL ORDEN IMPORTA (Jose, 2026-08-20) ═══
 *
 * 1. Si staff subió una plantilla CURADA para esta industria
 *    (`industry_starter_templates`, migración 0035), se sirve ESA. Es contenido que una
 *    persona armó: hojas de verdad, ejemplos con sentido para una cafetería o una
 *    consultora. Nada de eso se puede generar.
 * 2. Si no, se genera al vuelo con las categorías canónicas del diccionario de la
 *    industria, que es lo que esta ruta hacía desde CU-868kfva7z.
 *
 * EL FALLBACK ES EL PUNTO, no un resto del diseño viejo. El criterio del ticket era "si una
 * industria no tiene plantilla cargada, el onboarding no rompe ni muestra un enlace roto", y
 * la forma de cumplirlo sin un condicional en el frontend es que la URL SIEMPRE devuelva un
 * archivo. El mismo botón, siempre, y lo que mejora es qué archivo llega.
 *
 * Y si la clave de S3 está en la base pero el objeto no se puede leer —borrado a mano, bucket
 * mal configurado— también se cae al generado en vez de responder 500. Un cliente en
 * onboarding que aprieta "descargar plantilla" y recibe un error no vuelve a intentarlo; que
 * reciba el archivo genérico es peor que el curado y muchísimo mejor que nada.
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

    /*
     * Primero la curada. `normalizeIndustry` es la MISMA que usa la subida del admin: sin
     * ella, "Retail" y "retail" serían dos industrias distintas y la empresa recibiría la
     * plantilla que le toque según cómo alguien escribió su rubro.
     */
    const industriaNormalizada = normalizeIndustry(company.industry);
    if (industriaNormalizada) {
      const [curada] = await db
        .select({
          s3Key: industryStarterTemplates.s3Key,
          originalFilename: industryStarterTemplates.originalFilename,
          contentType: industryStarterTemplates.contentType,
        })
        .from(industryStarterTemplates)
        .where(eq(industryStarterTemplates.industry, industriaNormalizada))
        .orderBy(desc(industryStarterTemplates.version))
        .limit(1);

      if (curada) {
        try {
          const bytes = await downloadObject(curada.s3Key);
          set.headers['content-type'] = curada.contentType;
          set.headers['content-disposition'] =
            `attachment; filename="${nombreSeguro(curada.originalFilename)}"`;
          return bytes;
        } catch (err) {
          /*
           * La fila existe y el objeto no se pudo leer. Se registra —es un problema real de
           * infraestructura y en silencio nadie lo arreglaría nunca— y se sigue al generado.
           *
           * Devolver 500 sería lo "correcto" en abstracto y lo peor para el cliente: está en
           * onboarding, apretó "descargar plantilla", y un error ahí es alguien que abandona.
           */
          console.error(
            `[industry-templates] no se pudo leer la plantilla curada ${curada.s3Key}, ` +
              `se cae a la generada:`,
            err,
          );
        }
      }
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
  })
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * LAS INDUSTRIAS QUE EL PRODUCTO RECONOCE (lista de Jose, 2026-08-25)
   * ═══════════════════════════════════════════════════════════════════════════════════════
   *
   * Sirve la lista para que la pantalla de registro ofrezca un desplegable en vez de un campo
   * de texto libre. Hasta hoy era texto libre y por eso `companies.industry` en producción
   * tiene valores escritos a mano que ninguna plantilla puede resolver.
   *
   * Devuelve SLUGS y no nombres: los rótulos visibles son copia de interfaz y viven en el
   * diccionario del frontend, en los dos idiomas. El backend es dueño de la llave que decide
   * qué plantilla se sirve, no de cómo se lee.
   *
   * Va detrás de `tenantDerive` porque el registro ya ocurre con sesión —quien lo llena es un
   * usuario autenticado que todavía no tiene empresa— y no expone nada sensible: es un catálogo
   * de plataforma, igual que `industry_starter_templates`.
   */
  .get('/industries', () => ({ industries: TARGET_INDUSTRIES }));
