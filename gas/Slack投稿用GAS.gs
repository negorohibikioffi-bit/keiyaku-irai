// 契約作成依頼 Slack投稿用GAS
// 使い方：スクリプトのプロパティに SLACK_BOT_TOKEN（xoxb-…）を入れてから、
//        ウェブアプリとしてデプロイする（実行：自分／アクセス：全員）
// 注意：合言葉はありません。ウェブアプリのURLは他人に教えないでください。
//
// できること
//   1) 申込投稿を探す   { action:'findThread', channel, property, room, customer }
//   2) 投稿する         { channel, text, thread_ts? }   thread_ts があればそのスレッドに返信

const ALLOWED = ['C08P1PGLHT5', 'C08P1MWKVT5', 'C08N4SFRQF8']; // 投稿を許可するチャンネル
const WORKSPACE_URL = 'https://axia-japan.slack.com';
const SEARCH_DAYS = 45;      // 何日前までの投稿から申込を探すか
const SEARCH_PAGES = 5;      // 200件×5ページ＝最大1000件まで見る
const UNDECIDED = ['未定', '物件未定'];

function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents);
    if (ALLOWED.indexOf(p.channel) === -1) return out({ ok: false, error: 'channel_not_allowed' });
    if (p.action === 'findThread') return out(findThread_(p));
    return out(postMessage_(p));
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function doGet() { return out({ ok: true, msg: 'alive' }); }

// ---------- 投稿 ----------
function postMessage_(p) {
  if (!p.text) return { ok: false, error: 'empty_text' };
  if (String(p.text).length > 3000) return { ok: false, error: 'text_too_long' };
  const body = { channel: p.channel, text: p.text, unfurl_links: false, unfurl_media: false };
  if (p.thread_ts) body.thread_ts = String(p.thread_ts);
  const j = slack_('chat.postMessage', body, 'post');
  return { ok: j.ok, error: j.error, ts: j.ts };
}

// ---------- 申込投稿を探す ----------
function findThread_(p) {
  const building = norm_(p.property);
  if (!building || UNDECIDED.indexOf(building) !== -1) return { ok: true, ts: '' };
  const roomNo = (String(p.room || '').match(/\d+/) || [''])[0];
  const who = customerKey_(p.customer);

  const cache = CacheService.getScriptCache();
  const cacheKey = 'ft_' + Utilities.base64EncodeWebSafe(p.channel + '|' + building + '|' + roomNo + '|' + who).slice(0, 200);
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const oldest = String(Math.floor(Date.now() / 1000) - SEARCH_DAYS * 86400);
  let hits = [];
  let cursor = '';
  for (let page = 0; page < SEARCH_PAGES; page++) {
    const q = { channel: p.channel, oldest: oldest, limit: 200 };
    if (cursor) q.cursor = cursor;
    const j = slack_('conversations.history', q, 'get');
    if (!j.ok) return { ok: false, error: j.error };
    (j.messages || []).forEach(function (m) {
      if (m.thread_ts && m.thread_ts !== m.ts) return;   // スレッドの返信は除く
      const hay = norm_(textOf_(m));
      if (hay.indexOf('【申込】') === -1) return;
      const matched = roomNo ? hay.indexOf(building + roomNo) !== -1 : hay.indexOf(building) !== -1;
      if (matched) hits.push({ ts: m.ts, hay: hay });
    });
    cursor = j.response_metadata && j.response_metadata.next_cursor;
    if (!cursor) break;
  }

  if (who && hits.length > 1) {
    const narrowed = hits.filter(function (h) { return h.hay.indexOf(who) !== -1; });
    if (narrowed.length > 0) hits = narrowed;
  }
  const hit = hits[0];   // 履歴は新しい順なので、先頭がいちばん新しい
  const result = hit
    ? { ok: true, ts: hit.ts, url: WORKSPACE_URL + '/archives/' + p.channel + '/p' + hit.ts.replace('.', '') + '?thread_ts=' + hit.ts + '&cid=' + p.channel }
    : { ok: true, ts: '' };
  cache.put(cacheKey, JSON.stringify(result), 60);
  return result;
}

// 投稿の本文（textとblocksの文字）をまとめる
function textOf_(m) {
  const parts = [m.text || ''];
  (function walk(v) {
    if (!v) return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') {
      Object.keys(v).forEach(function (k) {
        if (k === 'text' && typeof v[k] === 'string') parts.push(v[k]);
        else walk(v[k]);
      });
    }
  })(m.blocks);
  (m.attachments || []).forEach(function (a) { parts.push(a.text || '', a.fallback || ''); });
  return parts.join(' ');
}

function norm_(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[\s　\-ー－・]/g, '')
    .replace(/号室/g, '')
    .toLowerCase();
}

function customerKey_(name) {
  const n = String(name || '').replace(/様|さん|殿/g, '').trim();
  if (!n) return '';
  return norm_(n.split(/[\s　]+/)[0]);
}

// ---------- Slack API ----------
function slack_(method, params, how) {
  const token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  const headers = { Authorization: 'Bearer ' + token };
  let res;
  if (how === 'get') {
    const qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    res = UrlFetchApp.fetch('https://slack.com/api/' + method + '?' + qs, { headers: headers, muteHttpExceptions: true });
  } else {
    res = UrlFetchApp.fetch('https://slack.com/api/' + method, {
      method: 'post', contentType: 'application/json; charset=utf-8',
      headers: headers, payload: JSON.stringify(params), muteHttpExceptions: true
    });
  }
  return JSON.parse(res.getContentText());
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
