// Сбор данных для дашборда из 1С (только чтение). Результат — объект, который отдаёт сервер.
import { readFile } from 'node:fs/promises';
import { get, enc } from './onec.mjs';

const iso = d => d.toISOString().slice(0, 10);
const dt = (d, end) => `datetime'${iso(d)}T${end ? '23:59:59' : '00:00:00'}'`;
const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0));
const num = v => Math.round(v * 100) / 100;

async function accounts() {
  const r = await get('ChartOfAccounts_Хозрасчетный?$select=Ref_Key,Code');
  return Object.fromEntries(r.value.map(a => [a.Ref_Key, a.Code]));
}

// Выручка по месяцам: Кт − Дт по 90.01 за месяц (без НДС).
// Проводки закрытия месяца (корреспонденция с 90.* и 99) не считаем: в закрытых месяцах они обнуляют счёт.
async function revenueByMonth(acc, year, today) {
  const rev = [];
  for (let m = 0; m <= today.getUTCMonth(); m++) {
    const start = new Date(Date.UTC(year, m, 1));
    const end = m === today.getUTCMonth() ? today : lastDay(year, m);
    const t = await get(`AccountingRegister_Хозрасчетный/Turnovers(StartPeriod=${dt(start)},EndPeriod=${dt(end, true)})`);
    let s = 0;
    for (const x of t.value) {
      if (!acc[x.Account_Key]?.startsWith('90.01')) continue;
      const corr = acc[x.BalancedAccount_Key] || '';
      if (corr.startsWith('90.') || corr.startsWith('99')) continue;
      s += x['СуммаTurnoverCr'] - x['СуммаTurnoverDr'];
    }
    rev.push(num(s));
  }
  return rev;
}

// Поступления от клиентов по месяцам (безнал + касса), с НДС
async function receiptsByMonth(year, today) {
  const sums = Array(today.getUTCMonth() + 1).fill(0);
  for (const doc of ['Document_ПоступлениеБезналичныхДенежныхСредств', 'Document_ПриходныйКассовыйОрдер']) {
    const f = `Posted eq true and ХозяйственнаяОперация eq 'ПоступлениеОплатыОтКлиента' and Date ge ${dt(new Date(Date.UTC(year, 0, 1)))}`;
    const r = await get(enc(doc) + `?$select=Date,СуммаДокумента&$filter=` + enc(f));
    for (const x of r.value) sums[new Date(x.Date).getUTCMonth()] += x['СуммаДокумента'];
  }
  return sums.map(num);
}

async function counterparties() {
  const r = await get('Catalog_Контрагенты?$select=Ref_Key,Description');
  return new Map(r.value.map(c => [c.Ref_Key, c.Description]));
}

// Долги на дату по контрагентам: 62 (Дт − Кт) → нам должны; 60 (Кт − Дт) → мы должны
async function debts(acc, names, today) {
  const b = await get(`AccountingRegister_Хозрасчетный/Balance(Period=${dt(today, true)})`);
  const ar = new Map(), ap = new Map();
  for (const x of b.value) {
    const code = acc[x.Account_Key];
    if (!code) continue;
    const key = x.ExtDimension1;
    if (code.startsWith('62')) ar.set(key, (ar.get(key) || 0) + x['СуммаBalanceDr'] - x['СуммаBalanceCr']);
    else if (code.startsWith('60')) ap.set(key, (ap.get(key) || 0) + x['СуммаBalanceCr'] - x['СуммаBalanceDr']);
  }
  const list = m => [...m].filter(([, v]) => v > 0.5).map(([k, v]) => ({ name: names.get(k) || '—', sum: num(v) })).sort((a, b) => b.sum - a.sum);
  return { ar: list(ar), ap: list(ap) };
}

async function contracts(names) {
  const f = `DeletionMark eq false and ТипДоговора eq 'СПокупателем' and Статус eq 'Действует'`;
  const r = await get('Catalog_ДоговорыКонтрагентов?$select=Description,Номер,Дата,ДатаОкончанияДействия,Сумма,Контрагент_Key&$filter=' + enc(f));
  return r.value.map(c => ({
    n: c['Номер'], date: c['Дата'].slice(0, 10),
    end: c['ДатаОкончанияДействия'].startsWith('0001') ? null : c['ДатаОкончанияДействия'].slice(0, 10),
    sum: c['Сумма'], client: names.get(c['Контрагент_Key']) || '—',
  }));
}

