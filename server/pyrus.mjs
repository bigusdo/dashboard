// Клиент Pyrus API (только чтение): открытые задачи из списков организации.
// Логин и ключ бота MainBot берутся из переменных окружения PYRUS_LOGIN / PYRUS_KEY (см. docs/pyrus.md).
import { userVar } from './onec.mjs';

const AUTH = 'https://accounts.pyrus.com/api/v4/auth';
const ME_ID = Number(process.env.PYRUS_ME || 364657); // чьи задачи — «Мне» (Битус Д.)
const STATUS_LISTS = new Set(['Делаем КП', 'КП на согласовании', 'КП согласовано. Заключаем договор!', 'В работе', 'Ждем денег!', 'Оплачено', 'Выполнено', 'На паузе до срока!!!']);
const TYPE_LISTS = new Set(['Слаботочка', 'СВиК', 'СМР']);
const HIDDEN_LISTS = new Set(['ОП']); // внутренние задачи отдела продаж — на дашборд не выводим

let session = null;

async function login() {
  const login = userVar('PYRUS_LOGIN'), key = userVar('PYRUS_KEY');
  if (!login || !key) throw new Error('Не заданы PYRUS_LOGIN / PYRUS_KEY (переменные окружения Windows)');
  const r = await fetch(AUTH, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, security_key: key }), signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Pyrus: ' + (j.error || 'ошибка авторизации'));
  session = { token: j.access_token, api: j.api_url };
}

// opts: { json } — тело JSON (POST), { form } — multipart (загрузка файла)
async function api(path, opts = {}, retry = true) {
  if (!session) await login();
  const headers = { Authorization: 'Bearer ' + session.token };
  const init = { headers, signal: AbortSignal.timeout(120000) };
  if (opts.json) { init.method = 'POST'; headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
  if (opts.form) { init.method = 'POST'; init.body = opts.form; }
  const r = await fetch(session.api + path, init);
  if (r.status === 401 && retry) { session = null; return api(path, opts, false); }
  if (!r.ok) throw new Error(`Pyrus ${r.status}: ${path.split('?')[0]}`);
  return r.json();
}

// выполняет fn над элементами по несколько штук одновременно
async function pool(items, size, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// Ответ на задачу от имени бота: файлы сначала грузятся в Pyrus, затем прикладываются к комментарию.
// files: [{ name, data: Buffer }]. Возвращает id созданного комментария.
export async function postComment(taskId, text, files = []) {
  const attachments = [];
  for (const f of files) {
    const form = new FormData();
    form.append('file', new Blob([f.data]), f.name);
    const up = await api('files/upload', { form });
    if (!up.guid) throw new Error('Pyrus не принял файл ' + f.name);
    attachments.push({ guid: up.guid });
  }
  const body = { text };
  if (attachments.length) body.attachments = attachments;
  const r = await api(`tasks/${taskId}/comments`, { json: body });
  return r.task?.comments?.at(-1)?.id ?? null;
}

// Справочники для формы новой задачи: люди и списки (метки). Список «ОП» скрыт, как и на дашборде.
export async function meta() {
  const [m, l] = await Promise.all([api('members'), api('lists')]);
  const members = (m.members || []).filter(p => !p.banned && !p.removed_from_org)
    .map(p => ({ id: p.id, name: [p.last_name, p.first_name].filter(Boolean).join(' ') || p.email || String(p.id), bot: p.type === 'bot' }))
    .sort((a, b) => a.bot - b.bot || a.name.localeCompare(b.name, 'ru'));
  const kind = n => STATUS_LISTS.has(n) ? 'status' : TYPE_LISTS.has(n) ? 'type' : 'obj';
  const lists = (l.lists || []).filter(x => !HIDDEN_LISTS.has(x.name)).map(x => ({ id: x.id, name: x.name, kind: kind(x.name) }));
  return { members, lists };
}

// Новая задача. { subject, text, responsible (id), due (YYYY-MM-DD), list_ids, files:[{name,data}] } → id задачи.
export async function createTask({ subject, text, responsible, due, list_ids = [], files = [] }) {
  const attachments = [];
  for (const f of files) {
    const form = new FormData();
    form.append('file', new Blob([f.data]), f.name);
    const up = await api('files/upload', { form });
    if (!up.guid) throw new Error('Pyrus не принял файл ' + f.name);
    attachments.push({ guid: up.guid });
  }
  const body = { subject, text: text || subject };
  if (responsible) body.responsible = { id: responsible };
  if (due) body.due_date = due;
  if (list_ids.length) body.list_ids = list_ids;
  if (attachments.length) body.attachments = attachments;
  const r = await api('tasks', { json: body });
  return r.task.id;
}

// Закрытие задачи (комментарий с действием «finished»); необратимо только в смысле уведомлений — в Pyrus задачу можно открыть заново.
export const closeTask = (taskId, text) => api(`tasks/${taskId}/comments`, { json: { text, action: 'finished' } });

// Только для проверки: личная задача бота (её никто, кроме бота, не видит).
export const _test = {
  create: text => api('tasks', { json: { text, subject: text } }).then(r => r.task.id),
  close: id => api(`tasks/${id}/comments`, { json: { action: 'finished' } }),
  get: id => api('tasks/' + id).then(r => r.task),
};

const KP_RE = /КП\s*№?\s*(\d{2,5})/i;
const short = p => p ? [p.last_name, p.first_name && p.first_name[0] + '.'].filter(Boolean).join(' ') || p.first_name || '—' : 'Не назначен';

export async function openTasks() {
  const lists = (await api('lists')).lists || [];
  const names = Object.fromEntries(lists.map(l => [l.id, l.name]));
  const ids = new Set();
  for (const l of lists) {
    if (HIDDEN_LISTS.has(l.name)) continue;
    const d = await api(`lists/${l.id}/tasks?item_count=200&include_archived=n`);
    for (const t of d.tasks || []) ids.add(t.id);
  }
  const tasks = (await pool([...ids], 6, id => api('tasks/' + id).then(d => d.task))).filter(t => t && !t.is_closed);
  const res = [];
  for (const t of tasks) {
    const listNames = (t.list_ids || []).map(i => names[i]).filter(Boolean);
    if (listNames.some(n => HIDDEN_LISTS.has(n))) continue;
    const subject = (t.subject || t.text || '').trim();
    let m = subject.match(KP_RE);
    if (!m) m = [t.text, ...(t.comments || []).map(c => c.text)].join('\n').match(KP_RE);
    res.push({
      id: t.id, t: subject, kp: m ? m[1] : null,
      who: short(t.responsible), me: t.responsible?.id === ME_ID,
      status: listNames.filter(n => STATUS_LISTS.has(n)),
      type: listNames.filter(n => TYPE_LISTS.has(n)),
      obj: listNames.filter(n => !STATUS_LISTS.has(n) && !TYPE_LISTS.has(n)),
      due: t.due_date || null, created: t.create_date, modified: t.last_modified_date,
      comments: (t.comments || []).length, url: 'https://pyrus.com/t#id' + t.id,
    });
  }
  return res;
}

if (process.argv[1]?.endsWith('pyrus.mjs')) {
  const t = await openTasks();
  console.log('открытых задач', t.length, '· без номера КП', t.filter(x => !x.kp).length, '· без срока', t.filter(x => !x.due).length);
  for (const x of t.slice(0, 5)) console.log(x.id, x.kp || '—', x.who, x.status.join('+') || '—', x.obj.join('+'), x.type.join('+'), x.t.slice(0, 50));
}
