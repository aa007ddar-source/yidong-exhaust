// Cloudflare Pages advanced mode worker：/api/* 為資料 API，其餘交給靜態檔案。
// 需要的綁定：KV 命名空間 DB、Workers AI 綁定 AI、機密變數 EDIT_PASSWORD。

const J = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const PROMPT =
  '這是一張「派點申請核准」通知的截圖。請逐字抄寫圖片中訊息框裡的所有文字，保持原本的換行。' +
  '不要翻譯、不要摘要、不要加任何說明或格式符號。英文字母、數字、括號、連字號、小數點與 @ 必須完全照圖片抄寫。';

let seedCache = null;
async function seed(env, req) {
  if (seedCache) return seedCache;
  const r = await env.ASSETS.fetch(new Request(new URL('/data.json', req.url)));
  seedCache = await r.json();
  return seedCache;
}
async function getPart(env, req, key) {
  if (env.DB) {
    const v = await env.DB.get(key, 'json');
    if (v !== null) return v;
  }
  // 初始資料（data.json）只屬於后里 F16；其他廠從空白開始
  if (env.PLANT !== 'F16') return key === 'ovr' || key === 'meta' ? {} : [];
  const s = await seed(env, req);
  return s[key] ?? (key === 'ovr' ? {} : key === 'meta' ? {} : []);
}
async function putPart(env, key, val) {
  await env.DB.put(key, JSON.stringify(val));
}

