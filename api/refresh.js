// Vercel Serverless Function
// GET /api/refresh
// 구글시트를 서버에서 읽어오기 때문에 브라우저 CORS 제약이 없습니다.
// 전제조건: 시트가 "링크가 있는 모든 사용자 - 뷰어"로 공유되어 있어야 해요.
//
// 이제 매출/광고수가 별도 탭으로 분리되어 있어서, 두 탭을 각각 읽어
// hospital_id 기준으로 합쳐줍니다. 각 탭은 병원당 딱 한 줄이라
// (예전처럼 지표별로 여러 줄 쌓이는 구조가 아님) 파싱이 훨씬 단순해요.

const SHEET_ID = '12of_jOnboNT38jzIgD66bJboEfejaXf2CBnHHLvrItE';
const SHEET_TAB_REVENUE = '매출';
const SHEET_TAB_IMPRESSIONS = '광고수';

function csvUrl(tabName) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
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

function normId(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = parseFloat(v);
  if (!isNaN(n) && /^-?\d+(\.\d+)?$/.test(String(v).trim())) return String(Math.round(n));
  return String(v).trim();
}

function numOrNull(s) {
  if (s === undefined || s === null || s === '' || s === '#DIV/0!' || s === '#REF!') return null;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function cleanList(lst, isPct) {
  if (!lst) return [];
  return lst.map(v => {
    if (v === null || v === undefined) return null;
    // CSV로 읽어오면 %컬럼은 이미 "-19.16" 형태(표시값)로 들어오므로 추가로 ×100 하지 않음
    return isPct ? Math.round(v * 10) / 10 : Math.round(v);
  });
}

function getWeekColumns(header) {
  // 컬럼 H(index7)부터 2칸씩(값, WoW) 이동하며 날짜가 있는 만큼 자동으로 인식
  const valueIdx = [];
  let i = 7;
  while (header[i] !== undefined && header[i] !== null && String(header[i]).trim() !== '') {
    valueIdx.push(i);
    i += 2;
  }
  const deltaIdx = [];
  for (let k = 0; k < valueIdx.length - 1; k++) {
    deltaIdx.push(valueIdx[k] + 1);
  }
  return { valueIdx, deltaIdx };
}

// 탭 하나를 읽어서 { weeks, byId, order, totalVals } 로 변환.
// isPct: 이 탭의 delta 컬럼이 %인지(매출) 절대값인지(광고수) 여부
function parseSheetTab(rows, isPct) {
  const header = rows[0];
  const { valueIdx, deltaIdx } = getWeekColumns(header);
  const weeks = valueIdx.map(i => header[i]);

  const byId = {};
  const order = [];
  let curAm = null;
  let totalVals = null; // 시트 맨 아래 합계 행 (있으면 이걸 그대로 씀)

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;

    const hospitalId = normId(r[1]);
    const label = r[6];

    if (hospitalId === '') {
      // 병원ID가 없는 행 중, G열에 "합계"가 들어간 행은 총합계 행으로 간주
      if (label && String(label).includes('합계')) {
        totalVals = cleanList(valueIdx.map(idx => numOrNull(r[idx])), false);
      }
      continue; // 병원ID 없는 행(총합계 포함)은 개별 병원 목록에는 넣지 않음
    }

    if (r[0] !== undefined && r[0] !== null && r[0] !== '') curAm = r[0];

    const meta = {
      am: curAm,
      hospital_id: hospitalId,
      hospital: r[2],
      tier: String(r[3]),
      district: r[4],
      hgroup: r[5]
    };
    const vals = cleanList(valueIdx.map(idx => numOrNull(r[idx])), false);
    const deltas = cleanList(deltaIdx.map(idx => numOrNull(r[idx])), isPct);

    byId[hospitalId] = { meta, vals, deltas };
    order.push(hospitalId);
  }

  return { weeks, byId, order, totalVals };
}

function pctChange(a, b) {
  if (a === null || a === undefined || b === null || b === undefined || b === 0) return null;
  return Math.round(((a - b) / b) * 1000) / 10;
}

