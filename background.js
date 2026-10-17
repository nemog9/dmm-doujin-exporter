importScripts('csv.js');

const saveProgress = (data) => chrome.storage.local.set({ progress: data });

const initialProgress = () => ({
  phase: 'idle',
  collected: 0,
  cvCurrent: 0,
  cvTotal: 0,
  currentTitle: '',
  message: '',
  error: '',
});

async function scrapeLibrary(existingIds, limit, fullScan) {
  const existingSet = new Set(existingIds);
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const results = new Map();

  const extract = () => {
    const els = document.querySelectorAll('.localListProductzKID2');
    for (const el of els) {
      if (limit > 0 && results.size >= limit) return false;
      const genre = el.querySelector('.defaultClassmE6be');
      const genreText = genre?.textContent.trim() ?? '';
      if (!['ボイス', 'コミック', 'CG', '動画'].includes(genreText)) continue;
      const a = el.querySelector('a[href]');
      const titleEl = el.querySelector('.productTitleCMVya p');
      const circleEl = el.querySelector('.circleNameGWNom');
      const imgEl = el.querySelector('img');
      if (!a || !titleEl) continue;
      const match = a.href.match(/product_id=([\w]+)/);
      if (!match) continue;
      const id = match[1];
      if (existingSet.has(id)) {
        if (!fullScan) return true; // default: stop on first duplicate
        continue;
      }
      if (results.has(id)) continue;
      const title = titleEl.textContent.trim();
      const circle = circleEl?.textContent.trim() ?? '';
      const url = a.href;
      const imgSrc = imgEl?.src ?? '';
      const typeMatch = imgSrc.match(/doujin-assets\.dmm\.co\.jp\/digital\/(\w+)\//);
      const thumbnail = typeMatch
        ? `https://doujin-assets.dmm.co.jp/digital/${typeMatch[1]}/${id}/${id}pr.jpg`
        : imgSrc;
      // 出力する URL は作品詳細ページ（購入済みページではない）。
      results.set(id, { title, circle, url: `https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=${id}/`, thumbnail, cv: [], genre: genreText });
    }
    return false;
  };

  const count = () => document.querySelectorAll('.localListProductzKID2').length;
  const loadMoreButton = () => [...document.querySelectorAll('button, a')]
    .find(el => /もっと見る|さらに表示|もっと表示/.test(el.textContent || '') && el.offsetParent !== null);

  let prevTotal = count();
  let stalled = 0;
  let reason = '';

  while (true) {
    if (limit > 0 && results.size >= limit) { reason = '取得件数の上限に達した'; break; }
    if (extract()) { reason = '既存の作品に到達した（重複検知）'; break; }

    // 続きの読み込みを促す: 読み込み中の表示まで移動し、ページ最下部へもスクロールし、「もっと見る」があれば押す。
    const loader = document.querySelector('.ajaxAreaxcTPC,.loadingIconmW5s8');
    if (loader) loader.scrollIntoView({ block: 'center' });
    window.scrollTo(0, document.documentElement.scrollHeight);
    loadMoreButton()?.click();

    // 新しい作品が増えるまで最大 20 秒待つ（回線やサーバーが遅くても途中で諦めない）。
    let grew = false;
    for (let t = 0; t < 40; t++) {
      await delay(500);
      const c = count();
      if (c > prevTotal) { prevTotal = c; grew = true; break; }
      if (t % 6 === 5) { window.scrollBy(0, -200); window.scrollTo(0, document.documentElement.scrollHeight); }
    }
    if (grew) stalled = 0;
    else if (++stalled >= 2) { reason = '最後まで読み込んだ（これ以上増えなかった）'; break; }
  }

  return {
    items: [...results.values()].slice(0, limit > 0 ? limit : undefined),
    reason,
    seen: count(),
  };
}

async function fetchCVOnPage(detailUrl) {
  try {
    const res = await fetch(detailUrl);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let cv = [], author = [];
    for (const dl of doc.querySelectorAll('.informationList')) {
      const ttl = dl.querySelector('.informationList__ttl')?.textContent.trim();
      const vals = [...dl.querySelectorAll('.informationList__txt a')].map(a => a.textContent.trim()).filter(Boolean);
      if (ttl === '声優') cv = vals;
      if (ttl === '作者') author = vals;
    }
    return cv.length ? cv : author;
  } catch { return []; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START') {
    handleStart(msg).catch(err => {
      saveProgress({ ...initialProgress(), phase: 'error', error: err.message });
    });
    sendResponse({ ok: true });
  }
  if (msg.type === 'GET_PROGRESS') {
    chrome.storage.local.get('progress', (data) => {
      sendResponse(data.progress || initialProgress());
    });
    return true;
  }
});

async function handleStart({ existingIds, existingRows, limit, fullScan, inputFilename }) {
  const scrollMsg = fullScan ? '全件探索: 最後までスクロール中...' : 'ライブラリを読み込み中...';
  await saveProgress({ ...initialProgress(), phase: 'scrolling', message: scrollMsg });

  const tabs = await chrome.tabs.query({ url: 'https://www.dmm.co.jp/*' });
  if (!tabs.length) throw new Error('DMMのタブが見つかりません');
  const tabId = tabs[0].id;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: scrapeLibrary,
    args: [existingIds, limit, !!fullScan]
  });
  const { items: newItems, reason, seen } = results[0].result;
  const scanNote = `（ライブラリ ${seen} 件を確認。停止理由: ${reason}）`;
  const existing = existingRows || [];

  if (!newItems || newItems.length === 0) {
    const filename = buildFilename(inputFilename);
    if (existing.length > 0) {
      await downloadCSV(CSVTools.buildCSV(existing), filename);
      await saveProgress({ ...initialProgress(), phase: 'done', collected: 0, message: `新規作品はありませんでした（計${existing.length}件）${scanNote}` });
    } else {
      await saveProgress({ ...initialProgress(), phase: 'done', message: `新規作品はありませんでした${scanNote}`, collected: 0 });
    }
    return;
  }

  for (let i = 0; i < newItems.length; i++) {
    await saveProgress({
      phase: 'fetching_cv',
      collected: newItems.length,
      cvCurrent: i + 1,
      cvTotal: newItems.length,
      currentTitle: newItems[i].title.slice(0, 30),
      message: '',
      error: '',
    });

    const cvResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: fetchCVOnPage,
      args: [newItems[i].url]
    });
    newItems[i].cv = cvResult[0].result ?? [];
    await new Promise(r => setTimeout(r, 500));
  }

  const mergedRows = [
    ...newItems.map(CSVTools.fromScraped),
    ...existing,
  ];

  const filename = buildFilename(inputFilename);
  await downloadCSV(CSVTools.buildCSV(mergedRows), filename);

  await saveProgress({
    ...initialProgress(),
    phase: 'done',
    collected: newItems.length,
    message: `完了！新規${newItems.length}件追加（計${mergedRows.length}件）${scanNote}`,
  });
}

function buildFilename(inputFilename) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const d = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
  const t = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  if (!inputFilename) return `doujin-library-${d}-${t}.csv`;
  const base = inputFilename.replace(/\.csv$/i, '').replace(/-\d{8}-\d{6}$/, '');
  return `${base}-${d}-${t}.csv`;
}

async function downloadCSV(csv, filename) {
  const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}