// Затраты по сделкам из закупок поставщиков (с НДС): mat — привезено материалов (строки-товары),
// sub — оплачено подрядчикам (строки-услуги, номенклатура «Услуги субподрядчиков»).
// Оплаты поставщикам привязываются к закупке через объект расчётов; если он общий у нескольких закупок,
// оплата делится пропорционально суммам и не превышает их.
// matBy / subBy — те же суммы в разрезе контрагентов: кому сколько заплатили и от кого сколько получили.
async function dealCosts(names) {
  const nom = await get('Catalog_Номенклатура?$select=Ref_Key,ТипНоменклатуры');
  const isGoods = new Map(nom.value.map(n => [n.Ref_Key, n['ТипНоменклатуры'] === 'Товар']));
  const ZERO = '00000000-0000-0000-0000-000000000000';
  const purchases = await get('Document_ПриобретениеТоваровУслуг?$select=Ref_Key,Сделка_Key,Контрагент_Key,Товары&$filter=' + enc('Posted eq true'));

  const paid = new Map();
  for (const doc of ['Document_СписаниеБезналичныхДенежныхСредств', 'Document_РасходныйКассовыйОрдер']) {
    const r = await get(enc(doc) + '?$select=РасшифровкаПлатежа&$filter=' + enc(`Posted eq true and ХозяйственнаяОперация eq 'ОплатаПоставщику'`));
    for (const d of r.value) for (const row of d['РасшифровкаПлатежа'] || [])
      paid.set(row.ОбъектРасчетов_Key, (paid.get(row.ОбъектРасчетов_Key) || 0) + row['Сумма']);
  }

  const objTotal = new Map(), subLines = new Map(), res = new Map();
  const add = (m, key, v) => m.set(key, (m.get(key) || 0) + v);
  for (const doc of purchases.value) {
    if (!doc.Сделка_Key || doc.Сделка_Key === ZERO) continue;
    const c = res.get(doc.Сделка_Key) || { mat: 0, sub: 0, matBy: new Map(), subBy: new Map() };
    res.set(doc.Сделка_Key, c);
    const cp = names.get(doc.Контрагент_Key) || '—';
    for (const l of doc['Товары'] || []) {
      const v = l['СуммаСНДС'];
      add(objTotal, l.ОбъектРасчетов_Key, v);
      if (isGoods.get(l.Номенклатура_Key)) { c.mat += v; add(c.matBy, cp, v); }
      else add(subLines, doc.Сделка_Key + '|' + l.ОбъектРасчетов_Key + '|' + cp, v);
    }
  }
  for (const [k, v] of subLines) {
    const [deal, obj, cp] = k.split('|');
    const total = objTotal.get(obj) || 1;
    const p = v * Math.min(paid.get(obj) || 0, total) / total;
    const c = res.get(deal);
    c.sub += p;
    add(c.subBy, cp, p);
  }
  return res;
}

const byList = m => [...(m || [])].filter(([, v]) => v > 0.5).map(([name, v]) => ({ name, sum: num(v) })).sort((a, b) => b.sum - a.sum);

