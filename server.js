// Tabe — Express + SQLite + JWT backend
// Single-file server. Run: npm install && npm start

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "tabe.db");
const SECRET_PATH = path.join(DATA_DIR, ".jwt-secret");
fs.mkdirSync(DATA_DIR, { recursive: true });

// JWT secret: from env, or generated and persisted locally
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  try {
    JWT_SECRET = fs.readFileSync(SECRET_PATH, "utf8").trim();
  } catch {
    JWT_SECRET = crypto.randomBytes(48).toString("hex");
    fs.writeFileSync(SECRET_PATH, JWT_SECRET, { mode: 0o600 });
  }
}

// ===== Database setup =====
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('restaurant','vendor')),
  name TEXT NOT NULL,
  area TEXT,
  emoji TEXT,
  category TEXT,
  cutoff TEXT,
  delivery_days TEXT,
  phone TEXT,
  min_order REAL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT,
  price REAL NOT NULL,
  in_stock INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  expiry TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  restaurant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Confirmed','Declined','Delivered')),
  total REAL NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  name TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  author_role TEXT NOT NULL CHECK(author_role IN ('restaurant','vendor')),
  text TEXT NOT NULL,
  date TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  restaurant_id TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pantry (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT,
  par_level INTEGER NOT NULL,
  current_stock INTEGER NOT NULL DEFAULT 0,
  vendor_id TEXT,
  FOREIGN KEY (restaurant_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_orders_vendor ON orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_items_vendor ON items(vendor_id);
CREATE INDEX IF NOT EXISTS idx_offers_vendor ON offers(vendor_id);
CREATE INDEX IF NOT EXISTS idx_payments_pair ON payments(vendor_id, restaurant_id);
CREATE INDEX IF NOT EXISTS idx_pantry_restaurant ON pantry(restaurant_id);
`);

// ===== Email notifications (Resend) =====
// Set RESEND_API_KEY (and optionally EMAIL_FROM) in env to activate. No-ops silently otherwise.
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const EMAIL_FROM = process.env.EMAIL_FROM || "Tabe <onboarding@resend.dev>";
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY || !to || to.endsWith("@demo.tabe")) return; // skip demo accounts
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
    });
  } catch (e) {
    console.warn("email send failed:", e.message);
  }
}
function emailWrap(title, body) {
  return `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
    <div style="background:#1f5a4f;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0">
      <div style="font-size:22px;font-weight:bold">Tabe</div>
    </div>
    <div style="border:1px solid #e5e5e5;border-top:none;padding:22px;border-radius:0 0 12px 12px">
      <h2 style="margin:0 0 10px;font-size:17px;color:#0f1a17">${title}</h2>
      <div style="font-size:14px;color:#333;line-height:1.5">${body}</div>
    </div></div>`;
}

// ===== Helpers =====
const uid = (p) => p + "_" + crypto.randomBytes(6).toString("hex");
const today = () => {
  const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const d = new Date(); return m[d.getMonth()] + " " + d.getDate();
};
const sanitizeUser = (u) => {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  rest.minOrder = rest.min_order; delete rest.min_order;
  rest.deliveryDays = rest.delivery_days; delete rest.delivery_days;
  return rest;
};
const sanitizeItem = (i) => i && { id:i.id, vendor_id:i.vendor_id, n:i.name, e:i.emoji, p:i.price, stock: i.in_stock === 1 };
const sanitizeOrder = (o, notesByOrder, itemsByOrder) => o && {
  id: o.id, v: o.vendor_id, r: o.restaurant_id, status: o.status, total: o.total, date: o.date,
  items: itemsByOrder ? (itemsByOrder[o.id] || []) : [],
  notes: notesByOrder ? (notesByOrder[o.id] || []) : []
};

// ===== Auth middleware =====
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.id);
    if (!user) return res.status(401).json({ error: "User not found" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) return res.status(403).json({ error: "Not allowed for this role" });
    next();
  };
}

// ===== Express =====
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Static frontend
app.use(express.static(path.join(__dirname, "public")));

// --- Auth ---
app.post("/api/signup", (req, res) => {
  const { email, password, role, name, area, emoji, category, cutoff, deliveryDays, phone, minOrder } = req.body || {};
  if (!email || !password || !role || !name) return res.status(400).json({ error: "Missing fields" });
  if (!["restaurant","vendor"].includes(role)) return res.status(400).json({ error: "Invalid role" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: "An account with that email already exists" });
  const hash = bcrypt.hashSync(password, 10);
  const id = uid(role === "restaurant" ? "r" : "v");
  db.prepare(`INSERT INTO users (id,email,password_hash,role,name,area,emoji,category,cutoff,delivery_days,phone,min_order,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, email.toLowerCase(), hash, role, name, area||null, emoji||(role==="restaurant"?"🍽️":"🏪"),
         category||null, cutoff||null, deliveryDays||null, phone||null, minOrder||0, new Date().toISOString());
  const token = jwt.sign({ id, role }, JWT_SECRET, { expiresIn: "30d" });
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  res.json({ token, user: sanitizeUser(user) });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase());
  if (!user) return res.status(401).json({ error: "Wrong email or password" });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: "Wrong email or password" });
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: sanitizeUser(user) });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

