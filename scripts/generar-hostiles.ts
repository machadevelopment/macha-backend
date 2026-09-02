/**
 * Escribe a disco los libros hostiles para subirlos por la aplicación de verdad.
 *
 * Los mismos diez que corre `src/lib/hostiles-e2e.test.ts` contra el pipeline. El test mide la
 * cifra del dashboard contra la verdad de campo; estos archivos sirven para lo que el test no
 * puede: el camino completo por la UI, con el modelo de verdad, la cola y el ledger.
 *
 *   bun run hostiles:generar [directorio]
 */
import * as XLSX from 'xlsx';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIBROS, libroInventarioAislado } from '../src/lib/hostiles/libros';
import { libroElInfierno } from '../src/lib/hostiles/libro-el-infierno';
import { libroElAbismo } from '../src/lib/hostiles/libro-el-abismo';
import { aWorkbook } from '../src/lib/hostiles/pipeline-doble';

const destino = process.argv[2] ?? './exceles-hostiles';
mkdirSync(destino, { recursive: true });

const fmt = (n: number) => n.toLocaleString('es-GT', { minimumFractionDigits: 2 });
const lineas: string[] = [
  '# Libros hostiles',
  '',
  'Generados por `bun run hostiles:generar`. Cada uno trae la VERDAD DE CAMPO de su',
  'contabilidad: es lo que el dashboard tiene que mostrar después de subirlo.',
  '',
];

for (const fabricar of [...LIBROS, libroInventarioAislado, libroElInfierno, libroElAbismo]) {
  const libro = fabricar();
  const buf = XLSX.write(aWorkbook(libro), { type: 'buffer', bookType: 'xlsx' });
  writeFileSync(join(destino, libro.archivo), buf);
  console.log(`✓ ${libro.archivo}  (${libro.hojas.length} hojas)`);
  lineas.push(
    `## ${libro.archivo}`,
    '',
    `**${libro.titulo}**`,
    '',
    libro.rompe,
    '',
    '| Cifra | Valor esperado |',
    '| --- | --- |',
    `| Ingresos | ${fmt(libro.verdad.revenue)} |`,
    `| Costo de ventas | ${fmt(libro.verdad.cogs)} |`,
    `| Gastos operativos | ${fmt(libro.verdad.opex)} |`,
    `| Filas a revisión | ${libro.marcadas ?? 0} |`,
    '',
  );
}

writeFileSync(join(destino, 'VERDAD.md'), lineas.join('\n'));
console.log(`\n${destino}/VERDAD.md — qué tiene que mostrar el dashboard de cada uno`);
