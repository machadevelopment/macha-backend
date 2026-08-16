import { and, desc, eq } from 'drizzle-orm';
import type { DB } from '@/db/client';
import { companyColumnProfiles } from '@/db/schema';
import type { ColumnMap } from './row-assembly';
import { encabezadosNormalizados, hashDeEncabezados } from './header-hash';

/**
 * Lectura y escritura del perfil de mapeo por empresa (CU-868krmrcj, migración `0027`).
 *
 * ═══ QUÉ ES Y QUÉ NO ES ═══
 *
 * Es la respuesta a "para ESTA empresa y ESTA estructura de hoja, ¿qué columna era cuál?".
 * No reemplaza a la plantilla de industria: es la capa que sabe lo que esta empresa concreta
 * ya demostró que trae, y que la plantilla —que es por industria— no puede saber.
 *
 * ═══ EL VALOR REAL NO ES EL COSTO ═══
 *
 * El ticket lo vendía como ahorro de tokens. Es cierto pero es poco: desde
 * CU-COSTO-IA-20260812 el modelo devuelve el mapa UNA vez por hoja, no por fila, así que ya
 * es una fracción chica del recibo, y saltárselo no elimina la llamada —el modelo sigue
 * teniendo que clasificar cada fila—, solo acorta su salida.
 *
 * Lo que sí vale, y mucho, es la CONSISTENCIA. Hoy cada carga vuelve a inferir el mapa desde
 * cero, así que nada garantiza que el archivo de esta semana se lea igual que el de la
 * pasada. `assertMismoMapa` protege dentro de una carga —compara los lotes entre sí— pero no
 * ENTRE cargas: dos subidas del mismo Excel pueden entrar con mapas distintos y las dos
 * parecen correctas. El perfil es lo que hace que la respuesta sea la misma cada vez.
 */

export type OrigenDePerfil = 'inferido' | 'confirmado_por_cliente' | 'corregido_por_staff';

export interface PerfilDeColumnas {
  id: string;
  headerHash: string;
  headers: string[];
  columnMap: ColumnMap;
  source: OrigenDePerfil;
  version: number;
}

/**
 * El perfil VIGENTE de una empresa para una estructura de hoja, o `null` si nunca se guardó
 * uno.
 *
 * "Vigente" = la versión más alta. No se filtra por `source`: si un operador corrigió el mapa
 * y después una carga infirió otro, gana el último en el tiempo. La alternativa —que una
 * corrección humana sea permanente— sonaría más segura y no lo es: dejaría a la empresa
 * clavada a un mapa viejo cuando de verdad cambie su exportador, sin ninguna forma de
 * enterarse salvo que alguien note las cifras raras.
 */
export async function perfilVigente(
  db: DB,
  companyId: string,
  headerRow: readonly unknown[],
): Promise<PerfilDeColumnas | null> {
  const headerHash = hashDeEncabezados(headerRow);

  const [fila] = await db
    .select({
      id: companyColumnProfiles.id,
      headerHash: companyColumnProfiles.headerHash,
      headers: companyColumnProfiles.headers,
      columnMap: companyColumnProfiles.columnMap,
      source: companyColumnProfiles.source,
      version: companyColumnProfiles.version,
    })
    .from(companyColumnProfiles)
    .where(
      and(
        eq(companyColumnProfiles.companyId, companyId),
        eq(companyColumnProfiles.headerHash, headerHash),
      ),
    )
    .orderBy(desc(companyColumnProfiles.version))
    .limit(1);

  if (!fila) return null;

  return {
    id: fila.id,
    headerHash: fila.headerHash,
    headers: fila.headers as string[],
    columnMap: fila.columnMap as ColumnMap,
    source: fila.source as OrigenDePerfil,
    version: fila.version,
  };
}

