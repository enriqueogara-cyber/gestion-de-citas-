/**
 * Piezas compartidas entre las páginas del simulador (chat, dashboard,
 * lista de espera, ajustes): tokens de diseño, iconografía, navegación y
 * los componentes de UI que se repetían (duplicados) en cada página —
 * botones, paneles, tablas, badges — ahora viven en un único sitio para
 * que ninguna pantalla se sienta diseñada de forma independiente (ver
 * README, "Sistema visual").
 */

export interface ClinicBranding {
  name: string;
  brandColor: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Tokens de diseño. Los nombres antiguos (--card, --bg-inset, --text-muted,
 * --shadow) se mantienen como alias sobre los nuevos para no tener que
 * tocar cientos de usos ya existentes en las 4 páginas — el sistema nuevo
 * (--surface*, --text-*, --border-strong, --radius-*, --shadow-*) es el
 * vocabulario a usar en CSS nuevo o revisado a partir de ahora.
 */
export function sharedTokensCss(brand: string): string {
  return `
  :root {
    --brand: ${brand};
    --brand-hover: color-mix(in srgb, var(--brand) 88%, black);
    --brand-dark: color-mix(in srgb, var(--brand) 78%, black);
    --brand-soft: color-mix(in srgb, var(--brand) 13%, white);
    /* Lavado muy sutil de marca para superficies grandes (hero KPI, fondo
       del chat) — más discreto que --brand-soft, que es para estados
       selected/activo. Ver auditoría visual, ronda de color. */
    --brand-tint: color-mix(in srgb, var(--brand) 4%, white);

    --bg: #f7f8fa;
    --surface: #ffffff;
    --surface-subtle: #f3f4f6;
    --surface-elevated: #ffffff;
    --text-primary: #15171b;
    --text-secondary: #5b6270;
    --text-tertiary: #92979f;
    --border: #e7e8ec;
    --border-strong: #d7d9de;

    --danger: #cc3333;
    --danger-soft: color-mix(in srgb, var(--danger) 12%, white);
    --success: #157a52;
    --success-soft: color-mix(in srgb, var(--success) 12%, white);
    --warning: #b06a00;
    --warning-soft: color-mix(in srgb, var(--warning) 14%, white);

    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 20px;

    --shadow-sm: 0 1px 2px rgba(16, 24, 40, 0.06);
    --shadow-md: 0 8px 24px -8px rgba(16, 24, 40, 0.16);
    --shadow-lg: 0 24px 60px -20px rgba(15, 23, 42, 0.28);

    /* Alias de compatibilidad — ver comentario de arriba. */
    --card: var(--surface);
    --bg-inset: var(--surface-subtle);
    --text: var(--text-primary);
    --text-muted: var(--text-secondary);
    --shadow: var(--shadow-lg);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0d10;
      --surface: #131519;
      --surface-subtle: #191c21;
      --surface-elevated: #16181d;
      --text-primary: #f1f2f4;
      --text-secondary: #9aa0aa;
      --text-tertiary: #666c76;
      --border: #24262b;
      --border-strong: #34363c;
      --brand-soft: color-mix(in srgb, var(--brand) 22%, black);
      --brand-tint: color-mix(in srgb, var(--brand) 7%, black);
      --danger: #e05a5a;
      --success: #33b183;
      --warning: #d9973f;
      --shadow-lg: 0 24px 60px -20px rgba(0, 0, 0, 0.6);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; font-family: "Inter", -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    background: var(--bg); color: var(--text-primary);
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  a { color: inherit; }
  ::selection { background: var(--brand-soft); }

  /* Jerarquía tipográfica base — deliberadamente pocos tamaños (ver
     "Tipografía" de la auditoría). Se aplica a nivel de elemento para que
     cascada sola a las 4 páginas sin tener que repetir clases. */
  h1 { font-size: 19px; font-weight: 650; letter-spacing: -0.01em; margin: 0; color: var(--text-primary); }
  h2 { font-size: 14.5px; font-weight: 650; margin: 0; color: var(--text-primary); }
  h3 { font-size: 13.5px; font-weight: 650; margin: 0; color: var(--text-primary); }
  p { line-height: 1.55; }

  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 999px; border: 2px solid var(--bg); background-clip: padding-box; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-tertiary); background-clip: padding-box; }
  * { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
  `;
}

export const GOOGLE_FONT_LINK = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
`;

/**
 * Iconografía propia, mínima y consistente (mismo stroke/tamaño/lenguaje)
 * — nada de librería externa (ver auditoría, "no meter dependencia
 * enorme"), nada de emoji como sistema principal de UI. Los emoji se
 * conservan solo dentro de contenido conversacional (mensajes del chat),
 * nunca en chrome de producto (nav, botones, cabeceras).
 */
const ICON_PATHS: Record<string, string> = {
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  overview: '<rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="6.5" width="4" height="14.5" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/>',
  waitlist: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5l3.2 2"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="2" y1="14" x2="6" y2="14"/><line x1="10" y1="8" x2="14" y2="8"/><line x1="18" y1="16" x2="22" y2="16"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  "check-circle": '<circle cx="12" cy="12" r="9"/><path d="M8.3 12.5l2.5 2.5 5-5.2"/>',
  "alert-triangle": '<path d="M10.6 3.9 2.5 18a1.7 1.7 0 0 0 1.5 2.5h16a1.7 1.7 0 0 0 1.5-2.5L13.4 3.9a1.7 1.7 0 0 0-2.8 0z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
  "chevron-down": '<path d="M6 9l6 6 6-6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M16 2.5v4"/><path d="M8 2.5v4"/><path d="M3 10h18"/>',
  "arrow-right": '<path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>',
  play: '<path d="M6.5 3.5v17l14-8.5-14-8.5z"/>',
  seed: '<path d="M12 22c0-6 4-8 8-8-.5 5-3 8-8 8z"/><path d="M12 22c0-8-4-12-8-13 0 6 2 11 8 13z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
  tag: '<path d="M12.6 2.4 21 10.8a2 2 0 0 1 0 2.8l-7.4 7.4a2 2 0 0 1-2.8 0L2.4 12.6a2 2 0 0 1-.4-.6V4a1.6 1.6 0 0 1 1.6-1.6h8a2 2 0 0 1 1.4.6z"/><circle cx="7.5" cy="7.5" r="1.4" fill="currentColor" stroke="none"/>',
  sparkle: '<path d="M12 3v4.5"/><path d="M12 16.5V21"/><path d="M3 12h4.5"/><path d="M16.5 12H21"/><path d="M5.6 5.6l3.2 3.2"/><path d="M15.2 15.2l3.2 3.2"/><path d="M18.4 5.6l-3.2 3.2"/><path d="M8.8 15.2l-3.2 3.2"/>',
};

export function icon(name: keyof typeof ICON_PATHS, opts: { size?: number; className?: string; filled?: boolean } = {}): string {
  const size = opts.size ?? 16;
  const cls = opts.className ? ` ${opts.className}` : "";
  const fill = opts.filled ? "currentColor" : "none";
  return `<svg class="icon${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ""}</svg>`;
}

