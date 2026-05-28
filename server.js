import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
const PORT = process.env.PORT; // Render imposta la porta automaticamente

// ---------------------------
// INIT DATABASE
// ---------------------------
let db;
(async () => {
  db = await open({
    filename: "./bidoo.db",
    driver: sqlite3.Database
  });

  // Tabelle
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

  // Inizializza last_scanned se non esiste
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
// SCRAPER ASTA CHIUSA
// ---------------------------
async function scrapeAuction(id) {
  const url = `https://it.bidoo.com/auction.php?a=${id}`;

  try {
    const res = await axios.get(url, {
  timeout: 8000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "it-IT,it;q=0.9",
    "Referer": "https://it.bidoo.com/",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Cookie": "lang=it; currency=EUR;"
  }
});
    const $ = cheerio.load(res.data);
    console.log("DEBUG ID:", id);
console.log("Has auction-container-timer:", $(".auction-container-timer").length);
console.log("data-price-winner:", $(".auction-container-timer").attr("data-price-winner"));

    // TITOLO DAL TAG <title>
    const title = $("title").text().replace(" - Bidoo", "").trim();

    // PREZZO FINALE DAL DATA-ATTRIBUTE
    const priceText = $(".auction-container-timer").attr("data-price-winner");

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

  } catch (err) {
    return null;
  }
}

// ---------------------------
// SCAN BLOCCO DI ID NUMERICI
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
// SEARCH API
// ---------------------------
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

// ---------------------------
// STATUS API
// ---------------------------
app.get("/status", async (req, res) => {
  try {
    const last = await db.get(
      "SELECT value FROM meta WHERE key = 'last_scanned'"
    );

    const count = await db.get(
      "SELECT COUNT(*) AS total FROM auctions"
    );

    const cycle = await db.get(
      "SELECT value FROM meta WHERE key = 'last_cycle'"
    );

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
// ROOT TEST
// ---------------------------
app.get("/", (req, res) => {
  res.send("Bidoo closed-auctions analyzer running.");
});

// ---------------------------
// START SERVER
// ---------------------------
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
