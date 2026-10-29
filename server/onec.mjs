// Клиент OData 1С:Fresh (только чтение). Логин и пароль берутся из переменных окружения ONEC_USER / ONEC_PASS.
import { execFileSync } from 'node:child_process';

export const BASE = process.env.ONEC_URL || 'https://1cfresh.com/a/ca/1779469/odata/standard.odata/';

// На Windows берём актуальные значения из переменных пользователя (реестр): процесс мог запуститься до их обновления.
function userVar(name) {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8' });
      const m = out.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*?)\\r?\\n`));
      if (m) return m[1];
    } catch {}
  }
  return process.env[name];
}

export async function get(path, { timeout = 300000 } = {}) {
  const u = userVar('ONEC_USER'), p = userVar('ONEC_PASS');
  if (!u || !p) throw new Error('Не заданы ONEC_USER / ONEC_PASS (переменные окружения Windows)');
  const url = BASE + path + (path.includes('$format') ? '' : (path.includes('?') ? '&' : '?') + '$format=json');
  const res = await fetch(url, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64'), Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}\n${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export const enc = encodeURIComponent;