/**
 * Guarda una versión nueva del perfil. Devuelve la versión escrita.
 *
 * ═══ NO ESCRIBE SI NO CAMBIÓ NADA ═══
 *
 * Sin este corte, cada carga de un cliente semanal agregaría una versión idéntica a la
 * anterior y la tabla crecería sin parar diciendo siempre lo mismo. Peor: la pregunta que
 * esta tabla existe para contestar —"¿cuándo cambió el mapa de esta empresa?"— quedaría
 * enterrada bajo cientos de filas que no son cambios. El historial vale por ser corto.
 *
 * La comparación es sobre el mapa serializado y el origen. Un `source` distinto SÍ escribe
 * aunque el mapa sea igual: que un humano confirme lo que el modelo ya había inferido es un
 * hecho que vale la pena registrar.
 *
 * ═══ LA CARRERA ═══
 *
 * `max(version) + 1` calculado acá puede colisionar con otra carga simultánea de la misma
 * empresa. Quien arbitra es el UNIQUE `(company_id, header_hash, version)` de la migración, no
 * este código: la segunda inserción falla con violación de unicidad. **El llamador debe
 * tratar ese fallo como benigno** — significa que otra carga acaba de guardar el mismo perfil,
 * que es exactamente el resultado que se quería. Ver cómo lo maneja el worker.
 */
export async function guardarPerfil(
  db: DB,
  params: {
    companyId: string;
    headerRow: readonly unknown[];
    sheetName: string | null;
    columnMap: ColumnMap;
    source: OrigenDePerfil;
    createdBy?: string | null;
  },
): Promise<{ version: number; escrito: boolean }> {
  const headerHash = hashDeEncabezados(params.headerRow);
  const headers = encabezadosNormalizados(params.headerRow);

  const actual = await perfilVigente(db, params.companyId, params.headerRow);

  if (
    actual &&
    actual.source === params.source &&
    JSON.stringify(actual.columnMap) === JSON.stringify(params.columnMap)
  ) {
    return { version: actual.version, escrito: false };
  }

  const version = (actual?.version ?? 0) + 1;

  await db.insert(companyColumnProfiles).values({
    companyId: params.companyId,
    headerHash,
    headers,
    sheetName: params.sheetName,
    columnMap: params.columnMap,
    source: params.source,
    version,
    createdBy: params.createdBy ?? null,
  });

  return { version, escrito: true };
}

/**
 * En qué se diferencian dos mapas de columnas. `[]` = son iguales.
 *
 * Alimenta la ADVERTENCIA al cliente (decisión de Keneth, 2026-08-16: advertencia con
 * confirmación, nunca bloqueo duro). Para poder decirle "esto no se parece a lo que sueles
 * subir" hace falta poder nombrar QUÉ cambió — un aviso genérico no le sirve a nadie y lo
 * único que enseña es a hacer clic en "continuar" sin leer.
 *
 * Se comparan los campos canónicos, no los índices crudos: al cliente le importa "ya no
 * encuentro la columna de fecha", no "el índice 4 pasó a ser 7".
 */
export function diferenciasDeMapa(
  anterior: ColumnMap,
  nuevo: ColumnMap,
): Array<{ campo: keyof ColumnMap; antes: number | null; ahora: number | null }> {
  const campos = Object.keys(anterior) as Array<keyof ColumnMap>;
  return campos
    .filter((campo) => anterior[campo] !== nuevo[campo])
    .map((campo) => ({ campo, antes: anterior[campo], ahora: nuevo[campo] }));
}

/**
 * ¿La diferencia es lo bastante grave como para advertirle al cliente?
 *
 * NO toda diferencia lo es, y ese es el punto. Que el archivo de esta semana traiga una
 * columna de producto que la pasada no tenía es una mejora, no un problema: se gana un dato.
 * Advertir por eso entrenaría a ignorar el aviso, que es la forma más rápida de que el aviso
 * deje de servir el día que sí importe.
 *
 * Se avisa cuando se PIERDE un campo que antes estaba, o cuando uno que estaba **se mueve de
 * columna**. Lo primero significa que algo dejó de leerse; lo segundo es el caso peligroso de
 * verdad, porque el dato sigue entrando —desde la columna equivocada— y nada falla.
 */
export function ameritaAdvertencia(diferencias: ReturnType<typeof diferenciasDeMapa>): boolean {
  return diferencias.some((d) => d.antes !== null);
}