module.exports = async function handler(req, res) {
  try {
    const [revRes, impRes] = await Promise.all([
      fetch(csvUrl(SHEET_TAB_REVENUE)),
      fetch(csvUrl(SHEET_TAB_IMPRESSIONS))
    ]);

    if (!revRes.ok || !impRes.ok) {
      res.status(502).json({ error: `구글시트 요청 실패 (매출 HTTP ${revRes.status}, 광고수 HTTP ${impRes.status})` });
      return;
    }

    const [revText, impText] = await Promise.all([revRes.text(), impRes.text()]);

    if (revText.trim().startsWith('<') || impText.trim().startsWith('<')) {
      res.status(403).json({ error: '시트가 비공개 상태예요. "링크가 있는 모든 사용자 - 뷰어"로 공유해주세요.' });
      return;
    }

    const revRows = parseCSV(revText);
    const impRows = parseCSV(impText);

    const revData = parseSheetTab(revRows, true);   // 매출 delta = %
    const impData = parseSheetTab(impRows, false);  // 광고수 delta = 절대값

    const weeks = revData.weeks.length ? revData.weeks : impData.weeks;

    if (!weeks.length) {
      res.status(500).json({
        error: '데이터를 찾지 못했어요. 시트 구조가 바뀌었는지 확인해주세요.',
        debug: { revRow0: revRows[0] || null, impRow0: impRows[0] || null }
      });
      return;
    }

    // hospital_id 기준으로 두 탭 병합 (매출 탭 순서를 기준으로, 광고수 탭에만 있는 병원도 추가)
    const allIds = [...revData.order];
    impData.order.forEach(id => { if (!allIds.includes(id)) allIds.push(id); });

    const hospitals = allIds.map(id => {
      const rev = revData.byId[id];
      const imp = impData.byId[id];
      const meta = rev ? rev.meta : imp.meta;
      return {
        am: meta.am,
        hospital_id: meta.hospital_id,
        hospital: meta.hospital,
        tier: meta.tier,
        district: meta.district,
        hgroup: meta.hgroup,
        revenue: rev ? rev.vals : new Array(weeks.length).fill(null),
        revenue_delta_pct: rev ? rev.deltas : new Array(weeks.length - 1).fill(null),
        impressions: imp ? imp.vals : new Array(weeks.length).fill(null),
        impressions_delta: imp ? imp.deltas : new Array(weeks.length - 1).fill(null)
      };
    });

    if (hospitals.length === 0) {
      res.status(500).json({
        error: '데이터를 찾지 못했어요. 시트 구조가 바뀌었는지 확인해주세요.',
        debug: { revRow0: revRows[0] || null, revRow1: revRows[1] || null, impRow0: impRows[0] || null, impRow1: impRows[1] || null }
      });
      return;
    }

    // 총합계: 시트에 합계 행이 있으면 그걸 그대로 쓰고, 없으면 병원 전체를 직접 합산
    const gtRevenue = revData.totalVals ? revData.totalVals : weeks.map((w, i) =>
      hospitals.reduce((s, h) => s + (h.revenue[i] ?? 0), 0)
    );
    const gtImpressions = impData.totalVals ? impData.totalVals : weeks.map((w, i) =>
      hospitals.reduce((s, h) => s + (h.impressions[i] ?? 0), 0)
    );
    const gtRevenueDelta = [];
    const gtImpressionsDelta = [];
    for (let i = 0; i < weeks.length - 1; i++) {
      gtRevenueDelta.push(pctChange(gtRevenue[i], gtRevenue[i + 1]));
      gtImpressionsDelta.push(gtImpressions[i] !== null && gtImpressions[i + 1] !== null ? Math.round(gtImpressions[i] - gtImpressions[i + 1]) : null);
    }

    const data = {
      weeks,
      hospitals,
      grand_total: {
        revenue: gtRevenue,
        revenue_delta_pct: gtRevenueDelta,
        impressions: gtImpressions,
        impressions_delta: gtImpressionsDelta
      },
      updated_at: new Date().toISOString()
    };

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
};
