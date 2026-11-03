/* 共用邏輯：截圖文字解析、族譜索引、核對狀態。瀏覽器與測試共用。 */
(function (g) {
  const PAT = /^((?:R1|A\d(?:-\d)?)-[A-Z]+(?:\([SN]\))?-L[B0-9]+-[A-Z0-9.]+-\d+-\d+(?:-\d+)?)/;
  const ANNOT = /\((族譜沒有|現場[^)]*|串[^)]*)\)/g;
  const norm = s => String(s == null ? '' : s).split('\n')[0].trim().toUpperCase().replace(/\s+/g, '').replace(/－/g, '-');
  const toolKey = t => String(t || '').toUpperCase().replace(/\s+/g, '').replace(/\(.*$/, '');
  const noSN = c => c.replace(/\([SN]\)/g, '');
  function codeKey(point) {
    const c = norm(String(point).replace(ANNOT, ''));
    const m = c.match(PAT);
    return m ? m[1] : c;
  }
  function buildIndex(book) {
    const idx = new Map(), idx2 = new Map();
    for (const r of book) {
      const m = norm(r[0]).match(PAT);
      if (!m) continue;
      const k = m[1];
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push(r);
    }
    for (const [k, v] of idx) {
      const k2 = noSN(k);
      if (!idx2.has(k2)) idx2.set(k2, []);
      idx2.get(k2).push([k, v]);
    }
    return { idx, idx2 };
  }
  // 回傳 {s:'ok'|'unreg'|'missing', how, rows, ovr}
  function status(tool, point, I, ovr) {
    const key = codeKey(point);
    let rows = I.idx.get(key), how = '';
    if (!rows) {
      const alts = I.idx2.get(noSN(key)) || [];
      if (alts.length === 1) { rows = alts[0][1]; how = 'S/N 不同：' + alts[0][0]; }
    }
    const tk = toolKey(tool);
    let s;
    if (!rows) s = 'missing';
    else s = rows.some(r => tk && norm(r[1]).includes(tk)) ? 'ok' : 'unreg';
    const o = ovr && ovr[tk + '|' + key];
    if (s !== 'ok' && o) return { s: 'ok', how, rows: rows || [], ovr: o };
    return { s, how, rows: rows || [], ovr: null };
  }
  // 送氣：族譜中此機台在該點位的 TMS-CMM > 0 視為已送氣；回傳 {gas:bool, cmm}
  function gas(tool, st) {
    const tk = toolKey(tool);
    if (!st || st.s === 'missing') return { gas: false, cmm: null };
    const rows = st.rows.filter(r => tk && norm(r[1]).includes(tk));
    const v = rows.map(r => +r[2]).filter(x => !isNaN(x));
    const mx = v.length ? Math.max(...v) : null;
    return { gas: mx != null && mx > 0, cmm: mx };
  }
  // 從 AI 抄寫的截圖文字解析核准單
  function parseApproval(text) {
    const t = String(text || '').replace(/\r/g, '').replace(/：/g, ':').replace(/，/g, ',');
    const pick = re => { const m = t.match(re); return m ? m[1].trim() : ''; };
    const micap = pick(/MICAP\s*:\s*([0-9]{5,})/i);
    const tool = pick(/Tool\s*ID\s*:\s*([^\n]+)/i).replace(/\s+/g, '');
    const mod = pick(/Module\s*:\s*([A-Za-z ]+)/i).trim().toUpperCase();
    const areaLine = pick(/廠區位置\s*:\s*([^\n]+)/);
    const area = (areaLine.match(/A\d-\d|A\d/) || [''])[0];
    const floors = [...new Set((areaLine.match(/L\d{2}/g) || []))].join(',');
    let seg = t;
    const i = t.search(/Take\s*off\s*申請點/i);
    if (i >= 0) seg = t.slice(i);
    const j = seg.search(/是否延伸管路/);
    if (j > 0) seg = seg.slice(0, j);
    seg = seg.replace(/\s*\n\s*/g, '').replace(/^Take\s*off\s*申請點\s*:?/i, '');
    const re = /(\(族譜沒有\))?\s*((?:R1|A\d(?:-\d)?)-[A-Za-z]+(?:\([SNsn]\))?-L[Bb\d]+-[A-Za-z0-9.]+(?:-\d+)+)(\([^)@]*\))?\s*@\s*([\d.]+)/g;
    const points = [];
    let m;
    while ((m = re.exec(seg))) {
      let code = m[2] + (m[3] || '');
      if (m[1] && !/族譜沒有/.test(code)) code += '(族譜沒有)';
      points.push([code, m[4].replace(/\.$/, '')]);
    }
    return { m: micap, t: tool, mod, a: area, f: floors, p: points };
  }
  g.EXQ = { norm, toolKey, codeKey, buildIndex, status, gas, parseApproval };
})(typeof window !== 'undefined' ? window : globalThis);
