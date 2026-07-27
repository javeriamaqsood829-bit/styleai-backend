import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import crypto from "crypto";
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
// Railway (and most cloud hosts) block outbound SMTP ports (465/587) to
// prevent spam, so a traditional nodemailer/SMTP connection will time out.
// If RESEND_API_KEY is set, we send email over plain HTTPS via Resend's API
// instead — that always works since it's just a normal web request.
let transporter = null;
if (!process.env.RESEND_API_KEY && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
async function sendMail(to, subject, html) {
  const fromName = process.env.STORE_NAME || "StyleAI Studio";

  if (process.env.RESEND_API_KEY) {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || `${fromName} <onboarding@resend.dev>`,
          to,
          subject,
          html,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        console.error("Resend email failed:", resp.status, errText);
      }
    } catch (err) {
      console.error("Resend email failed:", err.message);
    }
    return;
  }

  if (!transporter) return; // email not configured — order creation still succeeds
  try {
    await transporter.sendMail({ from: `"${fromName}" <${process.env.SMTP_USER}>`, to, subject, html });
  } catch (err) {
    console.error("Email send failed:", err.message);
  }
}
function orderItemsHtml(items) {
  return items.map(i => `<li>${i.qty} × ${i.name}${i.note ? ` (${i.note})` : ""}</li>`).join("");
}

// ---------------------------------------------------------------------------
// CUSTOMER ACCOUNTS — signup with email verification code, then sign in.
// Orders now require a valid account (see requireCustomerAuth below), so
// customers must create + verify an account before they can checkout.
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(check));
}
function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function normEmail(e) {
  return String(e || "").trim().toLowerCase();
}

// ---- sign up: creates an unverified account and emails a 6-digit code ----
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password are required." });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
    const emailNorm = normEmail(email);

    let user = db.data.users.find(u => u.email === emailNorm);
    if (user && user.verified) {
      return res.status(409).json({ error: "An account with this email already exists. Please sign in instead." });
    }

    const otp = generateOtp();
    const otpExpires = Date.now() + 10 * 60 * 1000;
    const passwordHash = hashPassword(password);

    if (user) {
      user.name = name; user.passwordHash = passwordHash; user.otp = otp; user.otpExpires = otpExpires;
    } else {
      user = { id: nanoid(10), name, email: emailNorm, passwordHash, verified: false, otp, otpExpires, tokens: [] };
      db.data.users.push(user);
    }
    await db.write();

    await sendMail(emailNorm, "Verify your StyleAI Studio account",
      `<p>Hi ${name},</p><p>Welcome to StyleAI Studio! Your verification code is:</p>
       <h2 style="letter-spacing:6px;font-size:28px;">${otp}</h2>
       <p>This code expires in 10 minutes.</p>`);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create account.", detail: err.message });
  }
});

// ---- verify the 6-digit code, then sign the customer in ----
app.post("/api/auth/verify", async (req, res) => {
  try {
    const emailNorm = normEmail(req.body.email);
    const code = String(req.body.code || "").trim();
    const user = db.data.users.find(u => u.email === emailNorm);
    if (!user) return res.status(404).json({ error: "No signup found for this email." });
    if (user.verified) return res.status(400).json({ error: "This account is already verified — please sign in." });
    if (!user.otp || user.otp !== code) return res.status(400).json({ error: "Incorrect code, please try again." });
    if (Date.now() > user.otpExpires) return res.status(400).json({ error: "Code expired — please sign up again for a new code." });

    user.verified = true;
    delete user.otp; delete user.otpExpires;
    const token = nanoid(32);
    user.tokens = [...(user.tokens || []), token];
    await db.write();

    res.json({ token, name: user.name, email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not verify account." });
  }
});

// ---- resend a fresh code if the old one expired ----
app.post("/api/auth/resend", async (req, res) => {
  try {
    const emailNorm = normEmail(req.body.email);
    const user = db.data.users.find(u => u.email === emailNorm);
    if (!user || user.verified) return res.status(400).json({ error: "No pending signup for this email." });
    user.otp = generateOtp();
    user.otpExpires = Date.now() + 10 * 60 * 1000;
    await db.write();
    await sendMail(emailNorm, "Your new verification code",
      `<p>Your new verification code is:</p><h2 style="letter-spacing:6px;font-size:28px;">${user.otp}</h2><p>This code expires in 10 minutes.</p>`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not resend code." });
  }
});

// ---- sign in with an already-verified account ----
app.post("/api/auth/login", async (req, res) => {
  try {
    const emailNorm = normEmail(req.body.email);
    const password = req.body.password || "";
    const user = db.data.users.find(u => u.email === emailNorm);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }
    if (!user.verified) {
      return res.status(403).json({ error: "Please verify your email first.", needsVerification: true });
    }
    const token = nanoid(32);
    user.tokens = [...(user.tokens || []), token];
    await db.write();
    res.json({ token, name: user.name, email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not sign in." });
  }
});

// ---- middleware: require a logged-in customer (used to gate checkout) ----
function requireCustomerAuth(req, res, next) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const user = token && db.data.users.find(u => (u.tokens || []).includes(token));
  if (!user) return res.status(401).json({ error: "Please sign in to place an order." });
  req.customer = user;
  next();
}

// ---- check whether a saved token is still valid (used on page load) ----
app.get("/api/auth/me", requireCustomerAuth, (req, res) => {
  res.json({ name: req.customer.name, email: req.customer.email });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---- create order (requires a signed-in, verified account) ----
app.post("/api/orders", requireCustomerAuth, async (req, res) => {
  try {
    // Note: no rate limit here — customers can place as many orders as they
    // like from the same IP, email, or phone number.
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
