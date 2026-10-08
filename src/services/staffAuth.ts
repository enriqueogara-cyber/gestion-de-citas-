import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from "node:crypto";
import { Request, Response, Router, NextFunction } from "express";
import { prisma } from "../db/client";
import { rateLimit } from "../lib/rateLimit";
const localCsrf = randomBytes(32).toString("hex");
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
export function hashPassword(password: string): string {
  if (password.length < 12 || password.length > 256) throw new Error("La contraseña debe tener entre 12 y 256 caracteres.");
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export function verifyPassword(password: string, hash: string): boolean {
  const [salt, expected] = hash.split(":");
  if (!salt || !expected || password.length > 256) return false;
  const value = scryptSync(password, salt, 64), saved = Buffer.from(expected, "hex");
  return value.length === saved.length && timingSafeEqual(value, saved);
}
export async function bootstrapStaff() {
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && await prisma.staffUser.count() === 0) await prisma.staffUser.create({ data: { email: process.env.ADMIN_EMAIL.toLowerCase().trim(), passwordHash: hashPassword(process.env.ADMIN_PASSWORD), role: "ADMIN" } });
  if (process.env.NODE_ENV === "production" && await prisma.staffUser.count({ where: { active: true, role: "ADMIN" } }) === 0) throw new Error("Configura ADMIN_EMAIL y ADMIN_PASSWORD para crear el administrador.");
}
const cookie = (req: Request) => /(?:^|;\s*)clinic_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || "")?.[1];
const csrfFor = (token: string) => digest("csrf:" + token);
const loopback = (req: Request) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "") && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(req.hostname);
function sendPage(res: Response, title: string, body: string) {
  res.type("html").send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui;background:#f6f8f8;color:#183331;margin:0;display:grid;min-height:100vh;place-items:center}main{max-width:380px;padding:32px;background:white;border-radius:16px}label{display:block;margin:18px 0}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:6px;border:1px solid #ccd8d5;border-radius:8px;font:inherit}button{background:#0f766e;color:white;cursor:pointer}a{color:#0f766e}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`);
}
export const authRouter = Router();
authRouter.get("/login", (_req, res) => sendPage(res, "Acceso al centro", `<form method="post" action="/auth/login"><input type="hidden" name="csrf" value="${localCsrf}"><label>Correo<input type="email" name="email" autocomplete="username" required></label><label>Contraseña<input type="password" name="password" autocomplete="current-password" required maxlength="256"></label><button>Entrar</button></form>`));
authRouter.post("/login", rateLimit({ windowMs: 15 * 60_000, max: 10 }), async (req, res, next) => {
  try {
    if (req.body.csrf !== localCsrf) { res.status(403).send("Vuelve a abrir la pantalla de acceso."); return; }
    const user = await prisma.staffUser.findUnique({ where: { email: String(req.body.email || "").trim().toLowerCase() } });
    if (!user?.active || !verifyPassword(String(req.body.password || ""), user.passwordHash)) { sendPage(res.status(401), "No se pudo acceder", '<p>Revisa el correo y la contraseña.</p><a href="/auth/login">Volver</a>'); return; }
    const token = randomBytes(32).toString("hex");
    await prisma.staffSession.create({ data: { tokenHash: digest(token), userId: user.id, expiresAt: new Date(Date.now() + 8 * 3600_000) } });
    res.cookie("clinic_session", token, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 8 * 3600_000, path: "/" });
    res.redirect("/simulator/dashboard");
  } catch (err) { next(err); }
});
export async function staffAccess(req: Request, res: Response, next: NextFunction) {
  try {
    const token = cookie(req);
    const session = token ? await prisma.staffSession.findUnique({ where: { tokenHash: digest(token) }, include: { user: true } }) : null;
    if (session && session.expiresAt > new Date() && session.user.active) {
      res.locals.staff = { id: session.user.id, role: session.user.role, email: session.user.email };
      res.locals.csrf = csrfFor(token!);
    } else if (process.env.NODE_ENV !== "production" && loopback(req) && await prisma.staffUser.count() === 0) {
      res.locals.staff = { id: "local-demo", role: "ADMIN", email: "Demo local" };
      res.locals.csrf = localCsrf;
    } else {
      if (req.path.startsWith("/api/")) res.status(401).json({ error: "Inicia sesión para continuar." });
      else res.redirect("/auth/login");
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("X-Clinic-CSRF") !== res.locals.csrf) { res.status(403).json({ error: "La sesión ha cambiado. Recarga la página." }); return; }
    if (res.locals.staff.role !== "ADMIN" && (req.path === "/settings" || /^\/api\/(settings|services|professionals|opening-hours|demo|staff|backup)/.test(req.path))) { res.status(403).send("Esta acción requiere un administrador."); return; }
    const original = res.send.bind(res);
    res.send = ((body: unknown) => {
      if (typeof body === "string" && body.includes("</head>")) body = body.replace("</head>", `<script>const clinicCsrf=${JSON.stringify(res.locals.csrf)};const originalFetch=window.fetch.bind(window);window.fetch=(input,options={})=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin===location.origin){const headers=new Headers(options.headers||(input instanceof Request?input.headers:undefined));headers.set('X-Clinic-CSRF',clinicCsrf);options={...options,headers};}return originalFetch(input,options);};</script></head>`);
      return original(body);
    }) as Response["send"];
    next();
  } catch (err) { next(err); }
}
export function validWebhookSignature(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(createHmac("sha256", secret).update(raw).digest(), Buffer.from(signature.slice(7), "hex"));
}
export async function logout(req: Request, res: Response) {
  const token = cookie(req);
  if (token) await prisma.staffSession.deleteMany({ where: { tokenHash: digest(token) } });
  res.clearCookie("clinic_session", { path: "/" }); res.json({ ok: true });
}
