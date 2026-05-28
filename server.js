import express from "express";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT;

// ---------------------------
// INIT DATABASE
// ---------------------------
let db;
(async () => {
  db = await open({
    filename: "./bidoo.db",
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS auctions (
      id TEXT PRIMARY KEY,
      title TEXT,
      price REAL,
      raw_price TEXT,
      created_at TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const row = await db.get("SELECT value FROM meta WHERE key = 'last_scanned'");
  if (!row) {
    await db.run(
      "INSERT INTO meta (key, value) VALUES ('last_scanned', ?)",
      "91500000"
    );
  }

  console.log("DB inizializzato.");
})();

// ---------------------------
// SCRAPER CON CHROMIUM
// ---------------------------
async function scrapeAuction(id) {
  const url = `https://it.bidoo.com/auction.php?a=${id}`;

  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "networkidle" });

  await page.waitForSelector(".auction-container-timer").catch(() => {});

  const data = await page.evaluate(() => {
    const title = document.title.replace(" - Bidoo", "").trim();
    const timer = document.querySelector(".auction-container-timer");
    const priceText = timer?.getAttribute("data-price-winner") || "";
    return { title, priceText };
  });

  await browser.close();

  if (!data.title || !data.priceText) return null;

  const priceNum = parseFloat(
    data.priceText.replace("€", "").replace(".", "").replace(",", ".")
  );

  if (isNaN(priceNum)) return null;

  return {
    id,
    title: data.title,
    price: priceNum,
    raw_price: data.priceText,
    created_at: new Date().toISOString()
  };
}

// ---------------------------
// SCAN BLOCCO DI ID
// ---------------------------
async function scanBlock(blockSize = 5000) {
  const meta = await db.get(
    "SELECT value FROM meta WHERE key = 'last_scanned'"
  );
  let current = parseInt(meta.value, 10);
  const end = current + blockSize;

  console.log(`Scanning from ${current} to ${end}...`);

  for (let n = current; n < end; n++) {
    const id = n.toString();
    const data = await scrapeAuction(id);

    if (data) {
      await db.run(
        `INSERT OR REPLACE INTO auctions (id, title, price, raw_price, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        data.id,
        data.title,
        data.price,
        data.raw_price,
        data.created_at
      );

      console.log("Saved:", data.id, data.title, data.raw_price);
    }
  }

  await db.run(
    "UPDATE meta SET value = ? WHERE key = 'last_scanned'",
    end.toString()
  );

  await db.run(
    "UPDATE meta SET value = ? WHERE key = 'last_cycle'",
    new Date().toISOString()
  );

  console.log("Block done, last_scanned =", end);
}

// ---------------------------
// ENDPOINT CRON
// ---------------------------
app.get("/cron", async (req, res) => {
  try {
    await scanBlock(5000);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------
// STATUS
// ---------------------------
app.get("/status", async (req, res) => {
  try {
    const last = await db.get("SELECT value FROM meta WHERE key = 'last_scanned'");
    const count = await db.get("SELECT COUNT(*) AS total FROM auctions");
    const cycle = await db.get("SELECT value FROM meta WHERE key = 'last_cycle'");

    res.json({
      ok: true,
      last_scanned: last ? last.value : null,
      total_records: count ? count.total : 0,
      last_cycle: cycle ? cycle.value : null,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---------------------------
// ROOT
// ---------------------------
app.get("/", (req, res) => {
  res.send("Bidoo closed-auctions analyzer running (Puppeteer version).");
});

// ---------------------------
// START SERVER
// ---------------------------
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
