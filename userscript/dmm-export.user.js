// ==UserScript==
// @name         Hikidashi: DMM マイライブラリを CSV に書き出す
// @description  購入済みの同人作品（ボイス・コミック・CG）を、Hikidashi（iOS アプリ）に取り込める CSV にする。iPhone の Safari + Userscripts 用。
// @version      0.4.0
// @homepageURL  https://github.com/nemog9/dmm-doujin-exporter
// @downloadURL  https://raw.githubusercontent.com/nemog9/dmm-doujin-exporter/main/userscript/dmm-export.user.js
// @updateURL    https://raw.githubusercontent.com/nemog9/dmm-doujin-exporter/main/userscript/dmm-export.user.js
// @match        https://www.dmm.co.jp/dc/-/mylibrary/*
// @run-at       document-idle
// @noframes
// ==/UserScript==

// 非公式のツールです。自分の購入履歴を、自分のブラウザの中だけで処理して、CSV にします。外部には何も送りません。
// 処理の中身は、Chrome 拡張（background.js / csv.js）と同じです。ここは、1 ファイルで動かすため、必要な部分を写しています。

(() => {
  'use strict';
  if (window.__hikidashiDmmExport) return;
  window.__hikidashiDmmExport = true;

  const GENRES = ['ボイス', 'コミック', 'CG', '動画'];
  const CONCURRENCY = 3;          // 詳細ページを同時に取る数（DMM に負荷をかけすぎない）
  const GAP_MS = 250;             // 1 本が終わってから、次を始めるまでの間隔
  const KNOWN_KEY = 'hikidashi.dmmexport.known';
  const HEADER = ['title', 'url', 'creators', 'thumbnail_url', 'category', 'note', 'favorite', 'hidden'];

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');

  // ---- CSV（csv.js と同じ内容） ----
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const buildCSV = (rows) => '﻿' + [HEADER.map(q).join(','),
    ...rows.map((r) => [r.title, r.url, r.creators.join('|'), r.thumbnail, r.category, r.note || '', r.favorite || '', r.hidden || ''].map(q).join(','))].join('\n') + '\n';

  const decodeEntities = (s) => s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d));

  function parseDetailCreators(html) {
    const found = { 声優: [], 作者: [] };
    const names = (block) => [...block.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim()).filter(Boolean);
    for (const m of html.matchAll(/<dt\b[^>]*>\s*(声優|作者)\s*<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
      if (!found[m[1]].length) found[m[1]] = names(m[2]);
    }
    if (!found.声優.length && !found.作者.length) {
      for (const m of html.matchAll(/class="informationList__ttl"[^>]*>\s*(声優|作者)\s*<[\s\S]*?class="informationList__txt"[^>]*>([\s\S]*?)<\/(?:dd|div|p)>/gi)) {
        if (!found[m[1]].length) found[m[1]] = names(m[2]);
      }
    }
    return found.声優.length ? found.声優 : found.作者;
  }

  /** RFC 4180: 引用符内の改行・"" エスケープ・CRLF に対応。空行は捨てる。（csv.js と同じ） */
  function parseCSV(text) {
    text = text.replace(/^\ufeff/, '');
    const rows = [];
    let row = [], field = '', inQuotes = false;
    const endField = () => { row.push(field); field = ''; };
    const endRow = () => { endField(); if (!(row.length === 1 && row[0] === '')) rows.push(row); row = []; };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') endField();
      else if (ch === '\r') { endRow(); if (text[i + 1] === '\n') i++; }
      else if (ch === '\n') endRow();
      else field += ch;
    }
    if (field !== '' || row.length) endRow();
    return rows;
  }

  const norm = (s) => (s || '').trim().toLowerCase();
  const ALIASES = {
    title: ['title', 'タイトル'], url: ['url'], creators: ['creators', 'クリエイター'],
    circle: ['サークル名', 'サークル', 'circle'], cv: ['声優', '作者', 'cv', 'actors'],
    thumbnail: ['thumbnail_url', 'thumbnail', 'サムネイル'], category: ['category', 'ジャンル', 'カテゴリ'],
    note: ['note', 'メモ'], favorite: ['favorite', 'お気に入り'], hidden: ['hidden', '非表示'],
  };
  const splitNames = (s) => (s || '').split(/[|｜,，、;；]/).map((x) => x.trim()).filter(Boolean);
  const flag = (v) => { const t = norm(v); return ['1', 'true', 'yes', 'y', '○', 'はい'].includes(t) ? '1' : ['0', 'false', 'no', 'n'].includes(t) ? '0' : ''; };
  const productId = (url) => (url || '').match(/(?:product_id|cid)=(\w+)/)?.[1] || '';
  const detailURL = (id) => `https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=${id}/`;
  const normalizeURL = (url) => {
    const u = (url || '').trim();
    return /dmm\.co\.jp\/dc\/-\/mylibrary\/detail\//.test(u) && productId(u) ? detailURL(productId(u)) : u;
  };

  /** 前回の CSV（Hikidashi の書き出し、または旧形式）→ 作品の配列。（csv.js の readItems と同じ） */
  function readItems(text) {
    const rows = parseCSV(text);
    if (!rows.length) return [];
    const header = rows[0].map(norm);
    const col = (key) => header.findIndex((h) => ALIASES[key].map(norm).includes(h));
    const idx = Object.fromEntries(Object.keys(ALIASES).map((k) => [k, col(k)]));
    if (idx.url < 0) return [];
    const get = (r, k) => (idx[k] >= 0 && idx[k] < r.length ? r[idx[k]] : '');
    return rows.slice(1).filter((r) => get(r, 'url')).map((r) => ({
      title: get(r, 'title').trim(), url: normalizeURL(get(r, 'url')),
      creators: dedupe([...splitNames(get(r, 'creators')), ...splitNames(get(r, 'circle')), ...splitNames(get(r, 'cv'))]),
      thumbnail: get(r, 'thumbnail').trim(), category: get(r, 'category').trim(),
      note: get(r, 'note'), favorite: flag(get(r, 'favorite')), hidden: flag(get(r, 'hidden')),
    }));
  }

  const dedupe = (names) => { const seen = new Set(); return names.filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())); };

  // ---- 一覧の読み取り ----
  // class 名の末尾（例: UX4x_）は DMM のビルドごとに変わるので、前方一致で探す。
  const itemEls = () => document.querySelectorAll('[class*="localListProduct"]');

  function readItem(el) {
    // 戻り値: 作品 = 取り込む / null = 対象外のジャンル（二度と見ない） / undefined = まだ描画が終わっていない（あとでもう一度見る）
    const genre = (el.querySelector('[class*="listRightHeaderGenre"] span, [class*="defaultClass"]')?.textContent || '').trim();
    if (!genre) return undefined;
    if (!GENRES.includes(genre)) return null;
    const a = el.querySelector('a[href*="product_id="]');
    const title = (el.querySelector('[class*="productTitle"] p')?.textContent || '').trim();
    const id = (a?.getAttribute('href') || '').match(/product_id=(\w+)/)?.[1];
    if (!id || !title) return undefined;
    const circle = (el.querySelector('[class*="circleName"]')?.textContent || '').trim();
    const imgSrc = el.querySelector('img')?.src || '';
    const type = imgSrc.match(/doujin-assets\.dmm\.co\.jp\/digital\/(\w+)\//)?.[1];
    return {
      id, title, circle, genre,
      url: `https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=${id}/`,
      thumbnail: type ? `https://doujin-assets.dmm.co.jp/digital/${type}/${id}/${id}pr.jpg` : imgSrc,
      cv: [],
    };
  }

  // ---- 画面 ----
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:8px;right:8px;bottom:12px;z-index:2147483647;background:#fff;color:#1c1c1e;border:2px solid #ed7305;border-radius:14px;padding:12px;font:14px/1.45 -apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)';
  panel.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px">Hikidashi 書き出し</div>
    <div id="hk-msg" style="margin-bottom:8px">マイライブラリを CSV にします。</div>
    <div id="hk-bar" style="height:8px;background:#eee;border-radius:4px;overflow:hidden;margin-bottom:10px"><div id="hk-fill" style="height:100%;width:0;background:#ed7305"></div></div>
    <div id="hk-csv" style="margin-bottom:8px;font-size:13px;color:#555"></div>
    <div id="hk-btns" style="display:flex;gap:8px;flex-wrap:wrap"></div>
    <input id="hk-file" type="file" accept=".csv,text/csv,text/plain,text/comma-separated-values" style="display:none">`;
  const style = document.createElement('style');
  style.textContent = '@keyframes hk-slide{0%{margin-left:-35%}100%{margin-left:100%}}#hk-fill.hk-ind{width:35%!important;animation:hk-slide 1.2s linear infinite}';
  panel.appendChild(style);
  document.body.appendChild(panel);

  // 一覧ページ（/dc/-/mylibrary/）でだけ表示する。作品詳細（/dc/-/mylibrary/detail/…）では出さない。
  // DMM は、ページを読み込み直さずに画面を切り替える（SPA）ので、@match だけでは足りず、URL の変化を見て、出し入れする。
  const isListPage = () => /^\/dc\/-\/mylibrary\/?$/.test(location.pathname);
  let wasList = null;
  const syncVisibility = () => {
    const now = isListPage();
    if (now === wasList) return;
    wasList = now;
    panel.style.display = now ? '' : 'none';
    if (!now) cancelled = true;          // 一覧を離れたら、取得は中止する（作品の一覧が、画面から消えるため）
  };
  const $ = (id) => panel.querySelector('#' + id);

  const setMsg = (t) => { $('hk-msg').textContent = t; };
  const setProgress = (r) => { $('hk-fill').style.width = `${Math.round(Math.max(0, Math.min(1, r)) * 100)}%`; };
  const btn = (label, onClick, primary = true) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `padding:10px 14px;border-radius:10px;border:${primary ? '0' : '1px solid #ed7305'};background:${primary ? '#ed7305' : '#fff'};color:${primary ? '#fff' : '#ed7305'};font-weight:700;font-size:14px`;
    b.addEventListener('click', onClick);
    return b;
  };
  const setButtons = (...bs) => { const c = $('hk-btns'); c.textContent = ''; bs.forEach((b) => c.appendChild(b)); };

  const fmtDuration = (sec) => {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `約 ${sec} 秒`;
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? `約 ${m} 分 ${s} 秒` : `約 ${m} 分`;
  };

  // 画面が消えないようにする（iOS 16.4 以降の Safari で使える）。
  let wakeLock = null;
  const keepAwake = async () => { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 使えなくても続ける */ } };
  document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') keepAwake(); });

  let running = false;
  let cancelled = false;

  // 前回の CSV（任意）。読み込むと、その中の作品は取り直さず、新しい作品だけを足して、お気に入り・メモ・非表示は、そのまま保つ。
  let prevRows = [];
  let prevName = '';
  const renderCsvState = () => {
    const el = $('hk-csv');
    el.textContent = '';
    const chooser = btn(prevRows.length ? '前回の CSV を選び直す' : '前回の CSV を選ぶ（任意）', () => $('hk-file').click(), false);
    chooser.style.padding = '6px 10px'; chooser.style.fontSize = '13px';
    el.appendChild(chooser);
    const label = document.createElement('span');
    label.style.marginLeft = '8px';
    label.textContent = prevRows.length ? `${prevName}（${prevRows.length} 件）` : '選ぶと、新しい作品だけを足して、お気に入りなども保てます。';
    el.appendChild(label);
  };
  $('hk-file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      prevRows = readItems(await f.text());
      prevName = f.name;
      if (!prevRows.length) setMsg('この CSV から作品（url 列）を読み取れませんでした。');
    } catch { prevRows = []; setMsg('CSV を読み込めませんでした。'); }
    e.target.value = '';
    renderCsvState();
  });

  const loadKnown = () => { try { return new Set(JSON.parse(localStorage.getItem(KNOWN_KEY) || '[]')); } catch { return new Set(); } };
  const saveKnown = (ids) => { try { localStorage.setItem(KNOWN_KEY, JSON.stringify([...ids])); } catch { /* 保存できなくても続ける */ } };

  // ---- 進み具合の表示（1 秒ごとに更新するので、待っている間も止まって見えない） ----
  const state = { phase: 'idle', started: 0, listCount: 0, stalled: 0, waitLeft: 0, done: 0, total: 0, detailStart: 0 };
  let ticker = null;
  const render = () => {
    const elapsed = (Date.now() - state.started) / 1000;
    const dots = '.'.repeat(1 + (Math.floor(Date.now() / 1000) % 3));
    const fill = $('hk-fill');
    if (state.phase === 'list') {
      fill.classList.add('hk-ind');
      let t = `一覧を読み込み中${dots} ${state.listCount} 件\n経過 ${fmtDuration(elapsed)}`;
      if (state.stalled > 0) t += `\nしばらく増えていません。最後まで読み込めたか確認しています（${state.stalled} / 2 回目、あと最大 ${Math.ceil(state.waitLeft)} 秒）`;
      setMsg(t + '\nこの画面を開いたままにしてください。');
    } else if (state.phase === 'prepare') {
      fill.classList.add('hk-ind');
      setMsg(`一覧の読み込みが終わりました。${state.total} 件の声優・作者を取得する準備をしています${dots}`);
    } else if (state.phase === 'detail') {
      fill.classList.remove('hk-ind');
      setProgress(state.total ? state.done / state.total : 0);
      // 実際に経過した時間から、1 件あたりの実質の時間を出す（待ち時間・並行数を含む）。
      const perItem = state.done ? (Date.now() - state.detailStart) / state.done : 0;
      const remain = state.done >= 5 ? `残り ${fmtDuration((state.total - state.done) * perItem / 1000)}` : '残り時間を計測中…';
      setMsg(`声優・作者を取得中${dots} ${state.done} / ${state.total} 件\n${remain}（経過 ${fmtDuration(elapsed)}）\nこの画面を開いたままにしてください。`);
    }
  };
  const startTicker = () => { stopTicker(); ticker = setInterval(render, 1000); };
  const stopTicker = () => { if (ticker) clearInterval(ticker); ticker = null; $('hk-fill').classList.remove('hk-ind'); };

  // ---- 本体 ----
  async function run(onlyNew) {
    running = true; cancelled = false;
    await keepAwake();
    const fromCsv = prevRows.length > 0;
    // CSV を読み込んでいれば、その中の作品を「取得済み」とする。なければ、この端末に覚えている ID を使う（「新着だけ」のときのみ）。
    const known = fromCsv ? new Set(prevRows.map((r) => productId(r.url))) : (onlyNew ? loadKnown() : new Set());
    const results = new Map();
    const started = Date.now();
    Object.assign(state, { phase: 'list', started, listCount: 0, stalled: 0, waitLeft: 0, done: 0, total: 0, detailStart: 0 });
    setButtons(btn('中止', () => { cancelled = true; }, false));
    setProgress(0);
    startTicker(); render();

    // 1) 一覧を、最後まで（または前回の続きまで）読み込む
    //    4,000 件を超える一覧でも固まらないよう、読み終えた要素は二度と見ず、一定数ごとに画面へ制御を返す。
    const processed = new WeakSet();
    let prev = itemEls().length, stalled = 0, reachedKnown = false;
    const collect = async () => {
      let n = 0;
      for (const el of itemEls()) {
        if (processed.has(el)) continue;
        const it = readItem(el);
        if (it === undefined) continue;
        processed.add(el);
        if (it && !results.has(it.id)) {
          if (known.has(it.id)) {
            reachedKnown = true;
            if (onlyNew) return true;               // 新着だけ: 最初の取得済みで止める（一覧は新しい順）
          } else {
            results.set(it.id, it);
            state.listCount = results.size;
          }
        }
        if (++n % 200 === 0) await delay(0);
      }
      return false;
    };
    while (!cancelled) {
      if (await collect()) break;
      const loader = document.querySelector('[class*="ajaxArea"],[class*="loadingIcon"]');
      if (loader) loader.scrollIntoView({ block: 'center' });
      window.scrollTo(0, document.documentElement.scrollHeight);
      let grew = false;
      for (let t = 0; t < 40 && !cancelled; t++) {            // 新しい作品が増えるまで最大 20 秒待つ
        state.waitLeft = (40 - t) * 0.5;
        await delay(500);
        const c = itemEls().length;
        if (c > prev) { prev = c; grew = true; break; }
        if (t % 6 === 5) { window.scrollBy(0, -200); window.scrollTo(0, document.documentElement.scrollHeight); }
      }
      if (grew) { stalled = 0; state.stalled = 0; } else { state.stalled = ++stalled; if (stalled >= 2) break; }
    }
    await collect();
    if (cancelled) { stopTicker(); return finish('中止しました。', null); }

    const items = [...results.values()];
    if (!items.length) {
      stopTicker();
      return finish(onlyNew && reachedKnown ? '新しい作品はありませんでした。' : `作品が見つかりませんでした（画面の作品は ${itemEls().length} 件）。`, null);
    }

    // 2) 声優・作者を、詳細ページから取る（同時に CONCURRENCY 件）
    Object.assign(state, { phase: 'prepare', total: items.length });
    render();
    await delay(50);
    Object.assign(state, { phase: 'detail', done: 0, detailStart: Date.now() });
    render();
    let next = 0;
    const worker = async () => {
      while (!cancelled) {
        const i = next++;
        if (i >= items.length) return;
        try {
          const res = await fetch(items[i].url, { credentials: 'include' });
          items[i].cv = res.ok ? parseDetailCreators(await res.text()) : [];
        } catch { items[i].cv = []; }
        state.done++;
        render();
        await delay(GAP_MS);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    stopTicker();
    if (cancelled) return finish('中止しました。', null);

    // 3) CSV を作る
    const fresh = items.map((it) => ({
      title: it.title, url: it.url, creators: dedupe([...(it.circle ? [it.circle] : []), ...it.cv]), thumbnail: it.thumbnail, category: it.genre,
    }));
    // 既存の行はそのまま先頭に。新規分は、取得順（新しい購入が先頭）の逆順にして末尾へ（Hikidashi は行の順に番号を振るので、最後に買ったものが一番上に来る）。
    const rows = [...prevRows, ...fresh.slice().reverse()];
    const csv = buildCSV(rows);
    const all = loadKnown(); items.forEach((it) => all.add(it.id)); saveKnown(all);
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const base = prevName ? prevName.replace(/\.csv$/i, '').replace(/-\d{8}-\d{6}$/, '') : 'doujin-library';
    const filename = `${base}-${stamp}.csv`;
    finish(`完了！新しい作品 ${items.length} 件を取得しました${prevRows.length ? `（前回の ${prevRows.length} 件と合わせて計 ${rows.length} 件）` : ''}（${fmtDuration((Date.now() - started) / 1000)}）。\n下のボタンで保存し、Hikidashi の「設定 → CSV をインポート」で選んでください。`, { csv, filename });
  }

  function finish(message, file) {
    running = false;
    try { wakeLock?.release(); } catch { /* 無視 */ }
    setMsg(message);
    setProgress(file ? 1 : 0);
    const buttons = [];
    if (file) {
      const blob = new Blob([file.csv], { type: 'text/csv;charset=utf-8' });
      buttons.push(btn('CSV を保存', () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = file.filename;
        document.body.appendChild(a); a.click(); a.remove();
      }));
      if (navigator.canShare?.({ files: [new File([blob], file.filename, { type: 'text/csv' })] })) {
        buttons.push(btn('共有…', () => navigator.share({ files: [new File([blob], file.filename, { type: 'text/csv' })] }).catch(() => {}), false));
      }
    }
    buttons.push(btn('全件を取得', () => run(false), !file), btn('新着だけ', () => run(true), false));
    setButtons(...buttons);
  }

  syncVisibility();
  setInterval(syncVisibility, 400);
  window.addEventListener('popstate', syncVisibility);
  renderCsvState();
  setMsg('マイライブラリを CSV にします。初回は「全件を取得」、2 回目以降は、前回の CSV を選んで「新着だけ」が速いです。');
  setButtons(btn('全件を取得', () => run(false)), btn('新着だけ', () => run(true), false));
})();