export type NavKey = "chat" | "dashboard" | "waitlist" | "settings" | "operations";

const NAV_ITEMS: { key: NavKey; href: string; label: string; icon: keyof typeof ICON_PATHS }[] = [
  { key: "dashboard", href: "/simulator/dashboard", label: "Overview", icon: "overview" },
  { key: "operations", href: "/simulator/operations", label: "Recepción", icon: "calendar" },
  { key: "chat", href: "/simulator/chat", label: "Chat", icon: "chat" },
  { key: "waitlist", href: "/simulator/waitlist", label: "Lista de espera", icon: "waitlist" },
  { key: "settings", href: "/simulator/settings", label: "Ajustes", icon: "settings" },
];

export function navBar(active: NavKey, clinic: ClinicBranding): string {
  const links = NAV_ITEMS.map(
    (item) =>
      `<a class="nav-link${item.key === active ? " active" : ""}" href="${item.href}"${item.key === active ? ' aria-current="page"' : ""}>` +
      `${icon(item.icon, { size: 15, className: "nav-icon" })}<span>${item.label}</span></a>`
  ).join("");

  return `
  <nav class="topnav">
    <div class="topnav-brand">
      <span class="topnav-dot"></span>
      <span class="topnav-name">${escapeHtml(clinic.name)}</span>
      <span class="topnav-tag">demo</span>
    </div>
    <div class="topnav-links">${links}</div>
  </nav>
  <style>
    .topnav {
      display: flex; align-items: center; gap: 8px;
      padding: 0 24px; height: 56px; background: var(--surface); border-bottom: 1px solid var(--border);
      position: sticky; top: 0; z-index: 30;
    }
    .topnav-brand {
      display: flex; align-items: center; gap: 8px; font-weight: 650; font-size: 13.5px;
      letter-spacing: -0.005em; flex-shrink: 1; min-width: 0; margin-right: 8px;
    }
    .topnav-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .topnav-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--brand); flex-shrink: 0; }
    .topnav-tag {
      font-size: 9.5px; font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase;
      color: var(--text-tertiary); border: 1px solid var(--border-strong); padding: 1px 6px; border-radius: 999px;
      flex-shrink: 0;
    }
    @media (max-width: 480px) {
      .topnav { padding: 0 14px; height: 52px; }
      .topnav-tag { display: none; }
      .topnav-brand { font-size: 13px; }
    }
    .topnav-links {
      display: flex; gap: 2px; overflow-x: auto; flex-shrink: 1; min-width: 0; margin-left: auto;
      scrollbar-width: none; -webkit-mask-image: linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent);
      mask-image: linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent);
    }
    .topnav-links::-webkit-scrollbar { display: none; }
    .nav-link {
      display: flex; align-items: center; gap: 6px; text-decoration: none; color: var(--text-secondary);
      font-size: 13px; font-weight: 550; padding: 8px 10px; white-space: nowrap;
      flex-shrink: 0; transition: color 0.14s; position: relative; border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }
    .nav-icon { flex-shrink: 0; opacity: 0.85; }
    .nav-link:hover { color: var(--text-primary); }
    .nav-link.active { color: var(--brand-dark); border-bottom-color: var(--brand); }
    .nav-link.active .nav-icon { opacity: 1; }
    .nav-link:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: 4px; }
    @media (max-width: 480px) {
      /* Objetivo táctil ~44px incluso con el texto oculto (ver "mobile",
         punto 48 de la auditoría visual: mínimo cómodo para el dedo). */
      .nav-link { padding: 13px 11px; font-size: 0; gap: 0; min-height: 44px; }
      .nav-link .nav-icon { width: 19px; height: 19px; }
    }
  </style>`;
}

