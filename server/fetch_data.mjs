// Снимок данных отдела закупок (бот, только чтение): GET DASHBOARD_URL с заголовком X-Export-Key.
// Ключ и адрес — в .env рядом с дашбордом (DASHBOARD_EXPORT_TOKEN, DASHBOARD_URL). Ключ не печатается и не логируется.
// Результат — data/snapshot.json (пишется атомарно; при ошибке старый снимок остаётся). Не чаще раза в минуту.
// Запуск вручную: node server/fetch_data.mjs
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const DIR = new URL('data/', ROOT);
const SNAP = new URL('data/snapshot.json', ROOT);
const MIN_GAP_MS = 60_000;

// Минимальный разбор .env: KEY=value, комментарии #, значения в кавычках, BOM.
export async function readEnv() {
  let text = '';
  try { text = (await readFile(new URL('.env', ROOT), 'utf8')).replace(/^﻿/, ''); } catch { return {}; }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

export async function loadSnapshot() {
  try { return JSON.parse(await readFile(SNAP, 'utf8')); } catch { return null; }
}

let lastAttempt = 0;

// Возвращает { ok, snapshot?, error? }. Текст ошибки без ключа и без адреса с параметрами.
export async function fetchSnapshot() {
  const now = Date.now();
  if (now - lastAttempt < MIN_GAP_MS) return { ok: false, error: 'слишком часто: источник опрашивается не чаще раза в минуту', throttled: true };
  lastAttempt = now;
  const env = await readEnv();
  const key = env.DASHBOARD_EXPORT_TOKEN, url = env.DASHBOARD_URL;
  if (!key || !url) return { ok: false, error: 'не настроен: в .env нужны DASHBOARD_EXPORT_TOKEN и DASHBOARD_URL', notConfigured: true };
  if (!/^https:\/\//i.test(url)) return { ok: false, error: 'DASHBOARD_URL должен начинаться с https://' };
  try {
    const res = await fetch(url, { headers: { 'X-Export-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (res.status !== 200) {
      const why = { 404: 'неверный или отсутствующий ключ (или бот не обновлён)', 400: 'неверный лист или формат', 503: 'база бота недоступна, повторим позже' }[res.status];
      return { ok: false, error: `источник ответил ${res.status}${why ? ': ' + why : ''}` };
    }
    const snap = await res.json();
    if (!snap || typeof snap !== 'object' || !snap.sheets || !Array.isArray(snap.sheets.deals) || !Array.isArray(snap.sheets.invoices))
      return { ok: false, error: 'ответ источника не похож на выгрузку (нет sheets.deals / sheets.invoices)' };
    await mkdir(DIR, { recursive: true });
    const tmp = new URL('data/snapshot.json.tmp', ROOT);
    await writeFile(tmp, JSON.stringify(snap));
    await rename(tmp, SNAP);
    return { ok: true, snapshot: snap };
  } catch (e) {
    // e.message может содержать адрес, но не заголовки; ключ в сообщениях fetch не встречается
    return { ok: false, error: e.name === 'TimeoutError' ? 'источник не ответил за 30 с' : 'нет связи с источником: ' + (e.cause?.code || e.name) };
  }
}

if (process.argv[1]?.endsWith('fetch_data.mjs')) {
  const r = await fetchSnapshot();
  if (!r.ok) { console.error('Ошибка:', r.error); process.exit(1); }
  const s = r.snapshot.sheets;
  console.log(`ok: данные на ${r.snapshot.generated_at}; КП ${s.deals.length}, заявок ${s.requests?.length ?? 0}, счетов ${s.invoices.length}`);
}
