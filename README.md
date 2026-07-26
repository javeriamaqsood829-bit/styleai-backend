# StyleAI Studio — Order Backend

Real orders, a database, an admin dashboard, and a slot for a Pakistani
payment gateway. This is what turns "Send Enquiry" from a fake toast message
into an actual order your business can see and fulfill.

```
Customer clicks "Send Enquiry"
        │
        ▼
Browser sends order to THIS backend  →  saved in database  →  email sent to you + customer
        │
        ▼
You open /admin/admin.html  →  see the order  →  update status as you fulfill it
```

## 1. Install & configure

```bash
npm install
cp .env.example .env
```

Generate an admin token and put it in `.env`:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Fill in `.env`:
- `ADMIN_TOKEN` — the secret from above (this is your admin password)
- `ALLOWED_ORIGINS` — your live website URL
- `SMTP_*` + `NOTIFY_EMAIL` — optional, but you'll want to know when an order
  comes in without needing to keep the admin panel open. Any email provider's
  SMTP works (Gmail with an "app password", Zoho Mail, your web host's mail, etc.)

## 2. Run it

```bash
npm start
```

Server starts on `http://localhost:3002`.

## 3. Open the admin dashboard

Visit `http://localhost:3002/admin/admin.html` (or your deployed backend URL
+ `/admin/admin.html`). It will ask for:
- **Backend URL** — same URL the server is running at
- **Admin token** — the `ADMIN_TOKEN` from your `.env`

From there you can see every order, search/filter, and change status
(pending → confirmed → processing → shipped → delivered, or cancelled).
Changing status automatically emails the customer if they gave an email.

**Keep the admin URL private** — anyone with the token can see all customer
orders (name, phone, address). Don't share it publicly, and rotate the token
if you ever suspect it leaked.

## 4. Deploy it

Same as the try-on backend — any Node host works:
- **Render.com** (easiest, free tier for testing)
- **Railway.app**
- **Fly.io**
- A VPS with `pm2`

⚠️ **Important:** the order database (`data/db.json`) is a plain file on disk.
On most free/serverless hosting tiers, disk storage does **not** persist
between deploys or restarts — your orders could disappear. For anything past
the testing stage, either:
- pick a host with a **persistent disk/volume** (Render's paid disks, Railway
  volumes, a real VPS), or
- swap `db.js` for a real hosted database (Postgres is the natural upgrade —
  free tiers exist on Supabase, Neon, Railway). The rest of `server.js`
  barely needs to change since it only touches `db.data.orders`.

## 5. Connect your website

In `styleai-studio.html`, find:
```js
const ORDERS_API_BASE = ""; // e.g. "https://styleai-orders.onrender.com"
```
Set it to your deployed backend URL. Until you do, the site keeps working
exactly as before (a toast message, no real order saved) — nothing breaks.

## Payment gateway (JazzCash / Easypaisa / Cards)

Right now every order defaults to **Cash on Delivery**, which is how most
Pakistani fashion/boutique stores actually operate — especially for
made-to-order pieces where the final price is confirmed with the customer
before payment anyway.

If/when you want online prepayment:

- Going directly to JazzCash or Easypaisa means **two separate merchant
  applications**, two dashboards, two integrations.
- Most stores instead use an **aggregator** — a single provider (e.g. Safepay,
  PayFast, Simpaisa) that gives you JazzCash + Easypaisa + card payments
  through **one** merchant account and **one** API.
- Once you've signed up with one and have real API keys, open `server.js`,
  find the `/api/payments/initiate` route, and replace the commented-out
  block with that provider's "create checkout session" call from their docs.
  Then set `PAYMENT_PROVIDER`, `PAYMENT_API_KEY`, `PAYMENT_SECRET` in `.env`.
- I've left this as a clearly-marked stub rather than guessing at a specific
  provider's exact API shape — pricing, KYC requirements, and endpoints
  change, so check current docs for whichever provider you pick before
  going live, and always test in their sandbox mode first.

## Order statuses

| Status | Meaning |
|---|---|
| `pending` | Just placed, not yet reviewed |
| `confirmed` | You've confirmed price/availability with the customer |
| `processing` | Being made/packed |
| `shipped` | Out for delivery |
| `delivered` | Complete |
| `cancelled` | Order cancelled |
