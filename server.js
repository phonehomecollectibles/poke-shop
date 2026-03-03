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

  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM products`);

  if (rows[0].c === 0) {
    await pool.query(
      `INSERT INTO products (id,name,price_cents,stock,image_url)
       VALUES
       ('tm-pack','Twilight Masquerade Pack',650,9,''),
       ('dr-pack','Destined Rivals Pack',750,4,'')`
    );
  }
}

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

const port = process.env.PORT || 3000;

initDb().then(() => {
  app.listen(port, () =>
    console.log(`Server running on port ${port}`)
  );
});