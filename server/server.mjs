// Локальный сервер дашборда: отдаёт страницу из ../public и данные 1С на /api/data.
// Данные собираются в фоне (около 2 минут) и кэшируются; страница получает последний готовый снимок.
// Запуск: node server.mjs
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { collect } from './collect.mjs';
import { fetchSnapshot, loadSnapshot } from './fetch_data.mjs';
import { mergeKp } from './kp_merge.mjs';
import { openTasks, postComment, closeTask, meta, createTask, changeLists, renameTask, setDue } from './pyrus.mjs';

const PORT = Number(process.env.PORT || 3000);
const REFRESH_MS = Number(process.env.REFRESH_MIN || 30) * 60_000;
const CACHE = new URL('./out/data.json', import.meta.url);
const PUBLIC = new URL('../public/', import.meta.url);

let data = null, lastError = null, refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    data = await collect();
    lastError = null;
    await mkdir(new URL('./out/', import.meta.url), { recursive: true });
    await writeFile(CACHE, JSON.stringify(data));
    console.log(new Date().toLocaleTimeString('ru-RU'), 'данные 1С обновлены');
  } catch (e) {
    lastError = e.message.split('\n')[0];
    console.error(new Date().toLocaleTimeString('ru-RU'), 'ошибка обновления:', lastError);
  } finally { refreshing = false; }
}

// Задачи Pyrus обновляются отдельно и чаще: они собираются быстро и не ждут медленную 1С.
const TASKS_MS = Number(process.env.PYRUS_REFRESH_MIN || 3) * 60_000;
let metaCache = null; // люди и списки для формы новой задачи
setInterval(() => { metaCache = null; }, 30 * 60_000);
let tasks = null, tasksError = null, tasksAt = null, tasksBusy = false;

async function refreshTasks() {
  if (tasksBusy) return;
  tasksBusy = true;
  try {
    tasks = await openTasks();
    tasksAt = new Date().toISOString();
    tasksError = null;
  } catch (e) {
    tasksError = e.message.split('\n')[0];
    console.error(new Date().toLocaleTimeString('ru-RU'), 'ошибка Pyrus:', tasksError);
    setTimeout(refreshTasks, 30_000); // сбой сети не должен держать страницу без задач до следующего планового обновления
  } finally { tasksBusy = false; }
}

// Отдел закупок (бот): снимок data/snapshot.json, не чаще раза в минуту (по умолчанию раз в 10 минут).
const BOT_MS = Math.max(1, Number(process.env.BOT_REFRESH_MIN || 10)) * 60_000;
let snapshot = await loadSnapshot(), botError = null;
async function refreshBot() {
  const r = await fetchSnapshot();
  if (r.ok) { snapshot = r.snapshot; botError = null; console.log(new Date().toLocaleTimeString('ru-RU'), 'данные отдела закупок обновлены'); }
  else if (!r.throttled) { botError = r.error; console.error(new Date().toLocaleTimeString('ru-RU'), 'отдел закупок:', r.error); }
}
refreshBot();
setInterval(refreshBot, BOT_MS);

try { data = JSON.parse(await readFile(CACHE, 'utf8')); } catch {}
refresh();
setInterval(refresh, REFRESH_MS);
refreshTasks();
setInterval(refreshTasks, TASKS_MS);

