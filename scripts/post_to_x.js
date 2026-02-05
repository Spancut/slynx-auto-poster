import { google } from "googleapis";
import fetch from "node-fetch";
import crypto from "crypto";

// ----------------- helpers -----------------
function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var: ${name}`);
  return String(v).trim();
}

function quoteSheetName(name) {
  const safe = name.replace(/'/g, "''");
  return `'${safe}'`;
}

function fatal(msg, err) {
  console.error(`Fatal error: ${msg}`);
  if (err?.message) console.error(err.message);
  if (err?.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
}

function toLowerTrim(v) {
  return String(v ?? "").trim().toLowerCase();
}

function parseUtcDueDate(row) {
  // Expects:
  // Publish Date: YYYY-MM-DD
  // Time (UTC): HH:MM (24h)
  const d = String(row["Publish Date"] ?? "").trim();
  const t = String(row["Time (UTC)"] ?? "").trim();

  if (!d || !t) return null;

  // Accept "10:00" or "10:00:00"
  const time = t.length === 5 ? `${t}:00` : t;

  // Force UTC
  const iso = `${d}T${time}Z`;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildQueryString(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
}

function oauth1Header({ method, url, consumerKey, consumerSecret, token, tokenSecret }) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
  };

  // For JSON POST, body params are NOT included in signature.
  // Only OAuth params + query params (none here).
  const baseParams = { ...oauthParams };

  const paramString = buildQueryString(baseParams);
  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join("&");

  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");

  const headerParams = { ...oauthParams, oauth_signature: signature };

  const authHeader =
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(", ");

  return authHeader;
}

// ----------------- Google Sheets -----------------
async function getSheetsClient() {
  const clientId = mustEnv("GOOGLE_CLIENT_ID");
  const clientSecret = mustEnv("GOOGLE_CLIENT_SECRET");
  const refreshToken = mustEnv("GOOGLE_REFRESH_TOKEN");

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return google.sheets({ version: "v4", auth: oauth2Client });
}

async function assertTabExists(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(title))",
  });

  const titles = (meta.data.sheets || [])
    .map((s) => s.properties?.title)
    .filter(Boolean);

  if (!titles.includes(tabName)) {
    console.error("Your GOOGLE_SHEET_TAB does not match any tab in the sheet.");
    console.error("Provided:", JSON.stringify(tabName));
    console.error("Available tabs:");
    titles.forEach((t) => console.error(" -", JSON.stringify(t)));
    throw new Error("Tab not found");
  }
}

async function fetchRowsAndHeaders() {
  const spreadsheetId = mustEnv("GOOGLE_SHEET_ID");
  const tabName = mustEnv("GOOGLE_SHEET_TAB").trim();

  const sheets = await getSheetsClient();
  await assertTabExists(sheets, spreadsheetId, tabName);

  const range = `${quoteSheetName(tabName)}!A:Z`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const values = res.data.values || [];
  if (values.length < 2) return { sheets, spreadsheetId, tabName, headers: [], rows: [] };

  const headers = values[0].map((h) => String(h).trim());

  const rows = values.slice(1).map((row, idx) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i] ?? ""));
    obj.__rowIndex = idx + 2; // 1-based + header row
    return obj;
  });

  return { sheets, spreadsheetId, tabName, headers, rows };
}

async function updateRowByHeader({ sheets, spreadsheetId, tabName, headers, rowIndex, updates }) {
  // updates: { "Status": "Posted", "Tweet ID": "...", ... }
  const tab = quoteSheetName(tabName);

  const data = [];
  for (const [colName, value] of Object.entries(updates)) {
    const colIdx = headers.indexOf(colName);
    if (colIdx === -1) continue; // column not present, skip silently

    const colLetter = String.fromCharCode("A".charCodeAt(0) + colIdx); // A-Z only
    const range = `${tab}!${colLetter}${rowIndex}:${colLetter}${rowIndex}`;
    data.push({ range, values: [[value]] });
  }

  if (!data.length) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data,
    },
  });
}

// ----------------- X posting (OAuth 1.0a) -----------------
async function postToX(text) {
  const consumerKey = mustEnv("X_API_KEY");
  const consumerSecret = mustEnv("X_API_SECRET");
  const token = mustEnv("X_ACCESS_TOKEN");
  const tokenSecret = mustEnv("X_ACCESS_SECRET");

  // v2 create tweet endpoint
  const url = "https://api.twitter.com/2/tweets";
  const method = "POST";

  const auth = oauth1Header({
    method,
    url,
    consumerKey,
    consumerSecret,
    token,
    tokenSecret,
  });

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  const body = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const msg = body?.detail || body?.title || JSON.stringify(body);
    throw new Error(`X post failed (${resp.status}): ${msg}`);
  }

  const tweetId = body?.data?.id;
  if (!tweetId) throw new Error("X post returned success but no tweet id.");
  return { tweetId };
}

// ----------------- main -----------------
async function main() {
  try {
    console.log("Sheet ID length:", (process.env.GOOGLE_SHEET_ID || "").length);
    console.log("Tab:", JSON.stringify((process.env.GOOGLE_SHEET_TAB || "").trim()));

    const { sheets, spreadsheetId, tabName, headers, rows } = await fetchRowsAndHeaders();

    if (!rows.length) {
      console.log("Sheet has no rows to post.");
      return;
    }

    const now = new Date(); // now (UTC when we compare with Z-based dates)

    // Choose: earliest Pending row that is due (PublishDate+TimeUTC <= now)
    const candidates = rows
      .filter((r) => toLowerTrim(r["Status"]) === "pending")
      .map((r) => {
        const due = parseUtcDueDate(r);
        return { r, due };
      })
      .filter(({ r, due }) => {
        const text = String(r["Post Text"] ?? "").trim();
        return !!text && due && due.getTime() <= now.getTime();
      })
      .sort((a, b) => a.due.getTime() - b.due.getTime());

    if (!candidates.length) {
      console.log("No Pending posts are due yet. Exiting cleanly.");
      return;
    }

    const chosen = candidates[0].r;
    const rowIndex = chosen.__rowIndex;
    const text = String(chosen["Post Text"]).trim();

    console.log("Posting sheet row:", rowIndex);
    console.log("Text preview:", text.slice(0, 60) + (text.length > 60 ? "…" : ""));

    const { tweetId } = await postToX(text);

    console.log("Posted to X. Tweet ID:", tweetId);

    const postedAtUtc = new Date().toISOString();

    await updateRowByHeader({
      sheets,
      spreadsheetId,
      tabName,
      headers,
      rowIndex,
      updates: {
        Status: "Posted",
        "Tweet ID": tweetId,
        "Posted At (UTC)": postedAtUtc,
      },
    });

    console.log("Sheet updated.");
  } catch (e) {
    fatal(e.message || "Unknown error", e);
  }
}

main();
