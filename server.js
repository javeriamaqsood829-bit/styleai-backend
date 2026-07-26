import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import nodemailer from "nodemailer";
import { db, initDb } from "./db.js";

// ---------------------------------------------------------------------------
// StyleAI Studio — Order backend
//
// What this gives you that the frontend alone never could:
//   1. A real database of orders (survives even if a customer closes their tab)
//   2. An admin dashboard (public/admin.html) to see & confirm orders
//   3. Email confirmations to you and the customer
//   4. A slot to plug in a real Pakistani payment gateway (JazzCash/Easypaisa/
//      cards) when you're ready — see README.md
//
// Order flow this implements:
//   pending -> confirmed -> processing -> shipped -> delivered
//                        \-> cancelled
// ---------------------------------------------------------------------------

await initDb();

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(express.json());
app.use("/admin", express.static(path.join(__dirname, "public")));

// ---- simple in-memory rate limit for order creation (swap for Redis in production) ----
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 5; // 5 orders/minute/IP is plenty for a real shopper, blocks spam bots
}

// ---- admin auth middleware ----
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!process.env.ADMIN_TOKEN) {
    return res.status(500).json({ error: "Server misconfigured: ADMIN_TOKEN not set." });
  }
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Invalid admin token." });
  }
  next();
}

// ---- email ----
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
async function sendMail(to, subject, html) {
  if (!transporter) return; // email not configured — order creation still succeeds
  try {
    await transporter.sendMail({ from: `"${process.env.STORE_NAME || "StyleAI Studio"}" <${process.env.SMTP_USER}>`, to, subject, html });
  } catch (err) {
    console.error("Email send failed:", err.message);
  }
}
function orderItemsHtml(items) {
  return items.map(i => `<li>${i.qty} × ${i.name}${i.note ? ` (${i.note})` : ""}</li>`).join("");
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---- create order ----
app.post("/api/orders", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    if (rateLimited(ip)) return res.status(429).json({ error: "Too many requests, please wait a moment." });

    const { name, phone, email, address, city, notes, items, paymentMethod } = req.body;
    if (!name || !phone || !address || !city) {
      return res.status(400).json({ error: "Name, phone, address and city are required." });
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "Your bag is empty." });
    }

    const order = {
      id: nanoid(10),
      createdAt: new Date().toISOString(),
      name, phone, email: email || null, address, city, notes: notes || "",
      items,
      paymentMethod: paymentMethod === "online" ? "online" : "cod",
      paymentStatus: paymentMethod === "online" ? "awaiting_payment" : "unpaid_cod",
      status: "pending",
      statusHistory: [{ status: "pending", at: new Date().toISOString() }],
    };

    db.data.orders.push(order);
    await db.write();

    const itemsHtml = orderItemsHtml(items);
    if (process.env.NOTIFY_EMAIL) {
      sendMail(process.env.NOTIFY_EMAIL, `New order #${order.id} — ${name}`,
        `<h3>New order received</h3><p><b>${name}</b> · ${phone} · ${city}</p><p>${address}</p><ul>${itemsHtml}</ul><p>Payment: ${order.paymentMethod}</p>${notes ? `<p>Notes: ${notes}</p>` : ""}`);
    }
    if (email) {
      sendMail(email, `We received your order — #${order.id}`,
        `<p>Hi ${name}, thanks for your order! Our team will confirm final pricing and reach out on ${phone} shortly.</p><ul>${itemsHtml}</ul><p>Order reference: <b>${order.id}</b></p>`);
    }

    res.json({ orderId: order.id, status: order.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not place order.", detail: err.message });
  }
});

// ---- customer: check their own order status (needs id + phone, no admin token) ----
app.get("/api/orders/:id", (req, res) => {
  const { phone } = req.query;
  const order = db.data.orders.find(o => o.id === req.params.id);
  if (!order || (phone && order.phone !== phone)) return res.status(404).json({ error: "Order not found." });
  res.json(order);
});

