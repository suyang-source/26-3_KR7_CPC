// Vercel Serverless Function
// GET /api/refresh
// 구글시트를 서버에서 읽어오기 때문에 브라우저 CORS 제약이 없습니다.
// 전제조건: 시트가 "링크가 있는 모든 사용자 - 뷰어"로 공유되어 있어야 해요.

const SHEET_ID = '12of_jOnboNT38jzIgD66bJboEfejaXf2CBnHHLvrItE';
const SHEET_TAB_NAME = 'Sheet 1 (2)';

function csvUrl() {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB_NAME)}`;
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else { field += c; }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function numOrNull(s) {
  if (s === undefined || s === null || s === '' || s === '#DIV/0!') return null;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function cleanList(lst, isPct) {
  if (!lst) return [];
  return lst.map(v => {
    if (v === null || v === undefined) return null;
    return isPct ? Math.round(v * 1000) / 10 : Math.round(v);
  });
}

function buildData(rows) {
  const header = rows[0];
  const weeks = [7, 9, 11, 13, 15, 17, 19, 21].map(i => header[i]);

  const data = {};
  const order = [];
  let curAm = null, curKey = null;
  const totalBlock = { metrics: {}, deltas: {} };
  let inTotal = false;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const hasAm = r[0] !== undefined && r[0] !== '';
    const hasHospitalId = r[1] !== undefined && r[1] !== '';
    const isNewBlock = hasAm || hasHospitalId;

    if (isNewBlock) {
      if (r[0] === '총합계') {
        inTotal = true; curKey = null;
      } else {
        inTotal = false;
        if (hasAm) curAm = r[0];
        const meta = { am: curAm, hospital_id: String(r[1]), hospital: r[2], tier: String(r[3]), district: r[4], hgroup: r[5] };
        curKey = curAm + '||' + meta.hospital_id;
        data[curKey] = { meta, metrics: {}, deltas: {} };
        order.push(curKey);
      }
    }

    const metric = r[6];
    if (!metric) continue;
    const vals = [7, 9, 11, 13, 15, 17, 19, 21].map(idx => numOrNull(r[idx]));
    const deltas = [8, 10, 12, 14, 16, 18, 20].map(idx => numOrNull(r[idx]));

    if (inTotal) {
      totalBlock.metrics[metric] = vals;
      totalBlock.deltas[metric] = deltas;
    } else if (curKey) {
      data[curKey].metrics[metric] = vals;
      data[curKey].deltas[metric] = deltas;
    }
  }

  const hospitals = order.map(key => {
    const d = data[key];
    const m = d.metrics, dl = d.deltas;
    return {
      am: d.meta.am,
      hospital_id: d.meta.hospital_id,
      hospital: d.meta.hospital,
      tier: d.meta.tier,
      district: d.meta.district,
      hgroup: d.meta.hgroup,
      impressions: cleanList(m['성과형광고 노출 이벤트수'], false),
      impressions_delta: cleanList(dl['성과형광고 노출 이벤트수'], false),
      revenue: cleanList(m['CPC매출액'], false),
      revenue_delta_pct: cleanList(dl['CPC매출액'], true)
    };
  });

  const grandTotal = {
    impressions: cleanList(totalBlock.metrics['성과형광고 노출 이벤트수'], false),
    impressions_delta: cleanList(totalBlock.deltas['성과형광고 노출 이벤트수'], false),
    revenue: cleanList(totalBlock.metrics['CPC매출액'], false),
    revenue_delta_pct: cleanList(totalBlock.deltas['CPC매출액'], true)
  };

  return { weeks, hospitals, grand_total: grandTotal, updated_at: new Date().toISOString() };
}

module.exports = async function handler(req, res) {
  try {
    const r = await fetch(csvUrl());
    if (!r.ok) {
      res.status(502).json({ error: `구글시트 요청 실패 (HTTP ${r.status})` });
      return;
    }
    const text = await r.text();
    if (text.trim().startsWith('<')) {
      res.status(403).json({ error: '시트가 비공개 상태예요. "링크가 있는 모든 사용자 - 뷰어"로 공유해주세요.' });
      return;
    }
    const rows = parseCSV(text);
    const data = buildData(rows);
    if (!data.hospitals || data.hospitals.length === 0) {
      res.status(500).json({ error: '데이터를 찾지 못했어요. 시트 구조가 바뀌었는지 확인해주세요.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
};
