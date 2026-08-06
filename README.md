# Tabe

The supply link between restaurants and their vendors. Ordering, offers, and a running ledger — all in one place.

This is the real, working website. Real signup, real login, shared data across users. Built as a single Node.js + Express server with SQLite for storage and JWT for authentication.

---

## What's in here

```
tabe/
├── package.json         npm dependencies
├── server.js            Express server, all API endpoints, SQLite schema, demo seed
├── public/
│   └── index.html       The frontend (single-page web app)
├── data/                Created on first run — holds tabe.db and the JWT secret
└── README.md            This file
```

A single command runs everything. The frontend is served by the same server that exposes the API.

---

## Run it on your computer

You need [Node.js 18+](https://nodejs.org/) installed. Then:

```bash
cd tabe
npm install
npm start
```

Open **http://localhost:3000** in your browser.

On the first run, the database is created at `data/tabe.db` and seeded with demo accounts. Both demo passwords are **`demo123`**:

- Restaurant demo: `spice@demo.tabe`
- Vendor demo: `guruji@demo.tabe`

Or sign up a fresh account — pick role (restaurant or vendor), enter your details, and you're in.

To reset the demo data, delete `data/tabe.db` and restart.

---

## What it does

**Restaurants can:**
- Sign up, browse all registered vendors, see balances at a glance
- Place orders from a vendor's catalogue
- See orders coming in this week
- Track a pantry with par-levels and low-stock alerts
- See spend insights by vendor
- Track outstanding balances per vendor
- Record payments
- Quick-reorder past orders
- Send and read notes on any order

**Vendors can:**
- Sign up, see receivables and a live sales dashboard
- Confirm, decline, or mark orders delivered
- See today's outgoing deliveries
- Track outstanding accounts (who owes most)
- Add, edit, delete, and stock-toggle products
- Run a bulk price update across the whole catalogue
- Post offers visible to all restaurants
- Per-customer ledger with payment-reminder action
- Edit their business profile (cut-off, delivery days, phone, min order)
- Notes back-and-forth on orders

Everything persists to SQLite. Multiple users register, log in, and see each other.

---

## Deploy it to the internet (free)

Two solid free options. **Railway** is recommended because its free tier supports a persistent disk for your SQLite database.

### Option A: Railway (recommended)

1. Create a [GitHub](https://github.com) account if you don't have one.
2. Push this `tabe/` folder to a new GitHub repo.
3. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → pick your repo.
4. In Railway → **Variables** → add `JWT_SECRET` = a long random string (32+ characters). Generate one at [random.org](https://www.random.org/strings/).
5. In Railway → **Settings** → **Volumes** → **New Volume**, mount path `/data`.
6. In Railway → **Variables** → also add `DATA_DIR` = `/data`.
7. Deploy. Railway gives you a public URL — that's your live site.

### Option B: Render (simpler, but SQLite resets on each deploy unless you pay for a disk)

1. Push to GitHub.
2. Go to [render.com](https://render.com) → **New Web Service** → connect your repo.
3. Build command: `npm install` · Start command: `npm start`
4. Add env var `JWT_SECRET` (long random string).
5. Deploy. You get a `*.onrender.com` URL.
6. For persistent SQLite, add a Render Disk (paid) or migrate to PostgreSQL.

### Want a real domain?

Buy one at [Namecheap](https://www.namecheap.com), [Porkbun](https://porkbun.com), or [Cloudflare](https://dash.cloudflare.com). In Railway/Render, add the custom domain and update your DNS records as they instruct. HTTPS is automatic.

---

## Environment variables

| Variable     | Default                           | What it does                                                            |
|--------------|-----------------------------------|-------------------------------------------------------------------------|
| `PORT`       | `3000`                            | Port the server listens on. Most hosts set this automatically.          |
| `DATA_DIR`   | `./data`                          | Folder for the SQLite DB and JWT secret. Set to a mounted volume on a host. |
| `JWT_SECRET` | auto-generated and saved to file  | Used to sign auth tokens. **Set this explicitly in production.**        |

---

## API reference (for future development)

All endpoints under `/api`. Auth via `Authorization: Bearer <token>` header. Tokens come from `/api/signup` or `/api/login` and last 30 days.

| Method | Path                          | Notes                                                     |
|--------|-------------------------------|-----------------------------------------------------------|
| POST   | `/api/signup`                 | `{ email, password, role, name, area, category, ... }`    |
| POST   | `/api/login`                  | `{ email, password }`                                     |
| GET    | `/api/me`                     | Current user                                              |
| PATCH  | `/api/profile`                | Update own profile                                        |
| GET    | `/api/vendors`                | List all vendors                                          |
| GET    | `/api/vendors/:id`            | Vendor detail + items + offers                            |
| GET    | `/api/restaurants`            | List all restaurants                                      |
| GET    | `/api/orders`                 | Mine (restaurant or vendor)                               |
| POST   | `/api/orders`                 | Restaurant places an order                                |
| PATCH  | `/api/orders/:id/status`      | Confirm / Decline / Delivered (with role checks)          |
| POST   | `/api/orders/:id/notes`       | Add a note                                                |
| GET    | `/api/payments`               | Mine                                                      |
| POST   | `/api/payments`               | Record a payment (auto-detects role)                      |
| GET    | `/api/ledger`                 | Balances per counterparty                                 |
| POST   | `/api/items`                  | Vendor adds product                                       |
| PATCH  | `/api/items/:id`              | Vendor edits product                                      |
| DELETE | `/api/items/:id`              | Vendor removes product                                    |
| POST   | `/api/items/bulk-price`       | Vendor adjusts all prices by %                            |
| GET    | `/api/offers`                 | All live offers                                           |
| POST   | `/api/offers`                 | Vendor creates an offer                                   |
| DELETE | `/api/offers/:id`             | Vendor removes an offer                                   |
| GET    | `/api/pantry`                 | Restaurant's pantry                                       |
| POST   | `/api/pantry`                 | Add a pantry item                                         |
| PATCH  | `/api/pantry/:id`             | Update a pantry item                                      |
| DELETE | `/api/pantry/:id`             | Remove a pantry item                                      |

---

## What's not in here yet (good v3 candidates)

- Email verification on signup, password reset
- Real-time updates (WebSockets so a vendor sees a new order without refresh)
- Standing/recurring orders
- Returns and credit notes
- Multi-user accounts (chef vs. owner vs. accountant under one restaurant)
- Mobile app wrappers (currently mobile-friendly responsive web)
- Real product photography upload
- Accounting export (CSV/PDF)
- Postgres migration for higher scale

---

## License

Private. Built for Jungle Labs Inc.
