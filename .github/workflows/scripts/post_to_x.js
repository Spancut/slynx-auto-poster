import { google } from "googleapis";
import { TwitterApi } from "twitter-api-v2";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const GOOGLE_CLIENT_ID = mustEnv("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = mustEnv("GOOGLE_CLIENT_SECRET");
const GOOGLE_REFRESH_TOKEN = mustEnv("GOOGLE_REFRESH_TOKEN");
const GOOGLE_SHEET_ID = mustEnv("GOOGLE_SHEET_ID");
const GOOGLE_SHEET_TAB = mustEnv("GOOGLE_SHEET_TAB");

const X_API_KEY = mustEnv("X_API_KEY");
const X_API_SECRET = mustEnv("X_API_SECRET");
const X_ACCESS_TOKEN = mustEnv("X_ACCESS_TOKEN");
const X_ACCESS_SECRET = mustEnv("X_ACCESS_SECRET");

function parseUtcDateTime(publishDate, timeUtc) {
  // publishDate: "2026-01-31"
  // timeUtc: "10:00" or "10:00:00"
  const t = (timeUtc || "").trim();
  const time = t.length === 5 ? `${t}:00` : t; // normalize
  const iso = `${publishDate}T${time}Z`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d;
}

async function getSheetsClient() {
  const oauth2 = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );

  oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.sheets({ version: "v4", auth: oauth2 });
}

async function main() {
  const sheets = await getSheetsClient();

  // Pull entire sheet (simple + reliable for 30-1000 rows).
  const range = `${GOOGLE_SHEET_TAB}!A1:Z10000`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range
  });

  const values = res.data.values || [];
  if (values.length < 2) {
    console.log("No rows found.");
    return;
  }

  const headers = values[0].map((h) => (h || "").trim());
  const rows = values.slice(1);

  const col = (name) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const idxPublishDate = col("Publish Date");
  const idxTimeUtc = col("Time (UTC)");
  const idxPostText = col("Post Text");
  const idxImageUrl = col("Image URL");
  const idxStatus = col("Status");
  const idxId = col("id");

  // Optional columns you can add for logging:
  let idxPostedAt = col("Posted At");
  let idxTweetId = col("Tweet ID");

  if ([idxPublishDate, idxTimeUtc, idxPostText, idxStatus, idxId].some((i) => i === -1)) {
    throw new Error(
      `Missing required columns. Need: Publish Date, Time (UTC), Post Text, Status, id`
    );
  }

  const now = new Date();

  // Find first eligible Pending post, sorted by datetime then id.
  const candidates = rows
    .map((r, i) => ({ r, i, sheetRow: i + 2 })) // +2 because header row
    .filter(({ r }) => (r[idxStatus] || "").trim().toLowerCase() === "pending")
    .map(({ r, i, sheetRow }) => {
      const dt = parseUtcDateTime(r[idxPublishDate], r[idxTimeUtc]);
      const id = Number(r[idxId]);
      return { r, i, sheetRow, dt, id };
    })
    .filter((x) => x.dt && x.dt <= now)
    .sort((a, b) => a.dt - b.dt || a.id - b.id);

  if (candidates.length === 0) {
    console.log("No Pending posts due yet.");
    return;
  }

  const item = candidates[0];
  const postText = (item.r[idxPostText] || "").trim();
  const imageUrl = (idxImageUrl !== -1 ? (item.r[idxImageUrl] || "").trim() : "");

  if (!postText) {
    console.log(`Row ${item.sheetRow} has empty Post Text. Marking as Skipped.`);
    await updateRow(sheets, item.sheetRow, headers, {
      Status: "Skipped",
      "Posted At": new Date().toISOString()
    });
    return;
  }

  // Post to X
  const twitter = new TwitterApi({
    appKey: X_API_KEY,
    appSecret: X_API_SECRET,
    accessToken: X_ACCESS_TOKEN,
    accessSecret: X_ACCESS_SECRET
  });

  // Image support can be added later. For now: text only (most reliable).
  const tweet = await twitter.v2.tweet(postText);
  console.log("Tweet posted:", tweet.data?.id);

  // Update the sheet row status => Posted
  const updates = {
    Status: "Posted",
    "Posted At": new Date().toISOString(),
    "Tweet ID": tweet.data?.id || ""
  };

  await updateRow(sheets, item.sheetRow, headers, updates);
  console.log(`Row ${item.sheetRow} updated.`);
}

async function updateRow(sheets, sheetRow, headers, updatesObj) {
  // Ensure columns exist; if not, we can’t auto-create via Values API easily.
  // So: only update columns that already exist.
  const cells = headers.map((_, idx) => null);

  // Fetch existing row to preserve cells
  const rowRange = `${process.env.GOOGLE_SHEET_TAB}!A${sheetRow}:Z${sheetRow}`;
  const rowRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: rowRange
  });
  const current = (rowRes.data.values && rowRes.data.values[0]) ? rowRes.data.values[0] : [];
  for (let i = 0; i < cells.length; i++) cells[i] = current[i] ?? "";

  for (const [k, v] of Object.entries(updatesObj)) {
    const idx = headers.findIndex((h) => h.toLowerCase() === k.toLowerCase());
    if (idx !== -1) cells[idx] = v;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: rowRange,
    valueInputOption: "RAW",
    requestBody: { values: [cells] }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
