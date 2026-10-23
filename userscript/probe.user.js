// ==UserScript==
// @name         DMM マイライブラリ 診断（iPhone 版の画面構造を調べる）
// @description  画面の構造だけを集めて、JSON として保存・コピーする。作品名などの個人情報は、先頭の数件の要素に限り、含まれる。
// @version      0.1.0
// @match        https://www.dmm.co.jp/dc/-/mylibrary/*
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const SEL = {
    item: '.localListProductzKID2',
    genre: '.defaultClassmE6be',
    title: '.productTitleCMVya p',
    circle: '.circleNameGWNom',
    loader: '.ajaxAreaxcTPC,.loadingIconmW5s8',
  };
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const clip = (s, n = 2500) => (s.length > n ? s.slice(0, n) + `…(+${s.length - n}文字)` : s);

  // 見やすいボタンを右下に出す（押したときにだけ実行する）。
  const btn = document.createElement('button');
  btn.textContent = '診断を実行';
  btn.style.cssText = 'position:fixed;right:12px;bottom:80px;z-index:2147483647;padding:12px 16px;border-radius:12px;border:0;background:#ed7305;color:#fff;font-weight:700;font-size:15px;box-shadow:0 2px 8px rgba(0,0,0,.3)';
  document.body.appendChild(btn);

  const out = document.createElement('div');
  out.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:2147483647;max-height:45vh;overflow:auto;background:#fff;color:#000;border:2px solid #ed7305;border-radius:10px;padding:10px;font:12px/1.4 monospace;display:none;white-space:pre-wrap';
  document.body.appendChild(out);
  const say = (t) => { out.style.display = 'block'; out.textContent = t; };

  // 親をたどって、タグ名・class・data 属性だけを短く並べる（構造の把握用）。
  const chain = (el, depth = 6) => {
    const parts = [];
    for (let e = el; e && depth-- > 0; e = e.parentElement) {
      parts.push(`${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : ''}`);
    }
    return parts;
  };

  async function run() {
    const report = { script: 'probe 0.1.0', at: new Date().toISOString() };
    report.page = {
      url: location.href.replace(/[?#].*$/, ''),   // クエリは含めない
      userAgent: navigator.userAgent,
      viewport: [innerWidth, innerHeight],
      docHeight: document.documentElement.scrollHeight,
    };

    // 1) 既存のセレクタが、この画面で、効くか
    const items = [...document.querySelectorAll(SEL.item)];
    report.selectors = {
      item: items.length,
      genre: document.querySelectorAll(SEL.item + ' ' + SEL.genre).length,
      title: document.querySelectorAll(SEL.item + ' ' + SEL.title).length,
      circle: document.querySelectorAll(SEL.item + ' ' + SEL.circle).length,
      loader: document.querySelectorAll(SEL.loader).length,
      anchorsWithProductId: document.querySelectorAll('a[href*="product_id="]').length,
    };
    report.genres = [...new Set(items.map((el) => el.querySelector(SEL.genre)?.textContent.trim()).filter(Boolean))];

    // 2) 作品 1 件ぶんの HTML（先頭 2 件。長すぎる部分は切る）
    const anchors = [...document.querySelectorAll('a[href*="product_id="]')];
    report.firstItemsHTML = (items.length ? items : anchors.map((a) => a.closest('li, article, div') || a)).slice(0, 2).map((el) => clip(el.outerHTML));
    report.firstAnchorAncestors = anchors.slice(0, 2).map((a) => chain(a));

    // 3) 一覧の続きの読み込み方（自動で増えるか、ボタンか）
    const buttons = [...document.querySelectorAll('button, a')].filter((el) => /もっと|さらに|次へ|続き|more/i.test(el.textContent || '') && el.offsetParent !== null);
    report.loadMoreButtons = buttons.slice(0, 5).map((b) => ({ tag: b.tagName, text: b.textContent.trim().slice(0, 30), classes: String(b.className) }));
    const before = document.querySelectorAll(SEL.item).length;
    window.scrollTo(0, document.documentElement.scrollHeight);
    for (let i = 0; i < 20; i++) {                       // 最大 10 秒、増えるのを待つ
      await delay(500);
      if (document.querySelectorAll(SEL.item).length > before) break;
    }
    report.scrollLoad = { before, after: document.querySelectorAll(SEL.item).length, grewByScrolling: document.querySelectorAll(SEL.item).length > before };

    // 4) 詳細ページから声優・作者が取れるか（先頭 1 件を、この画面と同じ条件で、取得）
    const id = (anchors[0]?.href.match(/product_id=(\w+)/) || [])[1];
    if (id) {
      const detailUrl = `https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=${id}/`;
      try {
        const res = await fetch(detailUrl);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const lists = [...doc.querySelectorAll('.informationList')];
        report.detail = {
          status: res.status,
          finalUrl: res.url.replace(/[?#].*$/, ''),
          htmlLength: html.length,
          informationListCount: lists.length,
          informationLists: lists.slice(0, 6).map((el) => clip(el.outerHTML, 1200)),
          labelsFound: [...doc.querySelectorAll('.informationList__ttl')].map((el) => el.textContent.trim()),
          // 予備: ラベルの語が、別の構造にあるか
          bodyHasLabels: ['声優', '作者', 'サークル名'].map((w) => [w, html.includes(w)]),
        };
      } catch (e) {
        report.detail = { error: String(e) };
      }
    } else {
      report.detail = { note: '作品へのリンク（product_id）が見つからなかった' };
    }
    return report;
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = '調べています…（約 15 秒）';
    let report;
    try { report = await run(); } catch (e) { report = { error: String(e), stack: String(e.stack || '').slice(0, 500) }; }
    const text = JSON.stringify(report, null, 2);
    // ファイルとして保存（確認ダイアログが出たら「ダウンロード」）
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = 'dmm-probe.json';
      document.body.appendChild(a); a.click(); a.remove();
    } catch { /* 保存できなくても、下の表示から、コピーできる */ }
    try { await navigator.clipboard.writeText(text); } catch { /* 許可されなければ、画面の文字を、手で、コピーする */ }
    say('完了。dmm-probe.json を保存しました（コピー済みの場合もあります）。\n\n' + clip(text, 3000));
    btn.textContent = '診断を実行（もう一度）'; btn.disabled = false;
  });
})();
