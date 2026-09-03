import { analizarEsquema } from './src/lib/sheet-relations';
const CLIENTES = Array.from({ length: 10 }, (_, i) => `CU-${String(i + 1).padStart(3, '0')}`);
const MONTOS = [
  440, 130, 950, 585, 1850, 275, 690, 1120, 340, 2100, 505, 780, 1340, 615, 225, 1990, 460, 875,
  1210, 395, 730, 1560, 285, 640,
];
const ventas = [
  ['Order #', 'Order Date', 'Cust. ID', 'Customer Name', 'Total'],
  ...MONTOS.map((m, i) => [`SO-${2001 + i}`, 46027 + i, CLIENTES[i % 10], `Cliente ${i % 10}`, m]),
];
const cartera = [
  ['Invoice #', 'Cust. ID', 'Invoice Date', 'Due Date', 'Invoice Amount'],
  ...MONTOS.slice(0, 18).map((m, i) => [
    `INV-${6001 + i}`,
    CLIENTES[i % 10],
    46027 + i,
    46057 + i,
    m,
  ]),
];
const e = analizarEsquema([
  { nombre: 'Sales Orders', rows: ventas },
  { nombre: 'Accounts Receivable', rows: cartera },
]);
console.log('referencias:');
for (const r of e.referencias)
  console.log(
    `  ${r.desde}[col ${r.desdeColumna}] → ${r.hacia}[col ${r.haciaColumna}]  cob=${r.cobertura.toFixed(2)} vals=${r.valores}`,
  );
console.log('entidades:', [...e.entidades]);
console.log('referencian:', [...e.referencian]);
