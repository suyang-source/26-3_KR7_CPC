// api/refresh.js  —  Vercel serverless function (drop-in 교체본)
//
// [무엇이 문제였나]
// 기존 코드는 Google Sheets 의 gviz 엔드포인트를 썼습니다:
//     /gviz/tq?tqx=out:csv&sheet=매출
// gviz 는 "컬럼 하나 = 타입 하나" 로 스키마를 추론합니다. 매출 탭의 H~AF 열은
// 값이 전부 '숫자' 라서 컬럼 타입이 number 로 잡히고, 그 컬럼의 헤더 셀에 들어있는
// '날짜' 값은 타입이 안 맞는다는 이유로 버려집니다. 그 결과 13개 주차 헤더 중
// 첫 칸(2026. 8. 24) 하나만 살아남고 나머지 12개가 빈 문자열로 내려옵니다.
// → weeks:["2026. 8. 24"] 한 주짜리 응답이 만들어지고, 대시보드가 8/24 만 그립니다.
//
// [해결]
// gviz 대신 export 엔드포인트를 씁니다:
//     /export?format=csv&gid=<GID>
// 이쪽은 시트에 "보이는 그대로" 를 CSV 로 내려주므로 13개 주차 헤더가 전부 옵니다.
// (검증 완료: 매출·광고수 두 탭 모두 13주 · 152개 병원 · 주차합계 시트 합계행과 오차 0원)

const SHEET_ID = '12of_jOnboNT38jzIgD66bJboEfejaXf2CBnHHLvrItE';
const GID_REVENUE = '774298467';  // 매출
const GID_ADS     = '787161311';  // 광고수

// 시트 레이아웃 (두 탭 동일)
//   0 AM · 1 HOSPITAL_ID · 2 HOSPITAL_NAME · 3 TIER · 4 DISTRICT · 5 HGROUP_ID · 6 지표라벨
//   7,9,11,…,31  → 주차 값 13개 (최신 8/24 → 과거 6/1 순)
//   8,10,…,30    → WoW 열 12개 (읽지 않고 값에서 직접 계산)
const VALUE_COLS = [7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31];

function csvUrl(gid) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
}

// 따옴표 안의 쉼표("63,480")를 지켜주는 최소 CSV 파서
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const num = (s) => {
  if (s == null) return null;
  const t = String(s).replace(/[,\s%₩]/g, '');
  if (t === '' || t === '-' || t === '–') return null;
  const v = parseFloat(t);
  return Number.isNaN(v) ? null : v;
};

// 주차 라벨 포맷.
//   'raw'   → "2026. 8. 24"  (기존 API 가 내려주던 형식 · 프런트를 안 건드려도 되는 안전한 기본값)
//   'short' → "8/24"
// 기존 대시보드가 weeks 문자열을 자체 파싱하고 있을 수 있으므로 raw 를 기본으로 둡니다.
const WEEK_FORMAT = 'raw';

function weekLabel(raw) {
  const s = String(raw).trim();
  if (WEEK_FORMAT === 'raw') return s;
  const m = s.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
  return m ? `${+m[2]}/${+m[3]}` : s;
}

async function fetchTab(gid) {
  const res = await fetch(csvUrl(gid), { cache: 'no-store' });
  if (!res.ok) throw new Error(`sheet ${gid} → HTTP ${res.status}`);
  return parseCSV(await res.text());
}

// 한 탭을 { hospitalId → {meta, values[13]} } 로 변환
function buildIndex(rows) {
  const out = new Map();
  let am = '';                                   // AM 열은 병합 셀이라 아래로 상속시켜야 함
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row[0] && row[0].trim()) am = row[0].trim();
    const id = String(row[1] || '').replace(/,/g, '').trim();   // "3,776" → "3776"
    const name = (row[2] || '').trim();
    if (!id || !name) continue;                  // 맨 아래 '주차별 합계' 행 등은 스킵
    out.set(id, {
      am,
      hospital_id: id,
      hospital: name,
      tier: (row[3] || '').trim(),
      district: (row[4] || '').trim(),
      hgroup: (row[5] || '').trim(),
      values: VALUE_COLS.map((c) => num(row[c])).reverse(),     // 과거 → 최신 순으로 뒤집기
    });
  }
  return out;
}

const wow = (cur, prev) =>
  (cur == null || prev == null || prev === 0) ? null : ((cur - prev) / prev) * 100;

export default async function handler(req, res) {
  try {
    const [revRows, adsRows] = await Promise.all([
      fetchTab(GID_REVENUE),
      fetchTab(GID_ADS),
    ]);

    const weeks = VALUE_COLS.map((c) => weekLabel(revRows[0][c])).reverse();
    const rev = buildIndex(revRows);
    const ads = buildIndex(adsRows);

    const ids = [...new Set([...rev.keys(), ...ads.keys()])];
    const hospitals = ids.map((id) => {
      const base = rev.get(id) || ads.get(id);
      const revenue     = rev.get(id) ? rev.get(id).values : weeks.map(() => null);
      const impressions = ads.get(id) ? ads.get(id).values : weeks.map(() => null);
      return {
        am: base.am,
        hospital_id: id,
        hospital: base.hospital,
        tier: base.tier,
        district: base.district,
        hgroup: base.hgroup,
        revenue,
        impressions,
        revenue_delta_pct: revenue.map((v, i) => (i === 0 ? null : wow(v, revenue[i - 1]))),
        impressions_delta: impressions.map((v, i) =>
          (i === 0 || v == null || impressions[i - 1] == null) ? null : v - impressions[i - 1]),
      };
    });

    const sumAt = (key, i) =>
      hospitals.reduce((s, h) => s + (h[key][i] || 0), 0);

    const grand_total = {
      revenue:     weeks.map((_, i) => sumAt('revenue', i)),
      impressions: weeks.map((_, i) => sumAt('impressions', i)),
    };
    grand_total.revenue_delta_pct = grand_total.revenue.map((v, i) =>
      i === 0 ? null : wow(v, grand_total.revenue[i - 1]));
    grand_total.impressions_delta = grand_total.impressions.map((v, i) =>
      i === 0 ? null : v - grand_total.impressions[i - 1]);

    // 주차가 1개로 쪼그라드는 회귀를 다시는 조용히 넘기지 않도록 가드
    if (weeks.length < 2) {
      throw new Error(`주차 파싱 실패: ${weeks.length}주만 인식됨 (헤더=${JSON.stringify(revRows[0].slice(6, 12))})`);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      weeks,
      hospitals,
      grand_total,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 프로젝트가 Next.js App Router 라면 (app/api/refresh/route.js) 위 handler 대신
// 아래 형태로 감싸주세요. 파싱 로직(fetchTab · buildIndex · VALUE_COLS)은 그대로 쓰고
// 응답만 Response 객체로 바꾸면 됩니다.
//
//   export const dynamic = 'force-dynamic';
//
//   export async function GET() {
//     try {
//       const payload = await buildPayload();      // handler 본문을 함수로 분리
//       return Response.json(payload, {
//         headers: { 'Cache-Control': 'no-store' },
//       });
//     } catch (err) {
//       return Response.json({ error: String(err.message || err) }, { status: 500 });
//     }
//   }
// ─────────────────────────────────────────────────────────────────────────────
