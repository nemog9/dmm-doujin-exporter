// node --test test/csv.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { parseCSV, readItems, buildCSV, fromScraped, HEADER } = createRequire(import.meta.url)("../csv.js");

const legacy = '﻿"タイトル","サークル名","声優","ジャンル","URL","サムネイル","お気に入り","非表示"\n' +
  '"夜更けの""ささやき""","サークルA","甲野 乙子,丙山 太郎","ボイス","https://www.dmm.co.jp/dc/-/mylibrary/detail/=/product_id=d_111111/","https://t/1.jpg","true",""\n' +
  '"漫画","サークルB","作者X","コミック","https://www.dmm.co.jp/dc/-/mylibrary/detail/=/product_id=d_222222/","https://t/2.jpg","",""\n';

test("旧形式を読み、サークルと声優を creators にまとめる", () => {
  const items = readItems(legacy);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '夜更けの"ささやき"');
  assert.deepEqual(items[0].creators, ["サークルA", "甲野 乙子", "丙山 太郎"]);
  assert.equal(items[0].category, "ボイス");
  assert.equal(items[0].favorite, "1");
  assert.equal(items[1].favorite, "", "空は空のまま（アプリ側の値を保持させる）");
});

test("出力は CSVShelf の列順で、BOM 付き・全フィールド引用", () => {
  const csv = buildCSV(readItems(legacy));
  assert.ok(csv.startsWith("﻿"));
  const rows = parseCSV(csv);
  assert.deepEqual(rows[0], HEADER);
  assert.deepEqual(rows[0], ["title", "url", "creators", "thumbnail_url", "category", "note", "favorite", "hidden"]);
  assert.equal(rows[1][2], "サークルA|甲野 乙子|丙山 太郎");
  assert.equal(rows[1][4], "ボイス");
});

test("新形式（CSVShelf の書き出し）の往復: 改行を含むメモ・お気に入り・非表示を保持", () => {
  const shelf = '﻿title,url,creators,thumbnail_url,category,note,favorite,hidden\n' +
    '"t, with comma","https://www.dmm.co.jp/dc/-/mylibrary/detail/=/product_id=d_333333/",a|b,https://t/3.jpg,ボイス,"1行目\n2行目 ""引用""",1,0\r\n';
  const items = readItems(shelf);
  assert.equal(items.length, 1);
  assert.equal(items[0].note, '1行目\n2行目 "引用"');
  assert.equal(items[0].favorite, "1"); assert.equal(items[0].hidden, "0");
  const again = readItems(buildCSV(items));
  assert.deepEqual(again, items);
});

test("新規取得分: サークル+声優、重複除去、お気に入り/非表示/メモは空", () => {
  const row = fromScraped({ title: "T", circle: "サークルA", cv: ["甲野", "サークルA", "甲野"], url: "u", thumbnail: "i", genre: "CG" });
  assert.deepEqual(row.creators, ["サークルA", "甲野"]);
  assert.equal(row.category, "CG");
  assert.deepEqual([row.note, row.favorite, row.hidden], ["", "", ""]);
});

test("URL 列のない CSV は空", () => assert.deepEqual(readItems("a,b\n1,2\n"), []));
