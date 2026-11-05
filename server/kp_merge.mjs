// Сведение КП из 1С (деньги: заказ, акты, оплаты, документы закупок) со снимком отдела закупок (заявки, счета, этапы).
// Материалы по открытым заявкам в рублях бот не отдаёт, поэтому счета бота сопоставляются с документами закупки 1С
// по входящему номеру и поставщику: из бота — этап счёта, из 1С — сумма и оплата.

const STALE_DAYS = 7;          // счёт на согласовании дольше — «завис» (в выгрузке есть только дата создания счёта)
const ROUNDS_WARN = 4;         // раундов согласования времени доставки

export const kpDigits = v => (String(v ?? '').match(/\d+/) || [''])[0].replace(/^0+(?=\d)/, '');

const normNum = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9а-яё]/g, '');
const digitsOnly = v => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
const normName = v => String(v ?? '').toLowerCase().replace(/ё/g, 'е')
  .replace(/\b(ооо|зао|пао|оао|ао|ип|тд|торговый дом|фирма|компания)\b/g, ' ').replace(/[^a-zа-я0-9]/g, '');

function sameNumber(a, b) {
  const x = normNum(a), y = normNum(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const dx = digitsOnly(a), dy = digitsOnly(b);
  return dx.length >= 3 && dx === dy;
}
function sameSupplier(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return null;                 // не с чем сравнивать
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
}

// Счёт бота → документ закупки 1С той же КП. Каждый документ 1С используется один раз.
function matchInvoices(invoices, docs) {
  const used = new Set();
  return invoices.map(inv => {
    if (!inv.invoice_number) return { inv, doc: null, why: 'в боте нет номера счёта' };
    let found = null, byNumberOnly = false;
    for (let i = 0; i < docs.length; i++) {
      if (used.has(i) || !sameNumber(inv.invoice_number, docs[i].num)) continue;
      const s = sameSupplier(inv.supplier_name, docs[i].supplier);
      if (s === false) continue;
      found = i; byNumberOnly = s === null; if (s) break;
    }
    if (found == null) return { inv, doc: null, why: 'ещё не в 1С' };
    used.add(found);
    return { inv, doc: docs[found], byNumberOnly };
  });
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
    const matched = matchInvoices(live, k.docs || []);
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
        requests_open: rq.filter(r => r.status !== 'закрыта').length, requests_closed: rq.filter(r => r.status === 'закрыта').length,
        invoices_total: live.length, invoices_cancelled: all.length - live.length, stages, problems,
        invoices: matched.map(({ inv, doc, why, byNumberOnly }) => ({
          request_number: inv.request_number, seq_number: inv.seq_number, status: inv.status,
          supplier: inv.supplier_name, number: inv.invoice_number,
          delivery_date: inv.delivery_date, delivered_at: inv.delivered_at, accepted: inv.acceptance_decision,
          onec: doc ? { sum: doc.sum, paid: doc.paid, date: doc.date, byNumberOnly: !!byNumberOnly } : null, why: why || null,
        })),
        in_onec_sum: matchedDocs.reduce((a, d) => a + d.sum, 0), in_onec_paid: matchedDocs.reduce((a, d) => a + d.paid, 0),
        not_in_onec: matched.filter(m => !m.doc).length,
      },
    };
  });
  const orphans = [...deals].filter(([k, d]) => !seen.has(k) && d.status === 'открыта').map(([, d]) => ({ kp_number: d.kp_number, customer_object: d.customer_object }));
  return { rows, botOnly: orphans, generated_at: snapshot?.generated_at ?? null };
}