/**
 * Componentes compartidos entre dashboard/settings/waitlist (antes
 * duplicados casi al carácter en las 3 páginas): botones, paneles, tablas,
 * badges, formularios. Una sola fuente de verdad — ver punto 1 y 39 de la
 * auditoría visual ("sistema de botones", "consolidar tokens").
 */
export function sharedComponentsCss(): string {
  return `
  .page-content { max-width: 1240px; margin: 0 auto; padding: 32px 28px 72px; }
  @media (max-width: 720px) { .page-content { padding: 20px 16px 56px; } }

  /* --- Botones: PRIMARY / GHOST / DANGER / ICON, una sola altura/radius/peso --- */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    border: 1px solid transparent; border-radius: var(--radius-sm); padding: 9px 14px;
    font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s, transform 0.08s;
    line-height: 1.2;
  }
  .btn .icon { flex-shrink: 0; }
  .btn:active:not(:disabled) { transform: scale(0.98); }
  .btn:disabled { opacity: 0.5; cursor: default; transform: none; }
  .btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  .btn-sm { padding: 6px 11px; font-size: 12.5px; }
  .btn-primary { background: var(--brand); color: white; border-color: var(--brand); }
  .btn-primary:hover:not(:disabled) { background: var(--brand-hover); border-color: var(--brand-hover); }
  .btn-ghost { background: var(--surface); color: var(--text-primary); border-color: var(--border-strong); }
  .btn-ghost:hover:not(:disabled) { background: var(--surface-subtle); border-color: var(--text-tertiary); }
  .btn-danger-ghost { background: transparent; color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
  .btn-danger-ghost:hover:not(:disabled) { background: var(--danger-soft); border-color: var(--danger); }
  .btn-text { background: none; border: none; color: var(--text-secondary); font-size: 12.5px; font-weight: 600; cursor: pointer; padding: 4px 6px; border-radius: 6px; font-family: inherit; display: inline-flex; align-items: center; gap: 5px; }
  .btn-text:hover { color: var(--text-primary); background: var(--surface-subtle); }
  .btn-text.danger { color: var(--danger); }
  .btn-text.danger:hover { background: var(--danger-soft); }
  .btn-text:focus-visible, .btn-link:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; border-radius: 6px; }
  /* alias retro-compatible: .btn-link ya se usaba en settingsPage */
  .btn-link { background: none; border: none; color: var(--text-secondary); font-size: 12.5px; font-weight: 600; cursor: pointer; padding: 4px 6px; border-radius: 6px; font-family: inherit; }
  .btn-link:hover { color: var(--text-primary); background: var(--surface-subtle); }
  .btn-link-danger { color: var(--danger); }
  .btn-link-danger:hover { background: var(--danger-soft); }

  /* --- Panel base --- */
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 20px 22px; margin-bottom: 16px; }
  .panel h1 { margin: 0 0 4px; }
  .panel h2 { margin: 0; }
  .panel-head { display: flex; align-items: center; gap: 10px; margin-bottom: 2px; }
  .panel-head h2 { flex: 1; }
  .panel > p.muted, .panel-desc { font-size: 13px; color: var(--text-secondary); margin: 0 0 18px; line-height: 1.55; }
  .muted { color: var(--text-secondary); }
  /* Icono de sección con acento de marca — un poco de color y wayfinding
     en vez de títulos pelados uno debajo de otro (ver ronda de color). */
  .section-icon-chip {
    width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;
    background: var(--brand-soft); color: var(--brand-dark);
    display: flex; align-items: center; justify-content: center;
  }

  /* --- Tablas / listas --- */
  .table-wrap { overflow-x: auto; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--text-tertiary); font-weight: 600; padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; }
  td { padding: 10px; border-bottom: 1px solid var(--border); vertical-align: middle; color: var(--text-primary); }
  tr:last-child td { border-bottom: none; }
  .empty-cell { color: var(--text-tertiary); text-align: center; padding: 28px 10px; font-size: 12.5px; line-height: 1.6; }

  /* --- Badges --- */
  .badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; line-height: 1.5; }

  /* --- Formularios --- */
  label { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--text-secondary); }
  input[type=text], input[type=url], input[type=number], input[type=time], input[type=email], input[type=tel] {
    font-family: inherit; font-size: 14px; font-weight: 500; color: var(--text-primary);
    padding: 9px 11px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--surface); outline: none;
    transition: border-color 0.12s, box-shadow 0.12s; height: 38px;
  }
  input::placeholder { color: var(--text-tertiary); font-weight: 400; }
  input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
  input:disabled { opacity: 0.6; }
  .hint { font-weight: 400; font-size: 11.5px; color: var(--text-tertiary); }
  `;
}