app.patch("/api/profile", auth, (req, res) => {
  const u = req.user;
  const { name, area, emoji, category, cutoff, deliveryDays, phone, minOrder } = req.body || {};
  db.prepare(`UPDATE users SET name=COALESCE(?,name), area=COALESCE(?,area), emoji=COALESCE(?,emoji),
    category=COALESCE(?,category), cutoff=COALESCE(?,cutoff), delivery_days=COALESCE(?,delivery_days),
    phone=COALESCE(?,phone), min_order=COALESCE(?,min_order) WHERE id=?`)
    .run(name||null, area||null, emoji||null, category||null, cutoff||null, deliveryDays||null,
         phone||null, (minOrder==null?null:minOrder), u.id);
  const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(u.id);
  res.json({ user: sanitizeUser(fresh) });
});

// --- Public-ish vendor browsing (any authed user) ---
app.get("/api/vendors", auth, (_req, res) => {
  const rows = db.prepare("SELECT * FROM users WHERE role='vendor' ORDER BY name").all();
  res.json({ vendors: rows.map(sanitizeUser) });
});

app.get("/api/vendors/:id", auth, (req, res) => {
  const v = db.prepare("SELECT * FROM users WHERE id=? AND role='vendor'").get(req.params.id);
  if (!v) return res.status(404).json({ error: "Vendor not found" });
  const items = db.prepare("SELECT * FROM items WHERE vendor_id=? ORDER BY name").all(v.id);
  const offers = db.prepare("SELECT * FROM offers WHERE vendor_id=? ORDER BY created_at DESC").all(v.id);
  res.json({ vendor: sanitizeUser(v), items: items.map(sanitizeItem), offers });
});

// --- Restaurants list (any user; vendors use it to see their customers) ---
app.get("/api/restaurants", auth, (_req, res) => {
  const rows = db.prepare("SELECT * FROM users WHERE role='restaurant' ORDER BY name").all();
  res.json({ restaurants: rows.map(sanitizeUser) });
});