// КП в работе. КП — это «Сделка» в заказе клиента, название сделки вида «КП №1090 - Объект».
// В работе: по проведённым заказам сделки проведённых актов и реализаций меньше суммы заказов
// и оплат (по объектам расчётов заказов) тоже меньше суммы заказов. Все суммы с НДС.
async function kpInWork(names) {
  const [deals, orders, acts, sales] = await Promise.all([
    get('Catalog_СделкиСКлиентами?$select=Ref_Key,Description,DeletionMark'),
    get('Document_ЗаказКлиента?$select=Ref_Key,Date,Posted,DeletionMark,Сделка_Key,ОбъектРасчетов_Key,Контрагент_Key,СуммаДокумента'),
    get('Document_АктВыполненныхРабот?$select=Date,Posted,ЗаказКлиента,СуммаДокумента'),
    get('Document_РеализацияТоваровУслуг?$select=Date,Posted,ЗаказКлиента,СуммаДокумента'),
  ]);
  const done = new Map(), lastDoc = new Map();
  for (const x of [...acts.value, ...sales.value]) if (x.Posted) {
    done.set(x.ЗаказКлиента, (done.get(x.ЗаказКлиента) || 0) + x['СуммаДокумента']);
    if (x.Date > (lastDoc.get(x.ЗаказКлиента) || '')) lastDoc.set(x.ЗаказКлиента, x.Date);
  }

  const paidByObj = new Map();
  for (const doc of ['Document_ПоступлениеБезналичныхДенежныхСредств', 'Document_ПриходныйКассовыйОрдер']) {
    const r = await get(enc(doc) + `?$select=РасшифровкаПлатежа&$filter=` + enc(`Posted eq true and ХозяйственнаяОперация eq 'ПоступлениеОплатыОтКлиента'`));
    for (const d of r.value) for (const row of d['РасшифровкаПлатежа'] || [])
      paidByObj.set(row.ОбъектРасчетов_Key, (paidByObj.get(row.ОбъектРасчетов_Key) || 0) + row['Сумма']);
  }

  const costs = await dealCosts(names);

  const live = orders.value.filter(o => o.Posted && !o.DeletionMark);
  // объект расчётов может быть общим у нескольких заказов: делим его оплаты пропорционально суммам заказов
  const objTotal = new Map();
  for (const o of live) objTotal.set(o.ОбъектРасчетов_Key, (objTotal.get(o.ОбъектРасчетов_Key) || 0) + o['СуммаДокумента']);

  const byDeal = new Map();
  for (const o of live) {
    const p = byDeal.get(o.Сделка_Key) || { sum: 0, done: 0, paid: 0, date: o.Date, last: o.Date, top: 0, client: o.Контрагент_Key };
    p.sum += o['СуммаДокумента'];
    p.done += done.get(o.Ref_Key) || 0;
    p.paid += (paidByObj.get(o.ОбъектРасчетов_Key) || 0) * o['СуммаДокумента'] / (objTotal.get(o.ОбъектРасчетов_Key) || 1);
    if (o.Date < p.date) p.date = o.Date;
    for (const d of [o.Date, lastDoc.get(o.Ref_Key) || '']) if (d > p.last) p.last = d;
    if (o['СуммаДокумента'] > p.top) { p.top = o['СуммаДокумента']; p.client = o.Контрагент_Key; }
    byDeal.set(o.Сделка_Key, p);
  }

  // КП без движения (заказов, актов, реализаций) больше года считаем закрытыми: в 1С заказы статусом не закрываются
  const staleBefore = iso(new Date(Date.now() - 365 * 864e5));
  const closed = new Set(JSON.parse(await readFile(new URL('./closed-kp.json', import.meta.url), 'utf8').catch(() => '{}')).closed || []);
  const res = [];
  for (const d of deals.value) {
    const p = byDeal.get(d.Ref_Key);
    if (!p || d.DeletionMark || !/КП/.test(d.Description) || /удалить/i.test(d.Description)) continue;
    if (!(p.done < p.sum - 1 && p.paid < p.sum - 1) || p.last < staleBefore) continue;
    const m = d.Description.match(/КП\s*№?\s*(\S+)/);
    const id = m ? m[1].replace(/[,;]$/, '') : d.Description;
    if (closed.has(id)) continue;
    res.push({
      id,
      obj: (d.Description.match(/\s-\s+(.*)$/) || [, d.Description])[1].trim(),
      client: names.get(p.client) || '—', date: p.date.slice(0, 10), last: p.last.slice(0, 10),
      sum: num(p.sum), done: num(p.done), paid: num(Math.min(p.paid, p.sum)),
      sub: num(costs.get(d.Ref_Key)?.sub || 0), mat: num(costs.get(d.Ref_Key)?.mat || 0),
      subBy: byList(costs.get(d.Ref_Key)?.subBy), matBy: byList(costs.get(d.Ref_Key)?.matBy),
    });
  }
  return res.sort((a, b) => b.sum - a.sum);
}

export async function collect(now = new Date()) {
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const year = today.getUTCFullYear();
  const [acc, names] = await Promise.all([accounts(), counterparties()]);
  const [revenue, receipts, d, ctr, kp, revPrev] = await Promise.all([
    revenueByMonth(acc, year, today), receiptsByMonth(year, today), debts(acc, names, today), contracts(names), kpInWork(names),
    revenueByMonth(acc, year - 1, new Date(Date.UTC(year - 1, 11, 31))),
  ]);
  return { updated: new Date().toISOString(), today: iso(today), year, revenue, receipts, revenuePrev: revPrev, ...d, contracts: ctr, kp };
}

if (process.argv[1]?.endsWith('collect.mjs')) {
  const t0 = Date.now();
  const data = await collect();
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  writeFileSync(new URL('./out/data.json', import.meta.url), JSON.stringify(data, null, 1));
  console.log(`ok за ${((Date.now() - t0) / 1000).toFixed(0)} с`);
  console.log('выручка по месяцам', data.revenue);
  console.log('поступления', data.receipts);
  console.log('нам должны', data.ar.length, 'контрагентов, всего', data.ar.reduce((a, x) => a + x.sum, 0));
  console.log('мы должны', data.ap.length, 'контрагентов, всего', data.ap.reduce((a, x) => a + x.sum, 0));
  console.log('действующих договоров', data.contracts.length);
  console.log('КП в работе', data.kp.length, 'на сумму', data.kp.reduce((a, x) => a + x.sum, 0));
}