/** Página completa con nav + contenido, para dashboard/waitlist/settings. */
export function pageShell(opts: {
  title: string;
  brand: string;
  active: NavKey;
  clinic: ClinicBranding;
  bodyHtml: string;
  extraStyles?: string;
  bodyScript?: string;
}): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
${GOOGLE_FONT_LINK}
<style>
${sharedTokensCss(opts.brand)}
${sharedComponentsCss()}
.toast-stack { position: fixed; bottom: 20px; right: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 100; max-width: calc(100vw - 32px); }
.toast {
  display: flex; align-items: flex-start; gap: 8px;
  background: var(--surface-elevated); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 11px 13px; box-shadow: var(--shadow-md); font-size: 13.5px; min-width: 220px; max-width: 320px;
  animation: toast-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.toast-msg { flex: 1; min-width: 0; line-height: 1.4; }
.toast-close {
  flex-shrink: 0; border: none; background: transparent; color: var(--text-tertiary); cursor: pointer;
  font-size: 12px; line-height: 1; padding: 2px 4px; margin: -2px -4px 0 0; border-radius: 6px;
}
.toast-close:hover { background: var(--surface-subtle); color: var(--text-primary); }
.toast-close:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.toast.success { border-left: 3px solid var(--success); }
.toast.error { border-left: 3px solid var(--danger); }
.toast.warning { border-left: 3px solid var(--warning); }
.toast.info { border-left: 3px solid var(--brand); }
.toast.toast-out { opacity: 0; transform: translateY(4px) scale(0.98); }
.toast.toast-pulse { animation: toast-pulse 0.28s ease-out; }
@keyframes toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes toast-pulse { 0% { transform: scale(1); } 35% { transform: scale(1.03); } 100% { transform: scale(1); } }
.overlay {
  position: fixed; inset: 0; background: rgba(10, 13, 18, 0.5); backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center; z-index: 200; padding: 20px;
  animation: fade-in 0.15s ease-out;
}
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.confirm-card {
  background: var(--surface-elevated); color: var(--text-primary); border-radius: var(--radius-lg); padding: 24px;
  max-width: 320px; width: 100%; text-align: center; box-shadow: var(--shadow-lg); border: 1px solid var(--border);
  animation: pop-in 0.16s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes pop-in { from { opacity: 0; transform: scale(0.96) translateY(4px); } to { opacity: 1; transform: scale(1) translateY(0); } }
.confirm-card p { margin: 0 0 20px; font-size: 14px; line-height: 1.55; color: var(--text-secondary); }
.confirm-actions { display: flex; gap: 8px; }
.confirm-actions button {
  flex: 1; padding: 10px 12px; border-radius: var(--radius-sm); border: none; font-size: 13.5px; font-weight: 600;
  cursor: pointer; font-family: inherit; transition: opacity 0.12s, transform 0.08s;
}
.confirm-actions button:active { transform: scale(0.98); }
.dlg-btn-ghost { background: var(--surface-subtle); color: var(--text-primary); border: 1px solid var(--border-strong) !important; }
.dlg-btn-ghost:hover { background: var(--border); }
.dlg-btn-danger { background: var(--danger); color: white; }
.dlg-btn-danger:hover { opacity: 0.92; }
@media (prefers-reduced-motion: reduce) { .overlay, .confirm-card { animation: none; } }
${opts.extraStyles || ""}
</style>
</head>
<body>
${navBar(opts.active, opts.clinic)}
<div class="page-content">
${opts.bodyHtml}
</div>
<div class="toast-stack" id="toastStack"></div>
<script>
// Toasts: deduplicados (mismo tipo+mensaje reinicia el que ya está en
// pantalla en vez de apilar uno idéntico — crítico para acciones rápidas
// repetidas, p.ej. marcar varios servicios de un profesional seguidos) y
// con un límite de simultáneos (si se llega al máximo, se retira el más
// antiguo antes de añadir uno nuevo). Ver README, "Toasts".
const TOAST_MAX_VISIBLE = 4;
const TOAST_LIFETIME_MS = 4200;

function dismissToast(el, immediate) {
  if (!el || !el.isConnected) return;
  clearTimeout(el._toastTimer);
  if (immediate) {
    el.remove();
    return;
  }
  el.classList.add("toast-out");
  el.addEventListener("transitionend", () => el.remove(), { once: true });
  // Red de seguridad por si transitionend no llega a disparar (con
  // prefers-reduced-motion la transición dura ~0ms pero debería seguir
  // disparando el evento igualmente).
  setTimeout(() => el.remove(), 400);
}

function toast(message, kind) {
  kind = kind || "success";
  const stack = document.getElementById("toastStack");
  const key = kind + "::" + message;

  let existing = null;
  for (const child of stack.children) {
    if (child.dataset.toastKey === key) { existing = child; break; }
  }
  if (existing) {
    clearTimeout(existing._toastTimer);
    existing.classList.remove("toast-pulse");
    void existing.offsetWidth; // reflow, para poder re-disparar la animación de pulso
    existing.classList.add("toast-pulse");
    existing._toastTimer = setTimeout(() => dismissToast(existing), TOAST_LIFETIME_MS);
    return;
  }

  while (stack.children.length >= TOAST_MAX_VISIBLE) dismissToast(stack.firstElementChild, true);

  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.dataset.toastKey = key;
  const msgSpan = document.createElement("span");
  msgSpan.className = "toast-msg";
  msgSpan.textContent = message;
  const closeBtn = document.createElement("button");
  closeBtn.className = "toast-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Cerrar aviso");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => dismissToast(el));
  el.append(msgSpan, closeBtn);
  stack.appendChild(el);
  el._toastTimer = setTimeout(() => dismissToast(el), TOAST_LIFETIME_MS);
}

