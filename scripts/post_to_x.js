// scripts/post_to_x.js
// Node 20+ (ESM). Posts the next due "Pending" row from Google Sheets to X, then marks it as Posted.

import crypto from "crypto";
import { google } from "googleapis";

// -----------------------
// Env helpers
// -----------------------
function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var: ${name}`);
  return String(v).trim();
}

function optEnv(name, def = "") {
  const v = process.env[name];
  return v == null ? def : String(v);
}

const DRY_RUN = ["1", "true", "yes"].includes(optEnv("DRY_RUN", "").toLowerCase());

// -----------------------
// Google Sheets helpers
// -----------------------
function safeSheetTab(tabName) {
  const raw = String(tabName || "").trim();
  if (!raw) throw new Error("Missing env var: GOOGLE_SHEET_TAB");

  // Quote tab name if it contains spaces or special chars
  const needsQuotes = /[^A-Za-z0-9_]/.test(raw);
  if (!needsQuotes) return raw;

  // Sheets escapes single quotes by doubling them inside quoted sheet names
  const escaped = raw.replace(/'/g, "''");
  return `'${escaped}'`;
}

async function getSheetsClient() {
  const clientId = mustEnv("GOOGLE_CLIENT_ID");
  const clientSecret = mustEnv("GOOGLE_CLIENT_SECRET");
  const refreshToken = mustEnv("GOOGLE_REFRESH_TOKEN");

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });

  return google.sheets({ version: "v4", auth: oAuth2Client });
}

function parseSheet(rows) {
  // rows is values[][] where first row is header
  if (!rows || rows.length < 2) return { header: [], items: [] };
  const header = rows[0].map((h) => String(h || "").trim());
  const items = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = row[c] ?? "";
    }
    obj.__rowIndex1 = r + 1; // 1-based in sheet (header is row 1)
    items.push(obj);
  }

  return { header, items };
}

function findHeaderIndex(header, name) {
  const idx = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  return idx >= 0 ? idx : -1;
}

function toIsoUtcFromColumns(publishDate, timeUtc) {
  // publishDate expected like "2026-01-31"
  // timeUtc expected like "20:05" or "20:05:00"
  const d = String(publishDate || "").trim();
  const t = String(timeUtc || "").trim();

  if (!d || !t) return null;

  // Normalize time
  const parts = t.split(":").map((x) => x.trim());
  if (parts.length < 2) return null;
  const hh = parts[0].padStart(2, "0");
  const mm = parts[1].padStart(2, "0");
  const ss = (parts[2] ?? "00").padStart(2, "0");

  // Build UTC ISO
  // Example: 2026-01-31T20:05:00Z
  return `${d}T${hh}:${mm}:${ss}Z`;
}

function nowUtcIso() {
  return new Date().toISOString();
}

function isDue(item, header) {
  const publishDateKey = header.find((h) => h.toLowerCase() === "publish date");
  const timeKey = header.find((h) => h.toLowerCase() === "time (utc)") || header.find((h) => h.toLowerCase() === "time utc");
  const statusKey = header.find((h) => h.toLowerCase() === "status");
  const postTextKey = header.find((h) => h.toLowerCase() === "post text");

  const publishDate = publishDateKey ? item[publishDateKey] : "";
  const timeUtc = timeKey ? item[timeKey] : "";
  const status = statusKey ? String(item[statusKey] || "").trim() : "";
  const postText = postTextKey ? String(item[postTextKey] || "").trim() : "";

  if (!postText) return false;
  if (status.toLowerCase() !== "pending") return false;

  const iso = toIsoUtcFromColumns(publishDate, timeUtc);
  if (!iso) return false;

  const scheduled = new Date(iso).getTime();
  const now = Date.now();
  return scheduled <= now;
}

// -----------------------
// OAuth 1.0a for X
// -----------------------
function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildOAuth1Header({ method, url, consumerKey, consumerSecret, token, tokenSecret, extraParams = {} }) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
    ...extraParams,
  };

  // Parse query params from URL
  const u = new URL(url);
  const baseUrl = `${u.origin}${u.pathname}`;
  const queryParams = {};
  u.searchParams.forEach((value, key) => {
    queryParams[key] = value;
  });

  // Only include query + oauth params (JSON body not included in OAuth1 signature base string)
  const allParams = { ...queryParams, ...oauthParams };
  const paramPairs = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join("&");

  const baseString = [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(paramPairs),
  ].join("&");

  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");

  oauthParams.oauth_signature = signature;

  const header = "OAuth " + Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(", ");

  return header;
}

async function postToX(text) {
  const X_API_KEY = mustEnv("X_API_KEY");
  const X_API_SECRET = mustEnv("X_API_SECRET");
  const X_ACCESS_TOKEN = mustEnv("X_ACCESS_TOKEN");
  const X_ACCESS_SECRET = mustEnv("X_ACCESS_SECRET");

  // X API v2 endpoint
  const url = "https://api.twitter.com/2/tweets";
  const method = "POST";

  const authHeader = buildOAuth1Header({
    method,
    url,
    consumerKey: X_API_KEY,
    consumerSecret: X_API_SECRET,
    token: X_ACCESS_TOKEN,
    tokenSecret: X_ACCESS_SECRET,
  });

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      "User-Agent": "slynx-autoposter/1.0",
    },
    body: JSON.stringify({ text }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`X post failed (${res.status}): ${body}`);
  }
  return JSON.parse(body);
}

// -----------------------
// Main flow
// -----------------------
async function fetchRows(sheets, spreadsheetId, tab) {
  const range = `${safeSheetTab(tab)}!A:Z`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  return resp.data.values || [];
}

async function updateRow(sheets, spreadsheetId, tab, header, item, updates) {
  // updates: { "Status": "Posted", "Posted At (UTC)": "..." }
  // We update by writing the whole row values for safety.
  const rowIndex1 = item.__rowIndex1; // 1-based row number
  const range = `${safeSheetTab(tab)}!A${rowIndex1}:Z${rowIndex1}`;

  // Build a row array matching header length (A..)
  const existingRow = header.map((h) => item[h] ?? "");
  const outRow = [...existingRow];

  for (const [key, val] of Object.entries(updates)) {
    const idx = findHeaderIndex(header, key);
    if (idx >= 0) outRow[idx] = val;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: {
      values: [outRow],
    },
  });
}

async function main() {
  const GOOGLE_SHEET_ID = mustEnv("GOOGLE_SHEET_ID");
  const GOOGLE_SHEET_TAB = mustEnv("GOOGLE_SHEET_TAB");

  const sheets = await getSheetsClient();

  const values = await fetchRows(sheets, GOOGLE_SHEET_ID, GOOGLE_SHEET_TAB);
  const { header, items } = parseSheet(values);

  if (!header.length) {
    console.log("Sheet appears empty (no header row). Nothing to do.");
    return;
  }

  // Find due rows, oldest first by scheduled datetime
  const due = items
    .map((it) => {
      const publishDateKey = header.find((h) => h.toLowerCase() === "publish date");
      const timeKey = header.find((h) => h.toLowerCase() === "time (utc)") || header.find((h) => h.toLowerCase() === "time utc");
      const iso = toIsoUtcFromColumns(
        publishDateKey ? it[publishDateKey] : "",
        timeKey ? it[timeKey] : ""
      );
      return { it, iso };
    })
    .filter(({ it, iso }) => iso && isDue(it, header))
    .sort((a, b) => new Date(a.iso).getTime() - new Date(b.iso).getTime());

  if (!due.length) {
    console.log("No due Pending posts right now. (UTC now:", nowUtcIso(), ")");
    return;
  }

  const next = due[0].it;

  const postTextKey = header.find((h) => h.toLowerCase() === "post text");
  const statusKey = header.find((h) => h.toLowerCase() === "status");
  const idKey = header.find((h) => h.toLowerCase() === "id");
  const imageUrlKey = header.find((h) => h.toLowerCase() === "image url");

  const text = postTextKey ? String(next[postTextKey] || "").trim() : "";
  const idVal = idKey ? String(next[idKey] || "").trim() : "";
  const imageUrl = imageUrlKey ? String(next[imageUrlKey] || "").trim() : "";

  if (!text) {
    console.log("Next due row has empty Post Text. Skipping.");
    return;
  }

  // If you want image support later, this is where we'd add v1.1 media upload.
  // For now, we post text only. If Image URL exists, we append it (optional).
  const finalText = imageUrl ? `${text}\n\n${imageUrl}` : text;

  console.log(`Posting row ${next.__rowIndex1}${idVal ? ` (id=${idVal})` : ""} to X...`);
  if (DRY_RUN) {
    console.log("[DRY_RUN] Would post:", finalText);
  } else {
    const result = await postToX(finalText);
    console.log("Posted to X:", result?.data?.id || "(no id returned)");
  }

  // Update status
  if (statusKey) {
    const updates = {
      Status: "Posted",
    };

    // Only write Posted At if column exists
    if (findHeaderIndex(header, "Posted At (UTC)") >= 0) {
      updates["Posted At (UTC)"] = nowUtcIso();
    }

    if (!DRY_RUN) {
      await updateRow(sheets, GOOGLE_SHEET_ID, GOOGLE_SHEET_TAB, header, next, updates);
      console.log("Sheet updated: Status=Posted");
    } else {
      console.log("[DRY_RUN] Would update sheet: Status=Posted");
    }
  } else {
    console.log("No 'Status' column found; skipping update.");
  }
}

main().catch((err) => {
  // Don’t leak secrets; print clean error
  console.error("Fatal error:", err?.message || err);
  process.exit(1);
});
