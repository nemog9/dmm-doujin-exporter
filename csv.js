// CSVShelf 形式の CSV の読み書き。popup.js（ページ）と background.js（Service Worker）の両方から使う。
//   title,url,creators,thumbnail_url,category,note,favorite,hidden
// creators は「|」区切り（サークル・声優・作者をまとめる）。note は改行を含みうるので RFC 4180 で扱う。
(function (root) {
  const HEADER = ['title', 'url', 'creators', 'thumbnail_url', 'category', 'note', 'favorite', 'hidden'];

  /** RFC 4180: 引用符内の改行・"" エスケープ・CRLF に対応。空行は捨てる。 */
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
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

  // 見出し名 → 項目。旧形式（タイトル,サークル名,声優,ジャンル,URL,サムネイル,お気に入り,非表示）も読む。
  const ALIASES = {
    title: ['title', 'タイトル'],
    url: ['url'],
    creators: ['creators', 'クリエイター'],
    circle: ['サークル名', 'サークル', 'circle'],
    cv: ['声優', '作者', 'cv', 'actors'],
    thumbnail: ['thumbnail_url', 'thumbnail', 'サムネイル'],
    category: ['category', 'ジャンル', 'カテゴリ'],
    note: ['note', 'メモ'],
    favorite: ['favorite', 'お気に入り'],
    hidden: ['hidden', '非表示'],
  };

  const splitNames = (s) => (s || '').split(/[|｜,，、;；]/).map((x) => x.trim()).filter(Boolean);
  const dedupe = (names) => { const seen = new Set(); return names.filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())); };

  /** 1/true/yes → '1'、0/false/no → '0'、それ以外（空など）は ''（= アプリ側で既存値を保持）。 */
  function flag(v) {
    const s = norm(v);
    if (['1', 'true', 'yes', 'y', '○', 'はい'].includes(s)) return '1';
    if (['0', 'false', 'no', 'n'].includes(s)) return '0';
    return '';
  }

  /** CSV 文字列 → 作品の配列。URL 列がなければ空配列。 */
  function readItems(text) {
    const rows = parseCSV(text);
    if (!rows.length) return [];
    const header = rows[0].map(norm);
    const col = (key) => header.findIndex((h) => ALIASES[key].map(norm).includes(h));
    const idx = Object.fromEntries(Object.keys(ALIASES).map((k) => [k, col(k)]));
    if (idx.url < 0) return [];
    const get = (r, k) => (idx[k] >= 0 && idx[k] < r.length ? r[idx[k]] : '');
    return rows.slice(1).filter((r) => get(r, 'url')).map((r) => ({
      title: get(r, 'title').trim(),
      url: normalizeURL(get(r, 'url')),
      creators: dedupe([...splitNames(get(r, 'creators')), ...splitNames(get(r, 'circle')), ...splitNames(get(r, 'cv'))]),
      thumbnail: get(r, 'thumbnail').trim(),
      category: get(r, 'category').trim(),
      note: get(r, 'note'),
      favorite: flag(get(r, 'favorite')),
      hidden: flag(get(r, 'hidden')),
    }));
  }

  // --- DMM の URL ---
  // 購入済み: https://www.dmm.co.jp/dc/-/mylibrary/detail/=/product_id=d_294174/
  // 作品詳細: https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_294174/
  /** 作品 ID（d_294174 など）。購入済み URL・作品詳細 URL のどちらからでも取り出す。 */
  function productId(url) {
    const m = (url || '').match(/(?:product_id|cid)=(\w+)/);
    return m ? m[1] : '';
  }

  const detailURL = (id) => `https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=${id}/`;

  /** DMM の購入済み URL は作品詳細 URL に直す。それ以外の URL はそのまま。 */
  function normalizeURL(url) {
    const u = (url || '').trim();
    if (/dmm\.co\.jp\/dc\/-\/mylibrary\/detail\//.test(u)) {
      const id = productId(u);
      if (id) return detailURL(id);
    }
    return u;
  }

  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;

  /** 作品の配列 → CSVShelf 形式の CSV（UTF-8 BOM 付き）。 */
  function buildCSV(items) {
    const lines = items.map((r) => [
      r.title, r.url, (r.creators || []).join('|'), r.thumbnail, r.category, r.note, r.favorite, r.hidden,
    ].map(q).join(','));
    return '﻿' + [HEADER.map(q).join(','), ...lines].join('\n') + '\n';
  }

  /** 新規取得した作品（サークル + 声優/作者）を CSVShelf の 1 行にする。お気に入り・非表示・メモは空（= アプリ側の値を保持）。 */
  function fromScraped(s) {
    return {
      title: s.title, url: normalizeURL(s.url), creators: dedupe([...splitNames(s.circle), ...(s.cv || [])]),
      thumbnail: s.thumbnail, category: s.genre, note: '', favorite: '', hidden: '',
    };
  }

  const api = { HEADER, parseCSV, readItems, buildCSV, fromScraped, flag, productId, detailURL, normalizeURL };
  if (typeof module !== 'undefined') module.exports = api; else root.CSVTools = api;
})(typeof self !== 'undefined' ? self : globalThis);