// Modal de confirmación propio — nunca usar confirm()/alert() nativos, que
// desentonan con el resto de la interfaz.
function confirmDialog(message, confirmLabel) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML =
      '<div class="confirm-card"><p></p><div class="confirm-actions">' +
      '<button class="dlg-btn-ghost" data-action="cancel">Cancelar</button>' +
      '<button class="dlg-btn-danger" data-action="ok"></button></div></div>';
    overlay.querySelector("p").textContent = message;
    overlay.querySelector(".dlg-btn-danger").textContent = confirmLabel || "Confirmar";
    const previousFocus = document.activeElement;
    let finished = false;
    function done(result) { if (finished) return; finished = true; document.removeEventListener("keydown", onKey); overlay.remove(); if (previousFocus) previousFocus.focus(); resolve(result); }
    overlay.addEventListener("click", (e) => {
      const action = e.target.getAttribute("data-action");
      if (action) done(action === "ok");
      else if (e.target === overlay) done(false);
    });
    function onKey(e) {
      if (e.key === "Escape") done(false);
      if (e.key === "Tab") { const buttons = overlay.querySelectorAll("button"); e.preventDefault(); (document.activeElement === buttons[0] ? buttons[1] : buttons[0]).focus(); }
    }
    document.addEventListener("keydown", onKey);
    overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-label", message);
    document.body.appendChild(overlay);
    overlay.querySelector("button").focus();
  });
}
</script>
${opts.bodyScript ? `<script>${opts.bodyScript}</script>` : ""}
</body>
</html>`;
}
