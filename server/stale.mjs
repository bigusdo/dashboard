// Выгрузка открытых задач Pyrus для уборки: от самых давних к свежим, с причиной «почему на проверку».
// Только чтение. Результат: server/out/stale-tasks.csv (открывается в Excel). Запуск: node server/stale.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openTasks } from './pyrus.mjs';

const DAY = 86400000;
const days = iso => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : null;
const STALE_DAYS = Number(process.env.STALE_DAYS || 90);
const DONE = new Set(['Оплачено', 'Выполнено']);

const tasks = await openTasks();
const rows = tasks.map(t => {
  const idle = days(t.modified);
  const why = [];
  if (t.status.some(s => DONE.has(s))) why.push('статус «' + t.status.filter(s => DONE.has(s)).join('+') + '», а задача открыта');
  if (t.status.length > 1) why.push('несколько статусов сразу');
  if (!t.status.length) why.push('нет статуса');
  if (!t.kp) why.push('нет номера КП');
  if (idle >= STALE_DAYS) why.push(`без движения ${idle} дн.`);
  return { t, idle, why };
}).filter(r => r.why.length).sort((a, b) => b.idle - a.idle);

const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const head = ['Без движения, дн.', 'Создана, дн. назад', 'КП', 'Задача', 'Ответственный', 'Объект', 'Тип', 'Статус', 'Комментариев', 'Почему на проверку', 'Ссылка'];
const lines = [head.map(esc).join(';')];
for (const { t, idle, why } of rows) {
  lines.push([idle, days(t.created), t.kp || '', t.t, t.who, t.obj.join(' + '), t.type.join(' + '), t.status.join(' + '), t.comments, why.join('; '), t.url].map(esc).join(';'));
}
await mkdir(new URL('./out/', import.meta.url), { recursive: true });
const file = new URL('./out/stale-tasks.csv', import.meta.url);
await writeFile(file, '﻿' + lines.join('\r\n')); // BOM — чтобы Excel прочитал кириллицу

const n = f => rows.filter(f).length;
console.log(`открытых задач ${tasks.length}, на проверку ${rows.length}`);
console.log(`  без движения ≥ ${STALE_DAYS} дн.: ${n(r => r.idle >= STALE_DAYS)}`);
console.log(`  статус «Оплачено/Выполнено», но открыта: ${n(r => r.t.status.some(s => DONE.has(s)))}`);
console.log(`  несколько статусов: ${n(r => r.t.status.length > 1)} · нет статуса: ${n(r => !r.t.status.length)} · нет КП: ${n(r => !r.t.kp)}`);
console.log('файл:', fileURLToPath(file));
