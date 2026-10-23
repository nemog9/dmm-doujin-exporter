// ==UserScript==
// @name         DMM マイライブラリ 診断（iPhone 版の画面構造を調べる）
// @description  画面の構造だけを集めて、JSON として保存・コピーする。作品名などの個人情報は、先頭の数件の要素に限り、含まれる。
// @version      0.2.0
// @match        https://www.dmm.co.jp/dc/-/mylibrary/*
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // class 名の末尾は、DMM のビルドごとに変わる（例: localListProductUX4x_）。前方一致と構造で探す。
  const SEL = {
    anchor: 'a[href*="/mylibrary/detail/=/product_id="]',
    item: '[class*="localListProduct"]',
    genre: '[class*="listRightHeaderGenre"] span',
    title: '[class*="productTitle"] p',
    circle: '[class*="circleName"]',
    loader: '[class*="ajaxArea"],[class*="loadingIcon"]',
  };
  const count = () => document.querySelectorAll(SEL.anchor).length;
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
    const report = { script: 'probe 0.2.0', at: new Date().toISOString() };
    report.page = {
      url: location.href.replace(/[?#].*$/, ''),   // クエリは含めない
      userAgent: navigator.userAgent,
      viewport: [innerWidth, innerHeight],
      docHeight: document.documentElement.scrollHeight,
    };

    // 1) 既存のセレクタが、この画面で、効くか
    const items = [...document.querySelectorAll(SEL.item)];
    report.selectors = {
      anchor: count(),
      item: items.length,
      genre: document.querySelectorAll(SEL.genre).length,
      title: document.querySelectorAll(SEL.title).length,
      circle: document.querySelectorAll(SEL.circle).length,
      loader: document.querySelectorAll(SEL.loader).length,
    };
    report.genres = [...new Set([...document.querySelectorAll(SEL.genre)].map((el) => el.textContent.trim()).filter(Boolean))];

    // 2) 作品 1 件ぶんの HTML（先頭 2 件。長すぎる部分は切る）
    const anchors = [...document.querySelectorAll(SEL.anchor)];
    report.firstItemsHTML = (items.length ? items : anchors.map((a) => a.closest('li, article, div') || a)).slice(0, 2).map((el) => clip(el.outerHTML));
    report.firstAnchorAncestors = anchors.slice(0, 2).map((a) => chain(a));

    // 3) 一覧の続きの読み込み方（自動で増えるか、ボタンか）
    const buttons = [...document.querySelectorAll('button, a')].filter((el) => /もっと|さらに|次へ|続き|more/i.test(el.textContent || '') && el.offsetParent !== null);
    report.loadMoreButtons = buttons.slice(0, 5).map((b) => ({ tag: b.tagName, text: b.textContent.trim().slice(0, 30), classes: String(b.className) }));
    const before = count();
    const loaderEl = document.querySelector(SEL.loader);
    if (loaderEl) loaderEl.scrollIntoView({ block: 'center' });
    window.scrollTo(0, document.documentElement.scrollHeight);
    let waited = 0;
    for (let i = 0; i < 40; i++) {                       // 最大 20 秒、増えるのを待つ
      await delay(500); waited += 500;
      if (count() > before) break;
      if (i % 6 === 5) { window.scrollBy(0, -200); window.scrollTo(0, document.documentElement.scrollHeight); }
    }
    report.scrollLoad = { before, after: count(), grewByScrolling: count() > before, waitedMs: waited, hadLoaderElement: !!loaderEl };

    // 4) 詳細ページから声優・作者が取れるか（先頭 1 件を、この画面と同じ条件で、取得）
    const id = (anchors[0]?.href.match(/product_id=(\w+)/) || [])[1];
    if (id) {
      const detailUrl = `https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=${id}/`;
      try {
        const res = await fetch(detailUrl);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        // ラベル（声優・作者・サークル名）の周りの構造を、HTML の文字列と、DOM の両方から出す。
        const around = (word, n = 700) => {
          const out = [];
          let from = 0;
          for (let k = 0; k < 3; k++) {
            const i = html.indexOf(word, from);
            if (i < 0) break;
            out.push(html.slice(Math.max(0, i - n / 2), i + n / 2));
            from = i + word.length;
          }
          return out;
        };
        const labelParents = (word) => [...doc.querySelectorAll('dt, th, span, div, p, h2, h3, li')]
          .filter((el) => el.children.length === 0 && el.textContent.trim() === word)
          .slice(0, 2)
          .map((el) => ({ chain: chain(el, 5), parentHTML: clip((el.parentElement || el).outerHTML, 900) }));
        const scripts = [...doc.querySelectorAll('script')].filter((el) => /声優|作者/.test(el.textContent));
        report.detail = {
          status: res.status,
          finalUrl: res.url.replace(/[?#].*$/, ''),
          htmlLength: html.length,
          oldSelectorLists: doc.querySelectorAll('.informationList').length,
          htmlAround: { '声優': around('声優'), '作者': around('作者') },
          domLabelParents: { '声優': labelParents('声優'), '作者': labelParents('作者'), 'サークル名': labelParents('サークル名') },
          scriptsContainingLabels: scripts.slice(0, 2).map((el) => ({ type: el.type || '', id: el.id || '', snippet: clip(el.textContent.slice(Math.max(0, el.textContent.search(/声優|作者/) - 300)), 900) })),
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
