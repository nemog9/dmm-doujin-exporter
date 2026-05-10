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
      results.set(id, { title, circle, url, thumbnail, cv: '', genre: genreText });
    }
    return false;
  };

  let prevTotal = document.querySelectorAll('.localListProductzKID2').length;
  let unchanged = 0;

  while (unchanged < 3) {
    if (limit > 0 && results.size >= limit) break;
    const hitDup = extract();
    if (hitDup) break;

    const loader = document.querySelector('.ajaxAreaxcTPC,.loadingIconmW5s8');
    if (loader) loader.scrollIntoView({ behavior: 'smooth' });
    await delay(2500);

    const currTotal = document.querySelectorAll('.localListProductzKID2').length;
    if (currTotal === prevTotal) unchanged++;
    else { unchanged = 0; prevTotal = currTotal; }
  }

  return [...results.values()].slice(0, limit > 0 ? limit : undefined);
}

async function fetchCVOnPage(url) {
  const detailUrl = url.replace(
    /\/dc\/-\/mylibrary\/detail\/=\/product_id=([\w]+)\//,
    '/dc/doujin/-/detail/=/cid=$1/'
  );
  try {
    const res = await fetch(detailUrl);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let cv = '', author = '';
    for (const dl of doc.querySelectorAll('.informationList')) {
      const ttl = dl.querySelector('.informationList__ttl')?.textContent.trim();
      const vals = [...dl.querySelectorAll('.informationList__txt a')].map(a => a.textContent.trim()).join(',');
      if (ttl === '声優') cv = vals;
      if (ttl === '作者') author = vals;
    }
    return cv || author;
  } catch { return ''; }
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
  const newItems = results[0].result;
  const existing = existingRows || [];

  if (!newItems || newItems.length === 0) {
    const filename = buildFilename(inputFilename);
    if (existing.length > 0) {
      await downloadCSV(buildCSV(existing), filename);
      await saveProgress({ ...initialProgress(), phase: 'done', collected: 0, message: `新規作品はありませんでした（計${existing.length}件）` });
    } else {
      await saveProgress({ ...initialProgress(), phase: 'done', message: '新規作品はありませんでした', collected: 0 });
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
    newItems[i].cv = cvResult[0].result ?? '';
    await new Promise(r => setTimeout(r, 500));
  }

  const mergedRows = [
    ...newItems.map(r => ({ title: r.title, circle: r.circle, cv: r.cv, genre: r.genre, url: r.url, thumbnail: r.thumbnail })),
    ...existing,
  ];

  const filename = buildFilename(inputFilename);
  await downloadCSV(buildCSV(mergedRows), filename);

  await saveProgress({
    ...initialProgress(),
    phase: 'done',
    collected: newItems.length,
    message: `完了！新規${newItems.length}件追加（計${mergedRows.length}件）`,
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

function buildCSV(rows) {
  const header = '"タイトル","サークル名","声優","ジャンル","URL","サムネイル","お気に入り","非表示"';
  const lines = rows.map(r =>
    `"${(r.title||'').replace(/"/g,'""')}","${(r.circle||'').replace(/"/g,'""')}","${(r.cv||'')}","${(r.genre||'')}","${r.url||''}","${r.thumbnail||''}","${r.favorite||''}","${r.hidden||''}"`
  );
  return '﻿' + [header, ...lines].join('\n');
}

async function downloadCSV(csv, filename) {
  const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}
