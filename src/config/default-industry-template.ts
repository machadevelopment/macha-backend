import type { industryTemplateVersions } from '@/db/schema';

export type IndustryTemplatePayload = Pick<
  typeof industryTemplateVersions.$inferSelect,
  'synonyms' | 'fewShot'
>;

/**
 * Diccionario de apoyo BASE, incorporado en el código — no en la base de datos.
 *
 * Regla de diseño (Keneth, 2026-08-06): **el motor de IA tiene que poder con cualquier
 * archivo**. Las plantillas por industria no son un requisito de entrada; son un aporte
 * de vocabulario que afina el nombrado cuando existe. Quien clasifica es el prompt junto
 * con la taxonomía fija (lib/anthropic.ts), que ya obliga a mapear cada fila aunque su
 * encabezado no figure en ningún diccionario.
 *
 * Qué arregla: hasta ahora una empresa cuya `industry` no tuviera fila en
 * `industry_templates` no podía ingerir NADA — el worker lanzaba "No hay plantilla de
 * industria configurada para X" y el documento moría en `failed` (visto en producción:
 * U3 TECH se auto-registró con industry "TECH" y el único template sembrado es "retail",
 * scripts/seed.ts). Un detalle interno de curaduría convertido en muro para el cliente.
 *
 * Por qué en código y no una fila sembrada: una fila exige que alguien corra un script
 * en cada ambiente, y el ambiente que se lo salte reconstruye el muro. Aquí el respaldo
 * existe desde que arranca el proceso, en todos lados, sin paso operativo. Nada persiste
 * el id de la versión usada —solo se consumen `synonyms` + `fewShot`, ver
 * lib/anthropic.ts— así que un diccionario sin fila en la base no rompe ninguna
 * referencia.
 *
 * No confundir con la "plantilla descargable" (modules/industry-templates/index.ts):
 * ese es el .xlsx de ejemplo para el cliente que no lleva un orden y quiere de dónde
 * partir. Este es vocabulario para el modelo.
 *
 * Cobertura: la taxonomía fija del PRD (revenue/cogs/opex/other) con términos ES/EN
 * transversales a cualquier giro, más las categorías de servicios/software que la
 * plantilla de retail no tiene. Sin Excels de muestra reales (CU-868kfv9cb, en backlog)
 * sigue siendo un primer pase razonable — mismo estatus que el template de retail.
 */
export const DEFAULT_INDUSTRY_TEMPLATE: IndustryTemplatePayload = {
  synonyms: {
    'revenue.sales': [
      'venta',
      'ventas',
      'ingresos',
      'ingresos por ventas',
      'facturación',
      'facturacion',
      'sales',
      'revenue',
      'income',
    ],
    'revenue.services': [
      'servicios',
      'ingresos por servicios',
      'honorarios',
      'consultoría',
      'consultoria',
      'proyectos',
      'service revenue',
      'consulting',
      'professional fees',
    ],
    'revenue.subscriptions': [
      'suscripción',
      'suscripcion',
      'suscripciones',
      'mensualidad',
      'mensualidades',
      'ingreso recurrente',
      'subscription',
      'recurring revenue',
      'mrr',
      'arr',
    ],
    'revenue.other_income': [
      'otros ingresos',
      'ingresos varios',
      'other income',
      'miscellaneous income',
    ],
    'cogs.merchandise': [
      'compra de mercadería',
      'compra de mercaderia',
      'costo de mercadería vendida',
      'costo de ventas',
      'compras',
      'inventario',
      'cost of goods sold',
      'cogs',
    ],
    'cogs.direct_labor': [
      'mano de obra directa',
      'personal de proyecto',
      'contratistas',
      'subcontratos',
      'freelance',
      'direct labor',
      'contractors',
    ],
    'cogs.hosting': [
      'hosting',
      'servidores',
      'nube',
      'infraestructura',
      'cloud',
      'aws',
      'infrastructure',
    ],
    'opex.payroll': [
      'planilla',
      'sueldos',
      'salarios',
      'nómina',
      'nomina',
      'prestaciones',
      'bonificaciones',
      'payroll',
      'salaries',
      'wages',
    ],
    'opex.rent': ['renta', 'alquiler', 'arrendamiento', 'rent', 'lease'],
    'opex.utilities': [
      'servicios básicos',
      'servicios basicos',
      'luz',
      'agua',
      'electricidad',
      'internet',
      'teléfono',
      'telefono',
      'utilities',
    ],
    'opex.marketing': ['publicidad', 'mercadeo', 'pauta', 'marketing', 'advertising', 'ads'],
    'opex.software': [
      'software',
      'licencias',
      'herramientas',
      'suscripciones de software',
      'saas',
      'subscriptions',
      'tools',
    ],
    'opex.professional_fees': [
      'honorarios profesionales',
      'contabilidad',
      'auditoría',
      'auditoria',
      'legal',
      'asesoría',
      'asesoria',
      'accounting',
      'legal fees',
    ],
    'opex.travel': [
      'viáticos',
      'viaticos',
      'viajes',
      'transporte',
      'combustible',
      'travel',
      'fuel',
    ],
    'opex.bank_fees': [
      'comisiones bancarias',
      'cargos bancarios',
      'intereses',
      'bank fees',
      'interest',
    ],
    'opex.taxes': ['impuestos', 'iva', 'isr', 'tax', 'taxes'],
    'other.misc': ['otros', 'varios', 'ajustes', 'misc', 'other', 'adjustments'],
  },
  fewShot: [
    {
      input: "Fecha=15/01/2026, Descripción='Factura servicios enero', Monto=25000.00, Moneda=GTQ",
      output: {
        targetEntity: 'transaction',
        confidence: 0.9,
        payload: {
          type: 'revenue',
          category: 'services',
          date: '2026-01-15',
          description: 'Factura servicios enero',
          originalAmount: 25000.0,
          originalCurrency: 'GTQ',
        },
      },
    },
    {
      input: "Fecha=31/01/2026, Descripción='Planilla enero', Monto=-18000.00, Moneda=GTQ",
      output: {
        targetEntity: 'transaction',
        confidence: 0.95,
        payload: {
          type: 'opex',
          category: 'payroll',
          date: '2026-01-31',
          description: 'Planilla enero',
          originalAmount: 18000.0,
          originalCurrency: 'GTQ',
        },
      },
    },
    {
      input: "Fecha=05/02/2026, Descripción='AWS - infraestructura', Monto=-420.75, Moneda=USD",
      output: {
        targetEntity: 'transaction',
        confidence: 0.9,
        payload: {
          type: 'cogs',
          category: 'hosting',
          date: '2026-02-05',
          description: 'AWS - infraestructura',
          originalAmount: 420.75,
          originalCurrency: 'USD',
        },
      },
    },
    {
      input:
        "Cliente='Distribuidora El Roble', Fecha emisión=05/01/2026, Vence=05/02/2026, Monto=3200.00 GTQ",
      output: {
        targetEntity: 'invoice',
        confidence: 0.85,
        payload: {
          counterparty: 'Distribuidora El Roble',
          issueDate: '2026-01-05',
          dueDate: '2026-02-05',
          originalAmount: 3200.0,
          originalCurrency: 'GTQ',
        },
      },
    },
  ],
};

/** Nombre para trazas/logs cuando se usa el fallback en vez de un template de la base. */
export const DEFAULT_INDUSTRY_TEMPLATE_NAME = 'Genérica (integrada)';