// ---- customer: look up all their orders by phone number alone (no order ID needed) ----
app.get("/api/orders/by-phone/:phone", (req, res) => {
  const phone = req.params.phone.trim();
  if (!phone) return res.status(400).json({ error: "Phone number is required." });
  const matches = db.data.orders
    .filter(o => o.phone === phone)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders: matches });
});

// ---- admin: list all orders ----
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const orders = [...db.data.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders });
});

// ---- admin: update order status ----
const VALID_STATUSES = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
app.patch("/api/admin/orders/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status." });
  const order = db.data.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  order.status = status;
  order.statusHistory.push({ status, at: new Date().toISOString() });
  await db.write();
  if (order.email) {
    sendMail(order.email, `Order #${order.id} update — ${status}`,
      `<p>Hi ${order.name}, your order status is now: <b>${status}</b>.</p>`);
  }
  res.json({ ok: true, order });
});

// ---- admin: mark payment status (e.g. after confirming a bank transfer manually) ----
app.patch("/api/admin/orders/:id/payment", requireAdmin, async (req, res) => {
  const { paymentStatus } = req.body;
  const order = db.data.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  order.paymentStatus = paymentStatus;
  await db.write();
  res.json({ ok: true, order });
});

// ---------------------------------------------------------------------------
// PAYMENT GATEWAY — stub.
//
// Pakistan's two dominant wallets (JazzCash, Easypaisa) each require their own
// merchant application if you integrate them directly. Most stores instead go
// through an aggregator (Safepay, PayFast, Simpaisa, etc.) that gives you
// JazzCash + Easypaisa + card payments through ONE merchant relationship and
// ONE API. Once you've signed up with one and have real API keys, replace the
// body of /api/payments/initiate below with that provider's "create checkout
// session" call (their docs will give you the exact request shape) and point
// PAYMENT_PROVIDER/PAYMENT_API_KEY/PAYMENT_SECRET in .env at it.
//
// Until then, this endpoint just tells the frontend "online payment isn't
// configured yet", and the site falls back to Cash on Delivery — which is
// how most Pakistani fashion stores operate anyway.
// ---------------------------------------------------------------------------
app.post("/api/payments/initiate", async (req, res) => {
  if (!process.env.PAYMENT_PROVIDER || !process.env.PAYMENT_API_KEY) {
    return res.status(501).json({ error: "Online payment isn't configured yet. Use Cash on Delivery, or see README.md to add a gateway." });
  }
  const { orderId } = req.body;
  const order = db.data.orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ error: "Order not found." });

  // --- Replace this block with your chosen gateway's real "create session" call ---
  // Example shape (adapt field names to your provider's docs):
  //
  // const resp = await fetch("https://api.<your-gateway>.com/v1/checkout/sessions", {
  //   method: "POST",
  //   headers: { "Authorization": `Bearer ${process.env.PAYMENT_API_KEY}`, "Content-Type": "application/json" },
  //   body: JSON.stringify({
  //     amount: order.items.length, // you'll compute a real total once you have fixed pricing
  //     currency: "PKR",
  //     reference: order.id,
  //     redirect_url: `${process.env.ALLOWED_ORIGINS?.split(",")[0]}/order-confirmed?id=${order.id}`,
  //   }),
  // });
  // const data = await resp.json();
  // return res.json({ checkoutUrl: data.checkout_url });

  res.status(501).json({ error: "Payment gateway not yet wired up — see the comment block in server.js." });
});

// ---- webhook the gateway calls when a payment succeeds/fails ----
app.post("/api/payments/webhook", async (req, res) => {
  // IMPORTANT: before trusting this in production, verify the request's
  // signature using your gateway's documented method — otherwise anyone
  // could POST here and mark an order "paid" for free.
  const { orderId, status } = req.body;
  const order = db.data.orders.find(o => o.id === orderId);
  if (order && status === "success") {
    order.paymentStatus = "paid";
    await db.write();
  }
  res.json({ received: true });
});

const port = process.env.PORT || 3002;
app.listen(port, () => console.log(`StyleAI order backend running on http://localhost:${port}  (admin: /admin/admin.html)`));
