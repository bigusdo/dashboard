// Сведение КП из 1С (деньги: заказ, акты, оплаты, документы закупок) со снимком отдела закупок (заявки, счета, этапы).
// Материалы по открытым заявкам в рублях бот не отдаёт, поэтому счета бота сопоставляются с заказами поставщику 1С
// (в них номер счёта поставщика и его сумма) по номеру счёта и поставщику; оплаты и приёмка — по объекту расчётов заказа.

const STALE_DAYS = 7;          // счёт на согласовании дольше — «завис» (в выгрузке есть только дата создания счёта)
const ROUNDS_WARN = 4;         // раундов согласования времени доставки

// затраты на материалы = материалы + доставка (одна сумма); null, если в боте нет ни того ни другого
const addNullable = (a, b) => (a == null && b == null ? null : (a || 0) + (b || 0));

export const kpDigits = v => (String(v ?? '').match(/\d+/) || [''])[0].replace(/^0+(?=\d)/, '');

const normNum = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9а-яё]/g, '');
const digitsOnly = v => String(v ?? '').replace(/D/g, '').replace(/^0+/, '');
const STOP = new Set(['ооо', 'зао', 'пао', 'оао', 'ао', 'ип', 'тд', 'стд', 'пк', 'торговый', 'дом', 'фирма', 'компания', 'группа', 'спб', 'дерево']);
const tokens = v => String(v ?? '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter(t => t.length >= 3 && !STOP.has(t));

function sameNumber(a, b) {
  const x = normNum(a), y = normNum(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const dx = digitsOnly(a), dy = digitsOnly(b);
  return dx.length >= 4 && dx === dy;
}
// true — поставщики совпали; false — названы по-разному; null — у одного из них названия нет
function sameSupplier(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.length || !y.length) return null;
  return x.some(t => y.some(u => t === u || (Math.min(t.length, u.length) >= 5 && (t.includes(u) || u.includes(t)))));
}

// Счёт бота → заказ поставщику 1С (счёт) той же КП. Каждый заказ используется один раз.
// Сначала номер + поставщик; потом длинный номер (от 5 знаков) при другом названии поставщика (ЭТМ и «Электротехмонтаж»).
function matchInvoices(invoices, orders) {
  const used = new Set(), out = new Map();
  const attempt = (strict) => {
    for (const inv of invoices) {
      if (out.has(inv) || !inv.invoice_number) continue;
      for (let i = 0; i < orders.length; i++) {
        if (used.has(i) || !sameNumber(inv.invoice_number, orders[i].num)) continue;
        const s = sameSupplier(inv.supplier_name, orders[i].supplier);
        if (strict ? s !== true : (s === true || normNum(orders[i].num).length < 5)) continue;
        used.add(i); out.set(inv, { doc: orders[i], byNumberOnly: !strict });
        break;
      }
    }
  };
  attempt(true); attempt(false);
  const unpaired = orders.filter((_, i) => !used.has(i));
  return {
    unpaired,
    list: invoices.map(inv => {
      const m = out.get(inv);
      if (m) return { inv, ...m };
      return { inv, doc: null, why: inv.invoice_number ? 'ещё не в 1С' : 'в боте нет номера счёта' };
    }),
  };
}

const daysSince = (iso, now) => iso ? Math.floor((now - new Date(iso)) / 864e5) : null;

// kp1c — массив КП из collect.mjs; snapshot — выгрузка бота (или null).
export function mergeKp(kp1c, snapshot, now = new Date()) {
  const sheets = snapshot?.sheets || {};
  const deals = new Map((sheets.deals || []).map(d => [kpDigits(d.kp_number), d]));
  const reqs = new Map(), invs = new Map();
  const push = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);
  for (const r of sheets.requests || []) push(reqs, kpDigits(r.kp_number), r);
  for (const i of sheets.invoices || []) push(invs, kpDigits(i.kp_number), i);

  const seen = new Set();
  const rows = kp1c.map(k => {
    const key = kpDigits(k.id); seen.add(key);
    const deal = deals.get(key) || null;
    const rq = (reqs.get(key) || []).filter(r => r.status !== 'отменена');
    const all = (invs.get(key) || []).slice().sort((a, b) => (a.request_number - b.request_number) || (a.seq_number - b.seq_number));
    const live = all.filter(i => i.status !== 'отменена');
    const { list: matched, unpaired } = matchInvoices(live, k.orders || []);
    const matchedDocs = matched.filter(m => m.doc).map(m => m.doc);
    const stages = {};
    for (const i of live) stages[i.status] = (stages[i.status] || 0) + 1;
    const problems = live.map(i => {
      const p = [];
      if (i.escalated_to_deal_owner) p.push('доставку не удалось согласовать, передано владельцу КП');
      if ((i.delivery_rounds || 0) >= ROUNDS_WARN) p.push(`раундов согласования доставки: ${i.delivery_rounds}`);
      const age = daysSince(i.created_at, now);
      if (i.status === 'на_согласовании' && age != null && age > STALE_DAYS) p.push(`на согласовании ${age} дн.`);
      return p.length ? { request_number: i.request_number, seq_number: i.seq_number, supplier_name: i.supplier_name, text: p.join('; ') } : null;
    }).filter(Boolean);
    return {
      ...k,
      bot: {
        found: !!deal,
        status: deal?.status ?? null,
        plan_materials: deal?.plan_materials ?? null, plan_delivery: deal?.plan_delivery ?? null,
        fact_materials: deal?.fact_materials ?? null, fact_delivery: deal?.fact_delivery ?? null,
        plan_total: addNullable(deal?.plan_materials, deal?.plan_delivery), fact_total: addNullable(deal?.fact_materials, deal?.fact_delivery),
        requests_open: rq.filter(r => r.status !== 'закрыта').length, requests_closed: rq.filter(r => r.status === 'закрыта').length,
        invoices_total: live.length, invoices_cancelled: all.length - live.length, stages, problems,
        invoices: matched.map(({ inv, doc, why, byNumberOnly }) => ({
          request_number: inv.request_number, seq_number: inv.seq_number, status: inv.status,
          supplier: inv.supplier_name, number: inv.invoice_number,
          delivery_date: inv.delivery_date, delivered_at: inv.delivered_at, accepted: inv.acceptance_decision,
          onec: doc ? { sum: doc.sum, paid: doc.paid, received: doc.received, status: doc.status, date: doc.date, byNumberOnly: !!byNumberOnly } : null, why: why || null,
        })),
        in_onec_sum: matchedDocs.reduce((a, d) => a + d.sum, 0), in_onec_paid: matchedDocs.reduce((a, d) => a + d.paid, 0), in_onec_received: matchedDocs.reduce((a, d) => a + d.received, 0),
        onec_unpaired: unpaired.length, onec_unpaired_sum: unpaired.reduce((a, d) => a + d.sum, 0),
        not_in_onec: matched.filter(m => !m.doc).length,
      },
    };
  });
  const orphans = [...deals].filter(([k, d]) => !seen.has(k) && d.status === 'открыта').map(([, d]) => ({ kp_number: d.kp_number, customer_object: d.customer_object }));
  return { rows, botOnly: orphans, generated_at: snapshot?.generated_at ?? null };
}
