// ==UserScript==
// @name         Hikidashi: DMM マイライブラリを CSV に書き出す
// @description  購入済みの同人作品（ボイス・コミック・CG）を、Hikidashi（iOS アプリ）に取り込める CSV にする。iPhone の Safari + Userscripts 用。
// @version      0.1.0
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
    ...rows.map((r) => [r.title, r.url, r.creators.join('|'), r.thumbnail, r.category, '', '', ''].map(q).join(','))].join('\n') + '\n';

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

  const dedupe = (names) => { const seen = new Set(); return names.filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())); };

  // ---- 一覧の読み取り ----
  // class 名の末尾（例: UX4x_）は DMM のビルドごとに変わるので、前方一致で探す。
  const itemEls = () => document.querySelectorAll('[class*="localListProduct"]');

  function readItem(el) {
    const genre = (el.querySelector('[class*="listRightHeaderGenre"] span, [class*="defaultClass"]')?.textContent || '').trim();
    if (!GENRES.includes(genre)) return null;
    const a = el.querySelector('a[href*="product_id="]');
    const title = (el.querySelector('[class*="productTitle"] p')?.textContent || '').trim();
    const id = (a?.getAttribute('href') || '').match(/product_id=(\w+)/)?.[1];
    if (!id || !title) return null;
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
    <div id="hk-btns" style="display:flex;gap:8px;flex-wrap:wrap"></div>`;
  document.body.appendChild(panel);
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

  const loadKnown = () => { try { return new Set(JSON.parse(localStorage.getItem(KNOWN_KEY) || '[]')); } catch { return new Set(); } };
  const saveKnown = (ids) => { try { localStorage.setItem(KNOWN_KEY, JSON.stringify([...ids])); } catch { /* 保存できなくても続ける */ } };

  // ---- 本体 ----
  async function run(onlyNew) {
    running = true; cancelled = false;
    await keepAwake();
    const known = onlyNew ? loadKnown() : new Set();
    const results = new Map();
    const started = Date.now();
    setButtons(btn('中止', () => { cancelled = true; }, false));
    setProgress(0);

    // 1) 一覧を、最後まで（または前回の続きまで）読み込む
    let prev = itemEls().length, stalled = 0, reachedKnown = false;
    const collect = () => {
      for (const el of itemEls()) {
        const it = readItem(el);
        if (!it || results.has(it.id)) continue;
        if (known.has(it.id)) { reachedKnown = true; return true; }
        results.set(it.id, it);
      }
      return false;
    };
    while (!cancelled) {
      if (collect()) break;
      setMsg(`一覧を読み込み中… ${results.size} 件（経過 ${fmtDuration((Date.now() - started) / 1000)}）\nこの画面を開いたままにしてください。`);
      const loader = document.querySelector('[class*="ajaxArea"],[class*="loadingIcon"]');
      if (loader) loader.scrollIntoView({ block: 'center' });
      window.scrollTo(0, document.documentElement.scrollHeight);
      let grew = false;
      for (let t = 0; t < 40 && !cancelled; t++) {            // 新しい作品が増えるまで最大 20 秒待つ
        await delay(500);
        const c = itemEls().length;
        if (c > prev) { prev = c; grew = true; break; }
        if (t % 6 === 5) { window.scrollBy(0, -200); window.scrollTo(0, document.documentElement.scrollHeight); }
      }
      if (grew) stalled = 0; else if (++stalled >= 2) break;
    }
    collect();
    if (cancelled) return finish('中止しました。', null);

    const items = [...results.values()];
    if (!items.length) {
      return finish(onlyNew && reachedKnown ? '新しい作品はありませんでした。' : `作品が見つかりませんでした（画面の作品は ${itemEls().length} 件）。`, null);
    }

    // 2) 声優・作者を、詳細ページから取る（同時に CONCURRENCY 件）
    let next = 0, done = 0, spent = 0;
    const t0 = Date.now();
    const worker = async () => {
      while (!cancelled) {
        const i = next++;
        if (i >= items.length) return;
        const s = Date.now();
        try {
          const res = await fetch(items[i].url, { credentials: 'include' });
          items[i].cv = res.ok ? parseDetailCreators(await res.text()) : [];
        } catch { items[i].cv = []; }
        spent += Date.now() - s; done++;
        const avg = spent / done / CONCURRENCY;                 // 1 件あたりの実質の時間
        setProgress(done / items.length);
        setMsg(`声優・作者を取得中… ${done} / ${items.length} 件\n残り ${fmtDuration((items.length - done) * avg / 1000)}\nこの画面を開いたままにしてください。`);
        await delay(GAP_MS);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    if (cancelled) return finish('中止しました。', null);

    // 3) CSV を作る
    const rows = items.map((it) => ({
      title: it.title, url: it.url, creators: dedupe([...(it.circle ? [it.circle] : []), ...it.cv]), thumbnail: it.thumbnail, category: it.genre,
    }));
    const csv = buildCSV(rows);
    const all = loadKnown(); items.forEach((it) => all.add(it.id)); saveKnown(all);
    const d = new Date();
    const filename = `doujin-library-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.csv`;
    finish(`完了！${items.length} 件を取得しました（${fmtDuration((Date.now() - started) / 1000)}）。\n下のボタンで保存し、Hikidashi の「設定 → CSV をインポート」で選んでください。`, { csv, filename });
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

  setMsg('マイライブラリを CSV にします。初回は「全件を取得」、2 回目以降は「新着だけ」が速いです。');
  setButtons(btn('全件を取得', () => run(false)), btn('新着だけ', () => run(true), false));
})();