async function listMeta(env, prefix) {
  const out = new Map();
  let cursor;
  do {
    const r = await env.DB.list({ prefix, cursor });
    for (const k of r.keys) out.set(k.name.slice(prefix.length), k.metadata || {});
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

const cleanDays = (arr, first) => [...new Set([first, ...(Array.isArray(arr) ? arr : [])].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d || '')))].sort().slice(0, 60);
// 每台機台每種圖檔只留一份：寫入後刪掉同機台、同分類的其他檔案
const tk = t => String(t || '').toUpperCase().replace(/\s+/g, '').replace(/\(.*$/, '');
// known：頁面已知的舊檔 id（KV 清單有延遲，剛上傳的檔案可能還列不出來）
async function dropOtherIso(env, keepId, t, c, known = []) {
  const all = await listMeta(env, 'iso:');
  const gone = [...new Set([...[...all].filter(([id, m]) => tk(m.t) === tk(t) && (m.c || 'iso') === c).map(([id]) => id),
    ...known.filter(id => /^[a-z0-9]{6,20}$/.test(id))])].filter(id => id !== keepId);
  await Promise.all(gone.map(id => env.DB.delete('iso:' + id)));
  return gone;
}
async function putJob(env, job) {
  await env.DB.put('job:' + job.id, JSON.stringify(job), { metadata: { d: job.date, done: job.done } });
}
// 送氣完成時把排程內的點位記為已送氣；取消時改回未送氣
async function setPointGas(env, job, on) {
  if ((job.kind && job.kind !== 'gas') || !job.apprId || !job.points?.length) return;
  const at = new Date().toISOString();
  await Promise.all(job.points.map(code =>
    env.DB.put('gasp:' + job.apprId + '|' + code, on ? 'yes' : 'no', { metadata: { v: on ? 'yes' : 'no', at, job: job.id } })));
}

function authed(req, env) {
  if (!env.EDIT_PASSWORD) return 'nopass';
  return req.headers.get('x-edit-key') === env.EDIT_PASSWORD ? 'ok' : 'bad';
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

async function runOcr(env, b64) {
  const errors = [];
  const dataUrl = 'data:image/jpeg;base64,' + b64;
  const textOf = r => (typeof r === 'string' ? r : r?.response ?? r?.result?.response ?? r?.description ?? '');
  const attempts = [
    ['@cf/meta/llama-4-scout-17b-16e-instruct', () => env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      max_tokens: 2048, temperature: 0,
    })],
    ['@cf/mistralai/mistral-small-3.1-24b-instruct', () => env.AI.run('@cf/mistralai/mistral-small-3.1-24b-instruct', {
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      max_tokens: 2048, temperature: 0,
    })],
    ['@cf/meta/llama-3.2-11b-vision-instruct', async () => {
      const bytes = [...b64ToBytes(b64)];
      try { await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: 'agree' }); } catch (e) {}
      return env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
        messages: [{ role: 'user', content: PROMPT }], image: bytes, max_tokens: 2048, temperature: 0,
      });
    }],
  ];
  for (const [name, fn] of attempts) {
    try {
      const t = textOf(await fn());
      if (t && /MICAP|Tool|Take/i.test(t)) return { text: t, model: name, errors };
      errors.push(name + ': 回傳內容無法辨識');
    } catch (e) {
      errors.push(name + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  return { text: '', model: '', errors };
}

async function api(req, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;

  if (path === '/api/data' && method === 'GET') {
    const [appr, book, ovr, meta] = await Promise.all(['appr', 'book', 'ovr', 'meta'].map(k => getPart(env, req, k)));
    if (env.DB) {
      // 送氣與族譜修正標記各自存成獨立的 key，避免多人同時修改時互相覆蓋
      const gas = await listMeta(env, 'gas:');
      for (const a of appr) if (gas.has(String(a.id))) a.gas = gas.get(String(a.id)).v === 'yes' ? 'yes' : null;
      const ov = await listMeta(env, 'ovr:');
      for (const [k, m] of ov) { if (m.removed) delete ovr[k]; else ovr[k] = { note: m.note, date: m.date }; }
    }
    const gasp = env.DB ? Object.fromEntries(await listMeta(env, 'gasp:')) : {};
    const iso = env.DB ? Object.fromEntries(await listMeta(env, 'iso:')) : {};
    return J({ appr, book, ovr, meta, gasp, iso, storage: !!env.DB, ai: !!env.AI, edit: !!env.EDIT_PASSWORD });
  }

  // 每日施工（送氣排程）：任何人都可以新增、完成、刪除
  if (path === '/api/jobs' && method === 'GET') {
    if (!env.DB) return J({ jobs: [] });
    const list = await listMeta(env, 'job:');
    const jobs = (await Promise.all([...list.keys()].map(id => env.DB.get('job:' + id, 'json')))).filter(Boolean);
    return J({ jobs });
  }
  if (path === '/api/jobs' && method === 'POST') {
    if (!env.DB) return J({ error: '尚未綁定 KV 儲存空間 DB。' }, 503);
    const b = await req.json();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return J({ error: '請選擇日期。' }, 400);
    const kind = ['hook', 'dehook', 'gas'].includes(b.kind) ? b.kind : 'gas';
    const tool = String(b.tool || '').toUpperCase().replace(/\s+/g, '').slice(0, 60);
    if (!tool) return J({ error: '請輸入機台。' }, 400);
    const points = Array.isArray(b.points) ? b.points.map(p => String(p).slice(0, 80)).slice(0, 30) : [];
    const s = (v, n) => String(v || '').slice(0, n);
    const job = {
      id: b.date + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind, date: b.date, days: cleanDays(b.days, b.date), time: s(b.time, 5), apprId: b.apprId ? String(b.apprId) : '', tool,
      area: s(b.area, 10), floor: s(b.floor, 20), col: s(b.col, 20), vendor: s(b.vendor, 30),
      items: Array.isArray(b.items) ? b.items.map(x => s(x, 20)).filter(Boolean).slice(0, 8) : [],
      points, note: s(b.note, 300), done: false, created: new Date().toISOString(),
    };
    await putJob(env, job);
    return J({ ok: true, job });
  }
  const jm = path.match(/^\/api\/jobs\/([\w-]+)$/);
  if (jm && (method === 'PATCH' || method === 'DELETE')) {
    if (!env.DB) return J({ error: '尚未綁定 KV 儲存空間 DB。' }, 503);
    const job = await env.DB.get('job:' + jm[1], 'json');
    if (!job) return J({ error: '找不到這筆排程，可能已被刪除。' }, 404);
    if (method === 'DELETE') {
      if (job.done) await setPointGas(env, job, false);
      await env.DB.delete('job:' + jm[1]);
      return J({ ok: true });
    }
    const b = await req.json();
    // 修改內容：若已完成送氣，先撤回舊點位，改完再依新內容補上
    const edit = ['kind', 'date', 'days', 'tool', 'apprId', 'points', 'items'].some(k => k in b);
    if (edit) {
      if (job.done) await setPointGas(env, job, false);
      if ('kind' in b && ['hook', 'dehook', 'gas'].includes(b.kind)) job.kind = b.kind;
      const oldDays = job.days && job.days.length ? job.days : [job.date];
      let nd = null;
      if (Array.isArray(b.days)) nd = cleanDays(b.days, b.days[0]);
      else if (/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) nd = cleanDays(oldDays.filter(x => x !== job.date), b.date);
      if (nd && nd.length) { job.days = nd; job.date = nd[0]; }
      if ('tool' in b && String(b.tool || '').trim()) job.tool = String(b.tool).toUpperCase().replace(/\s+/g, '').slice(0, 60);
      if ('apprId' in b) job.apprId = b.apprId ? String(b.apprId) : '';
      if (Array.isArray(b.points)) job.points = b.points.map(p => String(p).slice(0, 80)).slice(0, 30);
      if (Array.isArray(b.items)) job.items = b.items.map(x => String(x || '').slice(0, 20)).filter(Boolean).slice(0, 8);
    }
    if (b.prog && /^\d{4}-\d{2}-\d{2}$/.test(b.prog.d || '')) {
      job.prog = job.prog || {};
      const v = b.prog.p;
      if (v === null || v === '' || isNaN(+v)) delete job.prog[b.prog.d];
      else job.prog[b.prog.d] = Math.max(0, Math.min(100, Math.round(+v)));
    }
    if (b.pnote && /^\d{4}-\d{2}-\d{2}$/.test(b.pnote.d || '')) {
      job.pnote = job.pnote || {};
      const t = String(b.pnote.t || '').trim().slice(0, 200);
      if (t) job.pnote[b.pnote.d] = t; else delete job.pnote[b.pnote.d];
    }
    if ('done' in b) {
      job.done = !!b.done;
      job.doneAt = job.done ? new Date().toISOString() : null;
      job.doneBy = job.done ? String(b.by || '').slice(0, 40) : '';
      await setPointGas(env, job, job.done);
    }
    if (edit && !('done' in b) && job.done) await setPointGas(env, job, true);
    for (const [k, n] of [['time', 5], ['note', 300], ['area', 10], ['floor', 20], ['col', 20], ['vendor', 30]]) if (k in b) job[k] = String(b[k] || '').slice(0, n);
    await putJob(env, job);
    return J({ ok: true, job });
  }

  // 機台會勘紀錄：任何人都可以新增、修改、刪除
  if (path === '/api/survey' && method === 'GET') {
    if (!env.DB) return J({ items: [] });
    const list = await listMeta(env, 'svy:');
    const items = (await Promise.all([...list.keys()].map(id => env.DB.get('svy:' + id, 'json')))).filter(Boolean);
    return J({ items });
  }
  const svm = path.match(/^\/api\/survey(?:\/([\w-]+))?$/);
  if (svm && ['POST', 'PATCH', 'DELETE'].includes(method)) {
    if (!env.DB) return J({ error: '尚未綁定 KV 儲存空間 DB。' }, 503);
    const D8 = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '';
    const S = (v, n) => String(v || '').slice(0, n);
    const clean = (b, o = {}) => {
      for (const [k, n] of [['grp', 20], ['link', 120], ['onText', 30], ['vendor', 30], ['gd', 80], ['note', 300], ['by', 30], ['micap', 20], ['area', 40], ['loc', 40], ['floor', 10], ['src', 80]]) if (k in b) o[k] = S(b[k], n);
      // Exhaust 各系統需求規格（TUMS 匯入）
      if (Array.isArray(b.spec)) o.spec = b.spec.slice(0, 80).map(r => Object.fromEntries(['sys', 'pt', 'comp', 'flow', 'unit', 'size', 'type', 'mat', 'dir', 'pmax', 'pmin', 'vno', 'tpoc', 'rmk'].map(k => [k, S(r && r[k], 60)])));
      if ('tool' in b) o.tool = S(b.tool, 60).trim();
      for (const k of ['svy', 'odd', 'on']) if (k in b) o[k] = D8(b[k]);
      if ('done' in b) o.done = !!b.done;
      return o;
    };
    if (method === 'POST' && !svm[1]) {
      const b = await req.json();
      const items = Array.isArray(b.items) ? b.items : [b];
      const out = [];
      for (const it of items.slice(0, 100)) {
        const o = clean(it, { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), done: false, created: new Date().toISOString() });
        if (!o.tool) continue;
        await env.DB.put('svy:' + o.id, JSON.stringify(o), { metadata: { t: o.tool } });
        out.push(o);
      }
      if (!out.length) return J({ error: '請輸入機台。' }, 400);
      return J({ ok: true, item: out[0], items: out });
    }
    if (!svm[1]) return J({ error: 'not found' }, 404);
    const cur = await env.DB.get('svy:' + svm[1], 'json');
    if (!cur) return J({ error: '找不到這筆會勘紀錄，可能已被刪除。' }, 404);
    if (method === 'DELETE') { await env.DB.delete('svy:' + svm[1]); return J({ ok: true }); }
    const o = clean(await req.json(), cur);
    if (!o.tool) return J({ error: '請輸入機台。' }, 400);
    o.updated = new Date().toISOString();
    await env.DB.put('svy:' + o.id, JSON.stringify(o), { metadata: { t: o.tool } });
    return J({ ok: true, item: o });
  }

  // 完工 ISO 圖：任何人都可以匯入；刪除需編輯密碼
  if (path === '/api/iso' && method === 'POST') {
    if (!env.DB) return J({ error: '尚未綁定 KV 儲存空間 DB。' }, 503);
    const dec = v => { try { return decodeURIComponent(v || ''); } catch (e) { return ''; } };
    const tool = dec(req.headers.get('x-tool')).toUpperCase().replace(/\s+/g, '').slice(0, 60);
    const name = dec(req.headers.get('x-name')).slice(0, 120) || 'iso';
    if (!tool) return J({ error: '缺少機台名稱。' }, 400);
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) return J({ error: '檔案是空的。' }, 400);
    if (buf.byteLength > 20 * 1024 * 1024) return J({ error: '檔案超過 20MB，請壓縮後再上傳。' }, 413);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const cat = ['iso', 'lego'].includes(req.headers.get('x-cat')) ? req.headers.get('x-cat') : 'iso';
    const meta = { t: tool, c: cat, n: name, y: (req.headers.get('content-type') || 'application/octet-stream').slice(0, 60), s: buf.byteLength, at: new Date().toISOString(), by: dec(req.headers.get('x-by')).slice(0, 30) };
    await env.DB.put('iso:' + id, buf, { metadata: meta });
    return J({ ok: true, id, meta, replaced: [] });
  }
  const im = path.match(/^\/api\/iso\/([a-z0-9]+)$/);
  if (im && method === 'GET') {
    if (!env.DB) return new Response('not found', { status: 404 });
    const { value, metadata } = await env.DB.getWithMetadata('iso:' + im[1], 'arrayBuffer');
    if (!value) return new Response('not found', { status: 404 });
    return new Response(value, { headers: { 'content-type': metadata?.y || 'application/octet-stream', 'content-disposition': "inline; filename*=UTF-8''" + encodeURIComponent(metadata?.n || 'iso'), 'cache-control': 'public, max-age=31536000, immutable' } });
  }
  if (im && method === 'DELETE') {
    if (!env.DB) return J({ error: '尚未綁定 KV 儲存空間 DB。' }, 503);
    await env.DB.delete('iso:' + im[1]);
    return J({ ok: true });
  }
  // 改分類（ISO 圖 ↔ 樂高圖）：KV 的 metadata 只能隨內容一起重寫
  if (im && method === 'PATCH') {
    if (!env.DB) return J({ error: '尚未綁定 KV 儲存空間 DB。' }, 503);
    const b = await req.json();
    const t = String(b.t || '').toUpperCase().replace(/\s+/g, '').slice(0, 60);
    if (b.c && !['iso', 'lego'].includes(b.c)) return J({ error: '分類錯誤。' }, 400);
    if (!b.c && !t) return J({ error: '沒有要變更的內容。' }, 400);
    const { value, metadata } = await env.DB.getWithMetadata('iso:' + im[1], 'arrayBuffer');
    if (!value) return J({ error: '找不到這個檔案，可能已被刪除。' }, 404);
    const meta = { ...(metadata || {}) };
    if (b.c) meta.c = b.c;
    if (t) meta.t = t;
    await env.DB.put('iso:' + im[1], value, { metadata: meta });
    return J({ ok: true, id: im[1], meta, replaced: [] });
  }

  if (path.startsWith('/api/img/') && method === 'GET') {
    if (!env.DB) return new Response('not found', { status: 404 });
    const key = 'img:' + path.slice(9);
    const { value, metadata } = await env.DB.getWithMetadata(key, 'arrayBuffer');
    if (!value) return new Response('not found', { status: 404 });
    return new Response(value, { headers: { 'content-type': metadata?.type || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' } });
  }

  // 送氣狀態：任何人都可以變更
  const g = path.match(/^\/api\/gas\/([\w-]+)$/);
  if (g && method === 'POST') {
    if (!env.DB) return J({ error: '尚未綁定 KV 儲存空間 DB。' }, 503);
    const { gas } = await req.json();
    const v = gas === 'yes' ? 'yes' : 'no';
    await env.DB.put('gas:' + g[1], v, { metadata: { v, at: new Date().toISOString() } });
    return J({ ok: true });
  }

  // 人工確認吻合：任何人都可以標記
  if (path === '/api/override' && method === 'POST') {
    if (!env.DB) return J({ error: '尚未綁定 KV 儲存空間 DB。' }, 503);
    const { key, note, remove } = await req.json();
    if (!key) return J({ error: '缺少點位。' }, 400);
    const m = remove ? { removed: true, date: new Date().toISOString() } : { note: String(note || '人工確認').slice(0, 200), date: new Date().toISOString() };
    await env.DB.put('ovr:' + key, '1', { metadata: m });
    return J({ ok: true });
  }

  // 以下需要編輯密碼
  const a = authed(req, env);
  if (a === 'nopass') return J({ error: '尚未在 Cloudflare 設定編輯密碼 EDIT_PASSWORD。' }, 503);
  if (a !== 'ok') return J({ error: '編輯密碼不正確。' }, 401);
  if (!env.DB && path !== '/api/login') return J({ error: '尚未綁定 KV 儲存空間 DB。' }, 503);

  if (path === '/api/login' && method === 'POST') return J({ ok: true, storage: !!env.DB, ai: !!env.AI });

  if (path === '/api/ocr' && method === 'POST') {
    if (!env.AI) return J({ error: '尚未綁定 Workers AI（AI）。' }, 503);
    const { image } = await req.json();
    if (!image) return J({ error: '沒有收到圖片。' }, 400);
    const r = await runOcr(env, image);
    return J(r, r.text ? 200 : 502);
  }

  if (path === '/api/approval' && method === 'POST') {
    const { record, image, imageType } = await req.json();
    if (!record || !record.t || !Array.isArray(record.p)) return J({ error: '資料不完整：需要機台名稱與點位。' }, 400);
    const appr = await getPart(env, req, 'appr');
    if (record.h && appr.some(x => x.h === record.h)) return J({ error: '這張截圖已經存過了。' }, 409);
    if (image && record.h) {
      await env.DB.put('img:' + record.h, b64ToBytes(image), { metadata: { type: imageType || 'image/jpeg' } });
      record.img = 'api/img/' + record.h;
    }
    record.id = 'u' + Date.now().toString(36);
    record.added = new Date().toISOString();
    appr.push(record);
    await putPart(env, 'appr', appr);
    return J({ ok: true, record });
  }

  const m = path.match(/^\/api\/approval\/([\w-]+)$/);
  if (m && (method === 'PATCH' || method === 'DELETE')) {
    const appr = await getPart(env, req, 'appr');
    const i = appr.findIndex(x => String(x.id) === m[1]);
    if (i < 0) return J({ error: '找不到這張核准單。' }, 404);
    if (method === 'DELETE') {
      const [gone] = appr.splice(i, 1);
      if (gone.h && String(gone.img || '').startsWith('api/img/') && !appr.some(x => x.h === gone.h)) await env.DB.delete('img:' + gone.h);
    } else {
      const body = await req.json();
      for (const k of ['t', 'm', 'mod', 'a', 'f', 'p', 'old', 'note', 'gas']) if (k in body) appr[i][k] = body[k];
    }
    await putPart(env, 'appr', appr);
    return J({ ok: true });
  }

  if (path === '/api/book' && method === 'POST') {
    const { rows, areas, source } = await req.json();
    if (!Array.isArray(rows) || !rows.length || !Array.isArray(areas) || !areas.length) return J({ error: '族譜資料是空的。' }, 400);
    const book = await getPart(env, req, 'book');
    const keep = book.filter(r => !areas.some(ar => String(r[3]).startsWith(ar + '/')));
    const merged = keep.concat(rows);
    await putPart(env, 'book', merged);
    const meta = await getPart(env, req, 'meta');
    meta.book = meta.book || {};
    for (const ar of areas) meta.book[ar] = { date: new Date().toISOString(), source: source || '' };
    meta.seed = false;
    await putPart(env, 'meta', meta);
    return J({ ok: true, total: merged.length });
  }


  return J({ error: '找不到這個功能。' }, 404);
}

// ── 廠區分開：后里 F16 沿用原本的資料（不加前綴）；銅鑼廠（TL）的資料都存在「TL/」底下
const PLANTS = { F16: '', TL: 'TL/' };
function plantOf(req, url) {
  const p = String(req.headers.get('x-plant') || url.searchParams.get('p') || 'F16').toUpperCase();
  return p in PLANTS ? p : 'F16';
}
function prefixedKV(kv, pre) {
  if (!pre || !kv) return kv;
  return {
    get: (k, o) => kv.get(pre + k, o),
    getWithMetadata: (k, o) => kv.getWithMetadata(pre + k, o),
    put: (k, v, o) => kv.put(pre + k, v, o),
    delete: k => kv.delete(pre + k),
    list: async (o = {}) => {
      const r = await kv.list({ ...o, prefix: pre + (o.prefix || '') });
      return { ...r, keys: r.keys.map(x => ({ ...x, name: x.name.slice(pre.length) })) };
    },
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        const plant = plantOf(req, url);
        env = { ...env, PLANT: plant, DB: prefixedKV(env.DB, PLANTS[plant]) };
        return await api(req, env, url);
      } catch (e) {
        return J({ error: '伺服器錯誤：' + (e && e.message ? e.message : String(e)) }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