// --- Orders ---
function loadOrdersForUser(user) {
  const where = user.role === "restaurant" ? "restaurant_id = ?" : "vendor_id = ?";
  const rows = db.prepare(`SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC`).all(user.id);
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const oi = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders})`).all(...ids);
  const ns = db.prepare(`SELECT * FROM notes WHERE order_id IN (${placeholders}) ORDER BY id ASC`).all(...ids);
  const items = {}, notes = {};
  oi.forEach(x => { (items[x.order_id] = items[x.order_id] || []).push({ name:x.name, qty:x.qty, price:x.price }); });
  ns.forEach(x => { (notes[x.order_id] = notes[x.order_id] || []).push({ a: x.author_role==="restaurant"?"R":"V", t:x.text, d:x.date }); });
  return rows.map(o => sanitizeOrder(o, notes, items));
}
app.get("/api/orders", auth, (req, res) => {
  res.json({ orders: loadOrdersForUser(req.user) });
});

app.post("/api/orders", auth, requireRole("restaurant"), (req, res) => {
  const { vendorId, items } = req.body || {};
  if (!vendorId || !Array.isArray(items) || !items.length) return res.status(400).json({ error: "vendorId and items required" });
  const v = db.prepare("SELECT * FROM users WHERE id=? AND role='vendor'").get(vendorId);
  if (!v) return res.status(404).json({ error: "Vendor not found" });
  const total = Math.round(items.reduce((s, it) => s + (Number(it.qty)||0) * (Number(it.price)||0), 0) * 100) / 100;
  const id = uid("o");
  const date = today(), nowIso = new Date().toISOString();
  const insertOrder = db.prepare(`INSERT INTO orders (id,vendor_id,restaurant_id,status,total,date,created_at) VALUES (?,?,?,?,?,?,?)`);
  const insertItem = db.prepare(`INSERT INTO order_items (order_id,name,qty,price) VALUES (?,?,?,?)`);
  const tx = db.transaction(() => {
    insertOrder.run(id, vendorId, req.user.id, "Pending", total, date, nowIso);
    items.forEach(it => insertItem.run(id, String(it.name), Number(it.qty)||0, Number(it.price)||0));
  });
  tx();
  // notify vendor of the new order
  const itemsHtml = items.map(it => `<li>${it.qty} × ${it.name} — $${(it.qty * it.price).toFixed(2)}</li>`).join("");
  sendEmail(v.email, `New order from ${req.user.name} — $${total.toFixed(2)}`,
    emailWrap("You have a new order on Tabe",
      `<p><b>${req.user.name}</b> just placed an order:</p><ul>${itemsHtml}</ul>
       <p><b>Total: $${total.toFixed(2)}</b></p>
       <p>Open Tabe to confirm it.</p>`));
  res.json({ orderId: id, total });
});

app.patch("/api/orders/:id/status", auth, (req, res) => {
  const { status } = req.body || {};
  if (!["Pending","Confirmed","Declined","Delivered"].includes(status)) return res.status(400).json({ error: "Bad status" });
  const o = db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if (!o) return res.status(404).json({ error: "Order not found" });
  // Authorization: vendor can confirm/decline/deliver their own; restaurant can mark received (Delivered)
  if (req.user.role === "vendor" && o.vendor_id !== req.user.id) return res.status(403).json({ error: "Not your order" });
  if (req.user.role === "restaurant") {
    if (o.restaurant_id !== req.user.id) return res.status(403).json({ error: "Not your order" });
    if (status !== "Delivered") return res.status(403).json({ error: "Only vendors can change to that status" });
    if (o.status !== "Confirmed") return res.status(400).json({ error: "Can only mark a Confirmed order as received" });
  }
  db.prepare("UPDATE orders SET status=? WHERE id=?").run(status, o.id);
  // notify the other side of the status change
  if (req.user.role === "vendor") {
    const rest = db.prepare("SELECT * FROM users WHERE id=?").get(o.restaurant_id);
    if (rest) {
      const msgs = {
        Confirmed: ["Your order was confirmed ✓", `<p><b>${req.user.name}</b> confirmed your order of $${o.total.toFixed(2)}. It's on the schedule.</p>`],
        Declined: ["Your order was declined", `<p><b>${req.user.name}</b> couldn't take your order of $${o.total.toFixed(2)}. Reach out to them or try another vendor.</p>`],
        Delivered: ["Your order was delivered 📦", `<p><b>${req.user.name}</b> marked your $${o.total.toFixed(2)} order as delivered. The bill is now on your Tabe ledger.</p>`],
      };
      const m = msgs[status];
      if (m) sendEmail(rest.email, m[0], emailWrap(m[0], m[1]));
    }
  }
  res.json({ ok: true });
});

