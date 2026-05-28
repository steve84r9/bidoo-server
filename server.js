import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
const PORT = process.env.PORT || 3000;

// --- DB INIT ---
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
    await db.run("INSERT INTO meta (key, value) VALUES ('last_scanned', ?)", "91900000");
  }
})();

// --- SCRAPER DI UNA SINGOLA ASTA ---
async function scrapeAuction(id) {
  const url = `https://it.bidoo.com/auction.php?a=${id}`;
  try {
    const res = await axios.get(url, { timeout: 8000 });
    const $ = cheerio.load(res.data);

    const title = $(".auction-title").text().trim();
    const priceText = $(".auction-price.auction-header-item-size").text().trim();

    if (!title || !priceText) return null;

    const priceNum = parseFloat(
      priceText.replace("€", "").replace(".", "").replace(",", ".")
    );

    if (isNaN(priceNum)) return null;

    return {
      id,
      title,
      price: priceNum,
      raw_price: priceText,
      created_at: new Date().toISOString()
    };
  } catch {
    return null;
  }
}

// --- SCAN DI UN BLOCCO DI ID ---
async function scanBlock(blockSize = 5000) {
  const meta = await db.get("SELECT value FROM meta WHERE key = 'last_scanned'");
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

  await db.run("UPDATE meta SET value = ? WHERE key = 'last_scanned'", end.toString());
  console.log("Block done, last_scanned =", end);
}

// --- ENDPOINT CRON (da chiamare ogni 6 ore) ---
app.get("/cron", async (req, res) => {
  try {
    await scanBlock(5000);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- SEARCH API ---
app.get("/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  if (!q) return res.json([]);

  const rows = await db.all(
    `SELECT * FROM auctions
     WHERE LOWER(title) LIKE ?
     ORDER BY created_at DESC
     LIMIT 500`,
    `%${q}%`
  );

  res.json(rows);
});

// --- TEST ROOT ---
app.get("/", (req, res) => {
  res.send("Bidoo analyzer clone running.");
});

app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
