// Vercel Serverless Function
// GET /api/refresh
// 구글시트를 서버에서 읽어오기 때문에 브라우저 CORS 제약이 없습니다.
// 전제조건: 시트가 "링크가 있는 모든 사용자 - 뷰어"로 공유되어 있어야 해요.
//
// 이제 매출/광고수가 별도 탭으로 분리되어 있어서, 두 탭을 각각 읽어
// hospital_id 기준으로 합쳐줍니다. 각 탭은 병원당 딱 한 줄이라
// (예전처럼 지표별로 여러 줄 쌓이는 구조가 아님) 파싱이 훨씬 단순해요.

// [FIX 4] 원본 OKR 시트 → 대시보드 전용 공개 시트로 교체
//
//   원본 「26-3차 OKR별 목표 및 업무 시트」는 회사 내부 도메인 공유만 걸려 있어
//   인증 없는 이 코드에서는 401 이 납니다. (2026-08 초부터 장애 원인)
//   원본을 통째로 링크 공개로 돌리면 파워콜 리스트·포인트 잔액 등 무관한 탭까지
//   외부에 열리므로, 매출/광고수 두 탭만 IMPORTRANGE 로 끌어온 별도 시트를 만들고
//   그 시트만 "링크가 있는 모든 사용자 - 뷰어" 로 공개합니다.
//   원본이 갱신되면 IMPORTRANGE 가 자동으로 따라오므로 주간 수작업은 없습니다.
const SHEET_ID = '1OUHqP3UksrPwXhnxEttpmU0O10c1gR9MdUJDNdJwPTQ';

// export 는 탭 이름을 못 받고 gid 만 받습니다.
// (gid 는 시트에서 해당 탭을 열었을 때 주소창 #gid= 뒤 숫자)
const GID_REVENUE = '0';               // 매출
const GID_IMPRESSIONS = '1598035038';  // 광고수

function csvUrl(gid) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
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

// [FIX 2] HOSPITAL_ID 의 천 단위 쉼표 제거
//
// 광고수 탭은 HOSPITAL_ID 가 숫자 서식이라 CSV 에 "3,776" 으로 내려오고,
// 매출 탭은 "3776" 으로 내려옵니다. 기존 normId 는 쉼표가 있으면 정규식
// /^-?\d+(\.\d+)?$/ 에 걸리지 않아 "3,776" 을 그대로 반환했습니다.
// → 두 탭의 같은 병원이 서로 다른 키가 되어 병합이 실패하고, 광고수 탭 쪽이
//   별개 병원으로 또 추가됩니다. ID 4자리 이상이 102곳이라 152 → 252 로 불어난 원인.
function normId(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim().replace(/,/g, '');   // ← 쉼표 제거
  if (s === '') return '';
  const n = parseFloat(s);
  if (!isNaN(n) && /^-?\d+(\.\d+)?$/.test(s)) return String(Math.round(n));
  return s;
}

// [FIX 5] 주차 헤더 라벨 정규화
//
//   IMPORTRANGE 로 끌어오면 날짜 셀이 원본 서식을 못 따라와서 헤더가
//   "2026. 9. 28" 같은 형태로 내려옵니다. 그대로 두면 차트 X축과 표 헤더가
//   전부 저 긴 문자열로 그려집니다. 시트 서식에 의존하지 않도록 코드에서 "9/28" 로 통일.
function normWeekLabel(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  const m = s.match(/^(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?$/);
  if (m) return `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`;
  return s;
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
  const weeks = valueIdx.map(i => normWeekLabel(header[i]));

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
      fetch(csvUrl(GID_REVENUE)),
      fetch(csvUrl(GID_IMPRESSIONS))
    ]);

    if (!revRes.ok || !impRes.ok) {
      res.status(502).json({
        error: `구글시트 요청 실패 (매출 HTTP ${revRes.status}, 광고수 HTTP ${impRes.status})`,
        hint: '시트가 "링크가 있는 모든 사용자 - 뷰어"로 공유돼 있는지 확인해주세요. 401이면 거의 항상 이 문제입니다.'
      });
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

    let weeks = revData.weeks.length ? revData.weeks : impData.weeks;

    // [FIX 3] 주차가 1개로 쪼그라드는 회귀를 조용히 넘기지 않도록 가드 강화
    // 기존엔 weeks.length === 0 일 때만 에러였습니다. 이번 장애처럼 1개만 파싱되면
    // 정상 응답(200)으로 내려가 대시보드가 "8/24 → 8/24" 한 주만 그리게 됩니다.
    if (weeks.length < 2) {
      res.status(500).json({
        error: `주차 파싱 실패: ${weeks.length}개만 인식됐어요. 시트 헤더 구조를 확인해주세요.`,
        debug: { weeks, revHeader: (revRows[0] || []).slice(6, 14), impHeader: (impRows[0] || []).slice(6, 14) }
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

    // [FIX 6] 아직 값이 안 채워진 선두 주차 잘라내기
    //
    //   시트에는 다음 주차 컬럼(예: 9/28, 9/21)이 헤더만 미리 만들어져 있고
    //   값은 비어 있는 경우가 많습니다. 그대로 두면 대시보드가 그 빈 주차를
    //   "최근주"로 잡아서 KPI 카드가 ₩0 / 0건으로 표시됩니다.
    //   매출·광고수 양쪽 모두 전 병원이 비어 있는 선두 주차만 제거합니다.
    //   (중간에 뚫린 주차는 실제 결측이므로 건드리지 않습니다.)
    let startIdx = 0;
    while (
      startIdx < weeks.length - 1 &&
      hospitals.every(h =>
        (h.revenue[startIdx] === null || h.revenue[startIdx] === undefined) &&
        (h.impressions[startIdx] === null || h.impressions[startIdx] === undefined)
      )
    ) {
      startIdx++;
    }

    if (startIdx > 0) {
      weeks = weeks.slice(startIdx);
      hospitals.forEach(h => {
        h.revenue = h.revenue.slice(startIdx);
        h.impressions = h.impressions.slice(startIdx);
        h.revenue_delta_pct = h.revenue_delta_pct.slice(startIdx);
        h.impressions_delta = h.impressions_delta.slice(startIdx);
      });
      if (revData.totalVals) revData.totalVals = revData.totalVals.slice(startIdx);
      if (impData.totalVals) impData.totalVals = impData.totalVals.slice(startIdx);
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
