import crypto from "crypto";
import OAuth from "oauth-1.0a";
import { google } from "googleapis";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const ENV = {
  // Google
  GOOGLE_CLIENT_ID: mustEnv("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: mustEnv("GOOGLE_CLIENT_SECRET"),
  GOOGLE_REFRESH_TOKEN: mustEnv("GOOGLE_REFRESH_TOKEN"),
  GOOGLE_SHEET_ID: mustEnv("GOOGLE_SHEET_ID"),
  GOOGLE_SHEET_TAB: mustEnv("GOOGLE_SHEET_TAB"),

  // X OAuth 1.0a
  X_API_KEY: mustEnv("X_API_KEY"),
  X_API_SECRET: mustEnv("X_API_SECRET"),
  X_ACCESS_TOKEN: mustEnv("X_ACCESS_TOKEN"),
  X_ACCESS_SECRET: mustEnv("X_ACCESS_SECRET"),
};

function toIsoUtc(d) {
  return new Date(d).toISOString();
}

// Parse sheet date/time into a UTC Date.
// Expect Publish Date like: 2026-01-31
// Expect Time (UTC) like: 20:05  (24h)
function parseUtcDateTime(publishDate, timeUtc) {
  const dateStr = String(publishDate).trim();
  const timeStr = String(timeUtc).trim();

  // Build ISO like: 2026-01-31T20:05:00Z
  const iso = `${dateStr}T${timeStr}:00Z`;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid date/time from sheet: Publish Date="${dateStr}", Time (UTC)="${timeStr}" -> "${iso}"`);
  }
  return dt;
}

async function getSheetsClient() {
  const oauth2 = new google.auth.OAuth2(
    ENV.GOOGLE_CLIENT_ID,
    ENV.GOOGLE_CLIENT_SECRET,
    "urn:ietf:wg:oauth:2.0:oob"
  );

  oauth2.setCredentials({ refresh_token: ENV.GOOGLE_REFRESH_TOKEN });

  // Force refresh so we know it works
  await oauth2.getAccessToken();

  return google.sheets({ version: "v4", auth: oauth2 });
}

async function fetchRows(sheets) {
  // We read the whole tab. (30 rows is tiny, this is fine.)
  const range = `${ENV.GOOGLE_SHEET_TAB}!A:Z`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ENV.GOOGLE_SHEET_ID,
    range,
  });

  const values = res.data.values || [];
  if (values.length < 2) return { headers: [], rows: [] };

  const headers = values[0].map((h) => String(h).trim());
  const rows = values.slice(1);

  return { headers, rows };
}

function headerIndex(headers, name) {
  const idx = headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  if (idx === -1) throw new Error(`Missing required column in sheet header: "${name}"`);
  return idx;
}

async function updateRow(sheets, rowNumber1Based, headers, updatesObj) {
  // We update by writing back the whole row (safe + simple)
  const { headers: _h, rows } = await fetchRows(sheets);

  // rowNumber1Based includes header row as row 1 in Google Sheets UI
  // Our data rows start at row 2.
  const dataIndex = rowNumber1Based - 2;
  if (dataIndex < 0 || dataIndex >= rows.length) {
    throw new Error(`Row number out of range: ${rowNumber1Based}`);
  }

  const row = rows[dataIndex].slice(); // copy

  for (const [key, val] of Object.entries(updatesObj)) {
    const idx = headerIndex(headers, key);
    row[idx] = val;
  }

  // Write back the row range like: Posts!A5:Z5
  const startCol = "A";
  const endCol = String.fromCharCode("A".charCodeAt(0) + Math.min(headers.length - 1, 25)); // up to Z
  const range = `${ENV.GOOGLE_SHEET_TAB}!${startCol}${rowNumber1Based}:${endCol}${rowNumber1Based}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: ENV.GOOGLE_SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [row.slice(0, headers.length)] },
  });
}

function buildOAuth() {
  return new OAuth({
    consumer: { key: ENV.X_API_KEY, secret: ENV.X_API_SECRET },
    signature_method: "HMAC-SHA1",
    hash_function(base_string, key) {
      return crypto.createHmac("sha1", key).update(base_string).digest("base64");
    },
  });
}

async function postToX(statusText) {
  // X v2 create tweet endpoint
  const url = "https://api.x.com/2/tweets";
  const method = "POST";
  const body = { text: statusText };

  const oauth = buildOAuth();
  const authData = oauth.authorize(
    { url, method },
    { key: ENV.X_ACCESS_TOKEN, secret: ENV.X_ACCESS_SECRET }
  );

  const headers = {
    ...oauth.toHeader(authData),
    "Content-Type": "application/json",
  };

  const resp = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`X post failed (${resp.status}): ${JSON.stringify(json)}`);
  }

  const tweetId = json?.data?.id;
  if (!tweetId) throw new Error(`X post succeeded but no tweet id returned: ${JSON.stringify(json)}`);

  return tweetId;
}

async function main() {
  const now = new Date(); // UTC internally

  const sheets = await getSheetsClient();
  const { headers, rows } = await fetchRows(sheets);
  if (!headers.length) {
    console.log("No rows found.");
    return;
  }

  const iPublishDate = headerIndex(headers, "Publish Date");
  const iTimeUtc = headerIndex(headers, "Time (UTC)");
  const iPostText = headerIndex(headers, "Post Text");
  const iStatus = headerIndex(headers, "Status");

  // Optional columns (we’ll write them if they exist)
  const iTweetId = headers.findIndex((h) => h.toLowerCase() === "tweet_id");
  const iPostedAt = headers.findIndex((h) => h.toLowerCase() === "posted_at");

  // Find first due post
  let picked = null;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];

    const status = String(row[iStatus] ?? "").trim();
    if (status.toLowerCase() !== "pending") continue;

    const publishDate = row[iPublishDate];
    const timeUtc = row[iTimeUtc];
    const postText = String(row[iPostText] ?? "").trim();
    if (!postText) continue;

    const scheduled = parseUtcDateTime(publishDate, timeUtc);

    if (scheduled <= now) {
      // Google sheet row number in UI = r + 2 (because headers are row 1)
      picked = { r, rowNumber: r + 2, postText, scheduled };
      break;
    }
  }

  if (!picked) {
    console.log(`No Pending posts due yet. Now (UTC): ${toIsoUtc(now)}`);
    return;
  }

  console.log(`Posting row ${picked.rowNumber} scheduled ${toIsoUtc(picked.scheduled)}:`);
  console.log(picked.postText);

  const tweetId = await postToX(picked.postText);

  const updates = {
    Status: "Posted",
  };

  if (iTweetId !== -1) updates["tweet_id"] = tweetId;
  if (iPostedAt !== -1) updates["posted_at"] = toIsoUtc(new Date());

  await updateRow(sheets, picked.rowNumber, headers, updates);

  console.log(`Posted successfully. tweet_id=${tweetId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
