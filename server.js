import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import pg from "pg";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV = "sandbox",
  BASE_URL = "http://localhost:3000",
  DATABASE_URL,
  CASH_HOLD_MINUTES = "60",
  ADMIN_TOKEN
} = process.env;

const PAYPAL_API =
  PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      stock INTEGER NOT NULL,
      image_url TEXT
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      qty INTEGER NOT NULL,
      expires_at BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      method TEXT NOT NULL DEFAULT 'paypal'
    );
  `);

// Always upsert your current inventory (safe to run on every deploy)
await pool.query(`
  INSERT INTO products (id,name,price_cents,stock,image_url)
  VALUES
    ('twilight','Twilight Masquerade Pack',650,7,''),
    ('phantasmal','Phantasmal Flames Pack',750,4,''),
    ('mega','Mega Evolutions Pack',700,7,''),
    ('destined','Destined Rivals Pack',825,5,''),
    ('surging','Surging Sparks Pack',600,7,''),
    ('journey','Journey Together Pack',550,7,''),
    ('bbwf','Black Bolt & White Flare (12 packs)',9000,3,''),
    ('ascended-pack','Ascended Heroes Pack',900,18,''),
    ('ascended-etb','Ascended Heroes ETB',9000,1,'')
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    price_cents = EXCLUDED.price_cents,
    stock = EXCLUDED.stock,
    image_url = EXCLUDED.image_url;
`);
await pool.query(`
  DELETE FROM products
  WHERE id NOT IN (
    'twilight','phantasmal','mega','destined','surging','journey','bbwf','ascended-pack','ascended-etb'
  );
`);

async function cleanupExpiredReservations() {
  const now = Date.now();

  const expired = await pool.query(
    `SELECT * FROM reservations WHERE expires_at <= $1 AND status='reserved'`,
    [now]
  );

  for (const r of expired.rows) {
    await pool.query(
      `UPDATE products SET stock = stock + $1 WHERE id = $2`,
      [r.qty, r.product_id]
    );

    await pool.query(
      `UPDATE reservations SET status='canceled' WHERE id=$1`,
      [r.id]
    );
  }
}

function centsToUSD(cents) {
  return (cents / 100).toFixed(2);
}

async function paypalAccessToken() {
  const auth = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const data = await res.json();
  return data.access_token;
}

app.get("/api/products", async (req, res) => {
  await cleanupExpiredReservations();

  const { rows } = await pool.query(
    `SELECT * FROM products ORDER BY name`
  );

  res.json(rows);
});

app.post("/api/reserve", async (req, res) => {
  await cleanupExpiredReservations();

  const { productId, qty } = req.body;

  const product = await pool.query(
    `SELECT * FROM products WHERE id=$1`,
    [productId]
  );

  if (product.rows[0].stock < qty)
    return res.status(400).json({ error: "Out of stock" });

  const reservationId = crypto.randomUUID();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  await pool.query(
    `UPDATE products SET stock = stock - $1 WHERE id=$2`,
    [qty, productId]
  );

  await pool.query(
    `INSERT INTO reservations (id,product_id,qty,expires_at)
     VALUES ($1,$2,$3,$4)`,
    [reservationId, productId, qty, expiresAt]
  );

  res.json({ reservationId });
});

app.post("/api/reserve-cash", async (req, res) => {
  await cleanupExpiredReservations();

  const { productId, qty } = req.body;

  const product = await pool.query(
    `SELECT * FROM products WHERE id=$1`,
    [productId]
  );

  if (product.rows[0].stock < qty)
    return res.status(400).json({ error: "Out of stock" });

  const reservationId = crypto.randomUUID();
  const expiresAt =
    Date.now() + Number(CASH_HOLD_MINUTES) * 60 * 1000;

  await pool.query(
    `UPDATE products SET stock = stock - $1 WHERE id=$2`,
    [qty, productId]
  );

  await pool.query(
    `INSERT INTO reservations (id,product_id,qty,expires_at,method)
     VALUES ($1,$2,$3,$4,'cash')`,
    [reservationId, productId, qty, expiresAt]
  );

  res.json({ reservationId });
});

app.post("/api/create-order", async (req, res) => {
  const { reservationId } = req.body;

  const r = await pool.query(
    `SELECT * FROM reservations WHERE id=$1`,
    [reservationId]
  );

  const p = await pool.query(
    `SELECT * FROM products WHERE id=$1`,
    [r.rows[0].product_id]
  );

  const token = await paypalAccessToken();

  const totalCents =
    p.rows[0].price_cents * r.rows[0].qty;

  const order = await fetch(
    `${PAYPAL_API}/v2/checkout/orders`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: reservationId,
            amount: {
              currency_code: "USD",
              value: centsToUSD(totalCents)
            }
          }
        ]
      })
    }
  );

  const data = await order.json();
  res.json({ id: data.id });
});

app.post("/api/capture-order", async (req, res) => {
  const { orderID } = req.body;

  const token = await paypalAccessToken();

  const resp = await fetch(
    `${PAYPAL_API}/v2/checkout/orders/${orderID}/capture`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    }
  );

  const data = await resp.json();

  const reservationId =
    data.purchase_units[0].reference_id;

  await pool.query(
    `DELETE FROM reservations WHERE id=$1`,
    [reservationId]
  );

  res.json(data);
});
function requireAdmin(req, res) {
  const token = req.header("x-admin-token");
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// Create or update a product
app.post("/api/admin/upsert-product", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { id, name, price_cents, stock, image_url = "" } = req.body;
    if (!id || !name || typeof price_cents !== "number" || typeof stock !== "number") {
      return res.status(400).json({ error: "Missing/invalid fields" });
    }

    await pool.query(
      `INSERT INTO products (id, name, price_cents, stock, image_url)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         price_cents = EXCLUDED.price_cents,
         stock = EXCLUDED.stock,
         image_url = EXCLUDED.image_url`,
      [id, name, price_cents, stock, image_url]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// View active reservations (what is currently held)
app.get("/api/admin/reservations", async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    await cleanupExpiredReservations();

    const { rows } = await pool.query(
      `SELECT r.id AS reservation_id, r.product_id, p.name, r.qty, r.expires_at, r.method, r.status
       FROM reservations r
       JOIN products p ON p.id = r.product_id
       WHERE r.status = 'reserved'
       ORDER BY r.expires_at ASC`
    );

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
const port = process.env.PORT || 3000;

initDb().then(() => {
  app.listen(port, () =>
    console.log(`Server running on port ${port}`)
  );
});