app.post("/api/orders/:id/notes", auth, (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Empty note" });
  const o = db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if (!o) return res.status(404).json({ error: "Order not found" });
  if (req.user.id !== o.vendor_id && req.user.id !== o.restaurant_id) return res.status(403).json({ error: "Not allowed" });
  db.prepare("INSERT INTO notes (order_id, author_role, text, date) VALUES (?,?,?,?)").run(o.id, req.user.role, text.trim(), today());
  res.json({ ok: true });
});

// --- Payments + ledger ---
app.get("/api/payments", auth, (req, res) => {
  const where = req.user.role === "restaurant" ? "restaurant_id = ?" : "vendor_id = ?";
  const rows = db.prepare(`SELECT * FROM payments WHERE ${where} ORDER BY created_at DESC`).all(req.user.id);
  res.json({ payments: rows.map(p => ({ id:p.id, v:p.vendor_id, r:p.restaurant_id, amount:p.amount, method:p.method, date:p.date })) });
});

app.post("/api/payments", auth, (req, res) => {
  const { counterpartyId, amount, method } = req.body || {};
  const amt = Number(amount);
  if (!counterpartyId || !amt || amt <= 0) return res.status(400).json({ error: "counterpartyId and amount required" });
  const other = db.prepare("SELECT * FROM users WHERE id=?").get(counterpartyId);
  if (!other) return res.status(404).json({ error: "Counterparty not found" });
  // Role check: restaurant pays a vendor; vendor records a payment received from restaurant
  let vendorId, restaurantId;
  if (req.user.role === "restaurant") {
    if (other.role !== "vendor") return res.status(400).json({ error: "Counterparty must be a vendor" });
    vendorId = other.id; restaurantId = req.user.id;
  } else {
    if (other.role !== "restaurant") return res.status(400).json({ error: "Counterparty must be a restaurant" });
    vendorId = req.user.id; restaurantId = other.id;
  }
  const id = uid("p");
  db.prepare("INSERT INTO payments (id,vendor_id,restaurant_id,amount,method,date,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, vendorId, restaurantId, Math.round(amt * 100) / 100, method || "Cash", today(), new Date().toISOString());
  // notify the counterparty
  sendEmail(other.email, `Payment of $${amt.toFixed(2)} recorded on Tabe`,
    emailWrap("Payment recorded",
      `<p><b>${req.user.name}</b> recorded a payment of <b>$${amt.toFixed(2)}</b> (${method || "Cash"}).</p>
       <p>Your shared balance has been updated — open Tabe to see the ledger.</p>`));
  res.json({ paymentId: id });
});

app.get("/api/ledger", auth, (req, res) => {
  // For current user, compute balance with each counterparty (vendor or restaurant)
  if (req.user.role === "restaurant") {
    const billsRows = db.prepare(`SELECT vendor_id AS cp, SUM(total) AS sum FROM orders WHERE restaurant_id=? AND status IN ('Confirmed','Delivered') GROUP BY vendor_id`).all(req.user.id);
    const paysRows = db.prepare(`SELECT vendor_id AS cp, SUM(amount) AS sum FROM payments WHERE restaurant_id=? GROUP BY vendor_id`).all(req.user.id);
    const map = {};
    billsRows.forEach(r => { map[r.cp] = (map[r.cp]||0) + r.sum; });
    paysRows.forEach(r => { map[r.cp] = (map[r.cp]||0) - r.sum; });
    const out = Object.entries(map).map(([cp, bal]) => ({ counterpartyId: cp, balance: Math.round(bal*100)/100 }));
    res.json({ ledger: out });
  } else {
    const billsRows = db.prepare(`SELECT restaurant_id AS cp, SUM(total) AS sum FROM orders WHERE vendor_id=? AND status IN ('Confirmed','Delivered') GROUP BY restaurant_id`).all(req.user.id);
    const paysRows = db.prepare(`SELECT restaurant_id AS cp, SUM(amount) AS sum FROM payments WHERE vendor_id=? GROUP BY restaurant_id`).all(req.user.id);
    const map = {};
    billsRows.forEach(r => { map[r.cp] = (map[r.cp]||0) + r.sum; });
    paysRows.forEach(r => { map[r.cp] = (map[r.cp]||0) - r.sum; });
    const out = Object.entries(map).map(([cp, bal]) => ({ counterpartyId: cp, balance: Math.round(bal*100)/100 }));
    res.json({ ledger: out });
  }
});

// --- Items (vendor) ---
app.post("/api/items", auth, requireRole("vendor"), (req, res) => {
  const { name, emoji, price } = req.body || {};
  const pr = Number(price);
  if (!name || !pr || pr <= 0) return res.status(400).json({ error: "name and price required" });
  const id = uid("i");
  db.prepare("INSERT INTO items (id,vendor_id,name,emoji,price,in_stock) VALUES (?,?,?,?,?,1)").run(id, req.user.id, String(name), emoji||"📦", Math.round(pr*100)/100);
  res.json({ itemId: id });
});
app.patch("/api/items/:id", auth, requireRole("vendor"), (req, res) => {
  const it = db.prepare("SELECT * FROM items WHERE id=?").get(req.params.id);
  if (!it || it.vendor_id !== req.user.id) return res.status(404).json({ error: "Item not found" });
  const { name, emoji, price, inStock } = req.body || {};
  db.prepare("UPDATE items SET name=COALESCE(?,name), emoji=COALESCE(?,emoji), price=COALESCE(?,price), in_stock=COALESCE(?,in_stock) WHERE id=?")
    .run(name||null, emoji||null, (price==null?null:Math.round(Number(price)*100)/100), (inStock==null?null:(inStock?1:0)), it.id);
  res.json({ ok: true });
});
app.delete("/api/items/:id", auth, requireRole("vendor"), (req, res) => {
  const it = db.prepare("SELECT * FROM items WHERE id=?").get(req.params.id);
  if (!it || it.vendor_id !== req.user.id) return res.status(404).json({ error: "Item not found" });
  db.prepare("DELETE FROM items WHERE id=?").run(it.id);
  res.json({ ok: true });
});
app.post("/api/items/bulk-price", auth, requireRole("vendor"), (req, res) => {
  const pct = Number(req.body && req.body.percent);
  if (isNaN(pct)) return res.status(400).json({ error: "percent required" });
  const factor = 1 + pct / 100;
  db.prepare("UPDATE items SET price = ROUND(price * ? * 100) / 100 WHERE vendor_id=?").run(factor, req.user.id);
  res.json({ ok: true });
});

// --- Offers (vendor) ---
app.post("/api/offers", auth, requireRole("vendor"), (req, res) => {
  const { title, description, expiry } = req.body || {};
  if (!title) return res.status(400).json({ error: "title required" });
  const id = uid("of");
  db.prepare("INSERT INTO offers (id,vendor_id,title,description,expiry,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, req.user.id, title, description||"", expiry||"Limited time", new Date().toISOString());
  res.json({ offerId: id });
});
app.delete("/api/offers/:id", auth, requireRole("vendor"), (req, res) => {
  const of = db.prepare("SELECT * FROM offers WHERE id=?").get(req.params.id);
  if (!of || of.vendor_id !== req.user.id) return res.status(404).json({ error: "Offer not found" });
  db.prepare("DELETE FROM offers WHERE id=?").run(of.id);
  res.json({ ok: true });
});
app.get("/api/offers", auth, (_req, res) => {
  const rows = db.prepare(`SELECT o.*, u.name as vendor_name FROM offers o JOIN users u ON u.id=o.vendor_id ORDER BY o.created_at DESC`).all();
  res.json({ offers: rows });
});

// --- Pantry (restaurant) ---
app.get("/api/pantry", auth, requireRole("restaurant"), (req, res) => {
  const rows = db.prepare("SELECT * FROM pantry WHERE restaurant_id=? ORDER BY name").all(req.user.id);
  res.json({ pantry: rows.map(p => ({ id:p.id, name:p.name, emoji:p.emoji, par:p.par_level, stock:p.current_stock, vid:p.vendor_id })) });
});
app.post("/api/pantry", auth, requireRole("restaurant"), (req, res) => {
  const { name, emoji, par, stock, vid } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const id = uid("pn");
  db.prepare("INSERT INTO pantry (id,restaurant_id,name,emoji,par_level,current_stock,vendor_id) VALUES (?,?,?,?,?,?,?)")
    .run(id, req.user.id, name, emoji||"📦", Math.max(1, parseInt(par,10)||1), Math.max(0, parseInt(stock,10)||0), vid||null);
  res.json({ pantryId: id });
});
app.patch("/api/pantry/:id", auth, requireRole("restaurant"), (req, res) => {
  const p = db.prepare("SELECT * FROM pantry WHERE id=?").get(req.params.id);
  if (!p || p.restaurant_id !== req.user.id) return res.status(404).json({ error: "Pantry item not found" });
  const { name, emoji, par, stock, vid } = req.body || {};
  db.prepare("UPDATE pantry SET name=COALESCE(?,name), emoji=COALESCE(?,emoji), par_level=COALESCE(?,par_level), current_stock=COALESCE(?,current_stock), vendor_id=COALESCE(?,vendor_id) WHERE id=?")
    .run(name||null, emoji||null, (par==null?null:Math.max(1, parseInt(par,10))), (stock==null?null:Math.max(0, parseInt(stock,10))), (vid===undefined?null:vid), p.id);
  res.json({ ok: true });
});
app.delete("/api/pantry/:id", auth, requireRole("restaurant"), (req, res) => {
  const p = db.prepare("SELECT * FROM pantry WHERE id=?").get(req.params.id);
  if (!p || p.restaurant_id !== req.user.id) return res.status(404).json({ error: "Pantry item not found" });
  db.prepare("DELETE FROM pantry WHERE id=?").run(p.id);
  res.json({ ok: true });
});

// --- Invite links ---
function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "user";
}
function ensureInviteCode(userId, name) {
  let row = db.prepare("SELECT code FROM invite_codes WHERE user_id=?").get(userId);
  if (row) return row.code;
  let base = slugify(name), code = base, n = 1;
  while (db.prepare("SELECT 1 FROM invite_codes WHERE code=?").get(code)) { n++; code = base + "-" + n; }
  db.prepare("INSERT INTO invite_codes (code, user_id, created_at) VALUES (?,?,?)").run(code, userId, new Date().toISOString());
  return code;
}
app.get("/api/my-invite", auth, (req, res) => {
  const code = ensureInviteCode(req.user.id, req.user.name);
  res.json({ code, url: (process.env.PUBLIC_URL || "") + "/join/" + code });
});
app.get("/api/invite/:code", (req, res) => {
  const row = db.prepare("SELECT u.id, u.name, u.role, u.emoji, u.area, u.category FROM invite_codes ic JOIN users u ON u.id = ic.user_id WHERE ic.code = ?").get(req.params.code);
  if (!row) return res.status(404).json({ error: "Invite not found" });
  res.json({ inviter: row });
});
app.get("/join/:code", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// --- Bulk catalogue import (vendor) ---
// Accepts { text: "Basmati Rice 20kg, 46\nToor Dal 10kg, 31.50\n..." }
// Each line: product name, then price as the last comma/tab-separated field.
app.post("/api/items/bulk", auth, requireRole("vendor"), (req, res) => {
  const text = String((req.body && req.body.text) || "");
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const created = [], skipped = [];
  const ins = db.prepare("INSERT INTO items (id,vendor_id,name,emoji,price,in_stock) VALUES (?,?,?,?,?,1)");
  const tx = db.transaction(() => {
    lines.forEach(line => {
      const parts = line.split(/[,\t]/).map(x => x.trim()).filter(Boolean);
      if (parts.length < 2) { skipped.push(line); return; }
      const priceRaw = parts[parts.length - 1].replace(/[^0-9.]/g, "");
      const price = parseFloat(priceRaw);
      const name = parts.slice(0, -1).join(", ");
      if (!name || !price || price <= 0) { skipped.push(line); return; }
      ins.run(uid("i"), req.user.id, name, "📦", Math.round(price * 100) / 100);
      created.push(name);
    });
  });
  tx();
  res.json({ created: created.length, skipped });
});

// --- Health ---
app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- Seed demo data if empty ---
function seedIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  if (count > 0) return;
  console.log("Seeding demo data...");
  const hash = (pw) => bcrypt.hashSync(pw, 10);
  const ins = db.prepare(`INSERT INTO users (id,email,password_hash,role,name,area,emoji,category,cutoff,delivery_days,phone,min_order,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const restaurants = [
    { id:"r_demo1", email:"spice@demo.tabe", name:"Spice Route Kitchen", area:"Surrey, BC", emoji:"🍛" },
    { id:"r_demo2", email:"tandoori@demo.tabe", name:"Tandoori Flame", area:"Surrey, BC", emoji:"🔥" },
    { id:"r_demo3", email:"punjab@demo.tabe", name:"Punjab Junction", area:"Surrey, BC", emoji:"🫓" }
  ];
  const vendors = [
    { id:"v_demo1", email:"daytoday@demo.tabe", name:"Day to Day Wholesale", emoji:"🧅", category:"Produce & fresh · Cash & Carry", cutoff:"Order by 2 PM, same-day pickup", deliveryDays:"Mon–Sat (pickup)", phone:"+1 604 555 0102", minOrder:0,
      items:[["d1","Onions 20kg","🧅",17.0,1],["d2","Potatoes 20kg","🥔",19.5,1],["d3","Tomatoes 10kg","🍅",21.0,1],["d4","Cilantro (12 bunches)","🌿",9.5,1],["d5","Green Chillies 5kg","🌶️",18.0,0],["d6","Ginger 5kg","🫚",24.0,1]],
      offers:[["of1","Onions 20kg → $15 (was $17)","Overstock special. Limit 5 bags per restaurant.","While stock lasts"]] },
    { id:"v_demo2", email:"guruji@demo.tabe", name:"Guruji Foods", emoji:"🌾", category:"Rice, dal, flour · Wholesale", cutoff:"Order by 4 PM for next-day delivery", deliveryDays:"Mon, Wed, Fri", phone:"+1 604 555 0144", minOrder:50,
      items:[["g1","Basmati Rice 20kg","🍚",46.0,1],["g2","Atta / Flour 20kg","🌾",24.0,1],["g3","Toor Dal 10kg","🟡",31.5,1],["g4","Chana Dal 10kg","🫘",28.0,1],["g5","Chickpeas 10kg","🟤",26.0,1],["g6","Mustard Oil 5L","🛢️",22.0,1]],
      offers:[["of2","10% off Basmati Rice (20kg)","New crop just landed — this week only.","Ends May 31"]] },
    { id:"v_demo3", email:"gagan@demo.tabe", name:"Gagan Foods", emoji:"🧈", category:"Dairy, paneer & frozen · Distributor", cutoff:"Order by 6 PM, delivers Tue/Fri", deliveryDays:"Tue & Fri", phone:"+1 604 555 0177", minOrder:75,
      items:[["a1","Paneer 5kg","🧀",41.0,1],["a2","Ghee 5L","🫙",57.0,1],["a3","Yogurt 10kg","🥛",24.0,1],["a4","Butter 5kg","🧈",38.0,1],["a5","Frozen Samosa 100pc","🥟",27.0,1],["a6","Naan frozen 200pc","🫓",43.0,1]],
      offers:[["of3","Free delivery over $150","On all Tue/Fri routes across Surrey & Metro Vancouver.","Ongoing"]] }
  ];
  const tx = db.transaction(() => {
    restaurants.forEach(r => ins.run(r.id, r.email, hash("demo123"), "restaurant", r.name, r.area, r.emoji, null, null, null, null, 0, new Date().toISOString()));
    vendors.forEach(v => {
      ins.run(v.id, v.email, hash("demo123"), "vendor", v.name, "Surrey, BC", v.emoji, v.category, v.cutoff, v.deliveryDays, v.phone, v.minOrder, new Date().toISOString());
      v.items.forEach(([id,name,emoji,price,stock]) => db.prepare("INSERT INTO items (id,vendor_id,name,emoji,price,in_stock) VALUES (?,?,?,?,?,?)").run(v.id+"_"+id, v.id, name, emoji, price, stock));
      v.offers.forEach(([id,t,d,e]) => db.prepare("INSERT INTO offers (id,vendor_id,title,description,expiry,created_at) VALUES (?,?,?,?,?,?)").run(v.id+"_"+id, v.id, t, d, e, new Date().toISOString()));
    });
    // pantry for Spice Route
    const pantry = [
      ["pn1","Basmati Rice 20kg","🍚",4,1,"v_demo2"], ["pn2","Atta / Flour 20kg","🌾",3,2,"v_demo2"],
      ["pn3","Toor Dal 10kg","🟡",2,0,"v_demo2"], ["pn4","Paneer 5kg","🧀",4,1,"v_demo3"],
      ["pn5","Ghee 5L","🫙",2,2,"v_demo3"], ["pn6","Onions 20kg","🧅",5,3,"v_demo1"],
      ["pn7","Yogurt 10kg","🥛",3,0,"v_demo3"]
    ];
    pantry.forEach(([id,n,e,par,stk,vid]) => db.prepare("INSERT INTO pantry (id,restaurant_id,name,emoji,par_level,current_stock,vendor_id) VALUES (?,?,?,?,?,?,?)").run(id, "r_demo1", n, e, par, stk, vid));
    // seed a few orders + payments to make the demo feel alive
    const seedOrders = [
      ["v_demo2","r_demo1","Delivered",116,"May 22",[["Basmati Rice 20kg",2,46],["Atta / Flour 20kg",1,24]]],
      ["v_demo3","r_demo1","Delivered",139,"May 24",[["Paneer 5kg",2,41],["Ghee 5L",1,57]]],
      ["v_demo1","r_demo1","Confirmed",55,"May 25",[["Onions 20kg",2,17],["Tomatoes 10kg",1,21]]],
      ["v_demo2","r_demo2","Pending",63,"May 23",[["Toor Dal 10kg",2,31.5]]],
      ["v_demo3","r_demo3","Confirmed",48,"May 24",[["Yogurt 10kg",2,24]]],
      ["v_demo2","r_demo3","Delivered",46,"May 19",[["Basmati Rice 20kg",1,46]]]
    ];
    seedOrders.forEach(([vid,rid,st,total,date,items]) => {
      const oid = uid("o");
      db.prepare("INSERT INTO orders (id,vendor_id,restaurant_id,status,total,date,created_at) VALUES (?,?,?,?,?,?,?)").run(oid,vid,rid,st,total,date,new Date().toISOString());
      items.forEach(([n,q,p]) => db.prepare("INSERT INTO order_items (order_id,name,qty,price) VALUES (?,?,?,?)").run(oid,n,q,p));
    });
    const seedPays = [["v_demo2","r_demo1",100,"e-Transfer","May 21"],["v_demo3","r_demo3",30,"e-Transfer","May 25"]];
    seedPays.forEach(([vid,rid,amt,m,d]) => db.prepare("INSERT INTO payments (id,vendor_id,restaurant_id,amount,method,date,created_at) VALUES (?,?,?,?,?,?,?)").run(uid("p"),vid,rid,amt,m,d,new Date().toISOString()));
  });
  tx();
  console.log("Seeded demo data. Demo credentials: spice@demo.tabe / demo123 (restaurant), guruji@demo.tabe / demo123 (vendor).");
}
seedIfEmpty();

// Serve frontend SPA (catch-all)
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Tabe running on port ${PORT}`);
});