const MAX_BODY = 30 * 1024 * 1024; // файлы приходят в base64
const readBody = req => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new Error('Слишком большой файл (до ~20 МБ суммарно)')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  // CORS нужен, чтобы страница, открытая как файл, могла читать данные; сервер слушает только 127.0.0.1
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/api/data') {
    if (data) return send(res, 200, data);
    return send(res, lastError ? 502 : 503, { error: lastError || 'Данные 1С ещё загружаются, обновите страницу через минуту' });
  }
  if (path === '/api/kp') {
    if (!data) return send(res, lastError ? 502 : 503, { error: lastError || 'Данные 1С ещё загружаются, обновите страницу через минуту' });
    return send(res, 200, { updated: data.updated, today: data.today, botError, ...mergeKp(data.kp, snapshot) });
  }
  if (path === '/api/meta') {
    try { metaCache ||= await meta(); return send(res, 200, metaCache); }
    catch (e) { return send(res, 502, { error: e.message.split('\n')[0] }); }
  }
  if (path === '/api/tasks' && req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) return send(res, 403, { error: 'Запрос не со страницы дашборда' });
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Нужен JSON' });
    try {
      const b = JSON.parse(await readBody(req));
      const subject = String(b.subject || '').trim().slice(0, 300);
      if (!subject) return send(res, 400, { error: 'Нужен заголовок задачи' });
      const due = /^\d{4}-\d{2}-\d{2}$/.test(b.due) ? b.due : null;
      const responsible = Number(b.responsible) || null;
      const list_ids = (Array.isArray(b.list_ids) ? b.list_ids : []).map(Number).filter(Boolean);
      const known = new Set((metaCache ||= await meta()).lists.map(l => l.id));
      if (list_ids.some(i => !known.has(i))) return send(res, 400, { error: 'Неизвестный список' });
      const files = (Array.isArray(b.files) ? b.files : []).slice(0, 10).map(f => ({
        name: String(f.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120), data: Buffer.from(String(f.data || ''), 'base64'),
      })).filter(f => f.data.length);
      const id = await createTask({ subject, text: String(b.text || '').trim(), responsible, due, list_ids, files });
      console.log(new Date().toLocaleTimeString('ru-RU'), 'создана задача', id, files.length ? `+ файлов: ${files.length}` : '');
      refreshTasks();
      return send(res, 200, { ok: true, id, url: 'https://pyrus.com/t#id' + id });
    } catch (e) { return send(res, 502, { error: e.message.split('\n')[0] }); }
  }
  const ml = path.match(/^\/api\/tasks\/(\d+)\/lists$/);
  if (ml && req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) return send(res, 403, { error: 'Запрос не со страницы дашборда' });
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Нужен JSON' });
    const id = Number(ml[1]);
    if (!tasks?.some(t => t.id === id)) return send(res, 404, { error: 'Задача не найдена среди открытых' });
    try {
      const b = JSON.parse(await readBody(req));
      const known = new Set((metaCache ||= await meta()).lists.map(l => l.id));
      const ids = a => (Array.isArray(a) ? a : []).map(Number).filter(i => known.has(i));
      const add = ids(b.add), remove = ids(b.remove);
      if (!add.length && !remove.length) return send(res, 400, { error: 'Нечего менять' });
      await changeLists(id, add, remove);
      console.log(new Date().toLocaleTimeString('ru-RU'), 'списки задачи', id, '+', add.join(','), '−', remove.join(','));
      await refreshTasks();
      return send(res, 200, { ok: true });
    } catch (e) { return send(res, 502, { error: e.message.split('\n')[0] }); }
  }
  const md = path.match(/^\/api\/tasks\/(\d+)\/due$/);
  if (md && req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) return send(res, 403, { error: 'Запрос не со страницы дашборда' });
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Нужен JSON' });
    const id = Number(md[1]);
    if (!tasks?.some(t => t.id === id)) return send(res, 404, { error: 'Задача не найдена среди открытых' });
    try {
      const due = String(JSON.parse(await readBody(req)).due || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || isNaN(new Date(due))) return send(res, 400, { error: 'Нужна дата YYYY-MM-DD' });
      await setDue(id, due);
      console.log(new Date().toLocaleTimeString('ru-RU'), 'срок задачи', id, due);
      await refreshTasks();
      return send(res, 200, { ok: true });
    } catch (e) { return send(res, 502, { error: e.message.split('\n')[0] }); }
  }
  const ms = path.match(/^\/api\/tasks\/(\d+)\/subject$/);
  if (ms && req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) return send(res, 403, { error: 'Запрос не со страницы дашборда' });
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Нужен JSON' });
    const id = Number(ms[1]);
    if (!tasks?.some(t => t.id === id)) return send(res, 404, { error: 'Задача не найдена среди открытых' });
    try {
      const subject = String(JSON.parse(await readBody(req)).subject || '').trim().slice(0, 300);
      if (!subject) return send(res, 400, { error: 'Пустой заголовок' });
      await renameTask(id, subject);
      console.log(new Date().toLocaleTimeString('ru-RU'), 'переименована задача', id);
      await refreshTasks();
      return send(res, 200, { ok: true });
    } catch (e) { return send(res, 502, { error: e.message.split('\n')[0] }); }
  }
  const mc = path.match(/^\/api\/tasks\/(\d+)\/close$/);
  if (mc && req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) return send(res, 403, { error: 'Запрос не со страницы дашборда' });
    const id = Number(mc[1]);
    if (!tasks?.some(t => t.id === id)) return send(res, 404, { error: 'Задача не найдена среди открытых' });
    try {
      let note = '';
      try { note = String(JSON.parse(await readBody(req)).text || '').trim().slice(0, 2000); } catch {}
      await closeTask(id, '[из дашборда] ' + (note || 'Закрыто при уборке задач'));
      console.log(new Date().toLocaleTimeString('ru-RU'), 'задача закрыта', id);
      tasks = tasks.filter(t => t.id !== id); // сразу убираем из кэша, пока не пришло плановое обновление
      refreshTasks();
      return send(res, 200, { ok: true });
    } catch (e) { return send(res, 502, { error: e.message.split('\n')[0] }); }
  }
  const m = path.match(/^\/api\/tasks\/(\d+)\/comment$/);
  if (m && req.method === 'POST') {
    // Запись в Pyrus: только со страницы самого дашборда (защита от чужих сайтов, открытых в браузере)
    const origin = req.headers.origin;
    if (origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) return send(res, 403, { error: 'Запрос не со страницы дашборда' });
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Нужен JSON' });
    const id = Number(m[1]);
    if (!tasks?.some(t => t.id === id)) return send(res, 404, { error: 'Задача не найдена среди открытых' });
    try {
      const b = JSON.parse(await readBody(req));
      const text = String(b.text || '').trim();
      const files = (Array.isArray(b.files) ? b.files : []).slice(0, 10).map(f => ({
        name: String(f.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120), data: Buffer.from(String(f.data || ''), 'base64'),
      })).filter(f => f.data.length);
      if (!text && !files.length) return send(res, 400, { error: 'Пустой ответ' });
      // Автор комментария в Pyrus — бот, поэтому помечаем, что ответ отправлен из дашборда
      await postComment(id, '[из дашборда] ' + (text || 'файл'), files);
      console.log(new Date().toLocaleTimeString('ru-RU'), 'ответ в задачу', id, files.length ? `+ файлов: ${files.length}` : '');
      refreshTasks();
      return send(res, 200, { ok: true });
    } catch (e) { return send(res, 502, { error: e.message.split('\n')[0] }); }
  }
  if (path === '/api/tasks') {
    if (tasks) return send(res, 200, { updated: tasksAt, tasks, error: tasksError });
    return send(res, tasksError ? 502 : 503, { error: tasksError || 'Задачи Pyrus ещё загружаются' });
  }
  if (path === '/kp' || path === '/kp.html') return send(res, 200, await readFile(new URL('kp.html', PUBLIC)), 'text/html; charset=utf-8');
  if (path === '/revenue' || path === '/revenue.html') return send(res, 200, await readFile(new URL('revenue.html', PUBLIC)), 'text/html; charset=utf-8');
  if (path === '/' || path === '/index.html') return send(res, 200, await readFile(new URL('index.html', PUBLIC)), 'text/html; charset=utf-8');
  send(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`Дашборд: http://localhost:${PORT}`));
