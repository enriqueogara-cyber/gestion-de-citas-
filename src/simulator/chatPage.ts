import { ClinicSettings } from "../services/clinicSettings";
import { sharedTokensCss, navBar, escapeHtml, GOOGLE_FONT_LINK, icon } from "./layout";

/**
 * Página de chat de un solo fichero (sin build propio) para poder hablar con
 * el agente desde el navegador como si fuera WhatsApp. Es una herramienta de
 * desarrollo/demo (también útil para enseñársela a una clínica antes de
 * conectar el WhatsApp real), no forma parte del producto que verá el
 * paciente final.
 *
 * En desktop se ve el chat junto a un panel "Estado de conversación" que
 * refleja el estado REAL del paciente en base de datos (nunca información
 * inventada) — en móvil ese panel desaparece y el chat sigue siendo
 * excelente por sí solo.
 */

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function renderChatPage(settings: ClinicSettings): string {
  const name = escapeHtml(settings.name);
  const tagline = escapeHtml(settings.tagline);
  const brand = settings.brandColor;
  const initialsText = escapeHtml(initials(settings.name));
  const logoMarkup = settings.logoUrl
    ? `<img src="${escapeHtml(settings.logoUrl)}" alt="${name}" />`
    : `<span>${initialsText}</span>`;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Simulador de WhatsApp · ${name}</title>
${GOOGLE_FONT_LINK}
<style>
${sharedTokensCss(brand)}
  body {
    display: flex; flex-direction: column;
  }
  .stage-wrap {
    flex: 1; display: flex; align-items: center; justify-content: center;
    padding: 32px 16px; overflow-x: hidden; overflow-y: auto; min-height: 0;
  }
  @media (max-width: 480px) {
    .stage-wrap { padding: 14px 10px; }
    .shell { height: min(680px, 78vh); }
  }

  .stage { display: flex; flex-direction: column; align-items: center; gap: 16px; width: 100%; }
  .eyebrow { text-align: center; color: var(--text-secondary); font-size: 13px; max-width: 420px; line-height: 1.55; }
  .eyebrow strong { color: var(--text-primary); font-weight: 650; }

  .layout-row { display: flex; flex-direction: column; align-items: center; gap: 14px; width: 100%; }
  @media (min-width: 880px) {
    .layout-row { flex-direction: row; align-items: flex-start; justify-content: center; }
  }

  /* Los chats admiten su propia escala de radius, algo más redondeada que
     el resto del producto (ver "border radius" de la auditoría visual). */
  .shell {
    --radius-chat: 22px;
    width: 100%; max-width: 440px; height: min(720px, 82vh);
    background: var(--surface); border-radius: var(--radius-chat); box-shadow: var(--shadow-lg);
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid var(--border); flex-shrink: 0;
  }

  /* --- Panel "Estado de conversación" (solo desktop) --- */
  .state-panel { display: none; }
  @media (min-width: 880px) {
    .state-panel {
      display: flex; flex-direction: column; width: 272px; height: min(720px, 82vh);
      background: linear-gradient(165deg, var(--brand-tint), var(--surface) 45%);
      border: 1px solid var(--border); border-radius: var(--radius-lg);
      box-shadow: var(--shadow-md); padding: 20px; flex-shrink: 0;
    }
  }
  .state-panel h3 { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-tertiary); font-weight: 650; margin: 0 0 16px; }
  .state-body { display: flex; flex-direction: column; gap: 15px; overflow-y: auto; }
  .state-empty { color: var(--text-tertiary); font-size: 13px; line-height: 1.6; margin: 0; }
  .state-row { display: flex; flex-direction: column; gap: 3px; }
  .state-label { font-size: 10.5px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  .state-value { font-size: 13.5px; font-weight: 600; color: var(--text-primary); word-break: break-word; }
  .state-badge { display: inline-flex; align-self: flex-start; font-size: 11px; font-weight: 650; padding: 3px 9px; border-radius: 999px; }
  .state-badge.st-confirmed { background: var(--success-soft); color: var(--success); }
  .state-badge.st-pending { background: var(--warning-soft); color: var(--warning); }
  .state-badge.st-cancelled { background: var(--danger-soft); color: var(--danger); }
  .state-badge.st-completed { background: var(--surface-subtle); color: var(--text-secondary); }
  .state-badge.st-noshow { background: var(--danger-soft); color: var(--danger); }
  .state-badge.st-waiting { background: var(--brand-soft); color: var(--brand-dark); }
  .state-divider { border: none; border-top: 1px solid var(--border); margin: 1px 0; }
  .state-last-action { display: flex; align-items: flex-start; gap: 7px; }
  .state-last-action .icon { color: var(--text-tertiary); flex-shrink: 0; margin-top: 2px; }

  header {
    background: linear-gradient(135deg, var(--brand), var(--brand-dark));
    color: white; padding: 17px 18px; display: flex; align-items: center; gap: 13px;
    position: relative;
  }
  .avatar {
    width: 46px; height: 46px; border-radius: 50%; flex-shrink: 0;
    background: rgba(255,255,255,0.18); display: flex; align-items: center; justify-content: center;
    font-weight: 650; font-size: 16px; letter-spacing: 0.01em; overflow: hidden;
    box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.35);
  }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }
  .head-info { flex: 1; min-width: 0; }
  .head-info strong { display: block; font-size: 16px; font-weight: 700; letter-spacing: -0.01em; }
  .status { display: flex; align-items: center; gap: 6px; font-size: 12.5px; opacity: 0.92; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status .dot { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; flex-shrink: 0; box-shadow: 0 0 0 0 rgba(74,222,128,0.55); animation: dot-pulse 2.4s infinite; }
  @keyframes dot-pulse { 0% { box-shadow: 0 0 0 0 rgba(74,222,128,0.5); } 70% { box-shadow: 0 0 0 5px rgba(74,222,128,0); } 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); } }
  .header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .icon-btn {
    width: 32px; height: 32px; border-radius: 50%; border: none; flex-shrink: 0;
    background: rgba(255,255,255,0.14); color: white; cursor: pointer;
    display: flex; align-items: center; justify-content: center; transition: background 0.15s;
  }
  .icon-btn:hover { background: rgba(255,255,255,0.26); }
  .icon-btn svg { width: 16px; height: 16px; }

  .demo-pill {
    border: none; background: rgba(255,255,255,0.14); color: white; font-size: 11px; font-weight: 600;
    padding: 6px 10px; border-radius: 999px; cursor: pointer; flex-shrink: 0; transition: background 0.15s;
  }
  .demo-pill:hover { background: rgba(255,255,255,0.26); }
  .demo-popover {
    position: absolute; top: 54px; right: 18px; z-index: 20; width: 240px;
    background: var(--surface-elevated); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius-sm);
    box-shadow: var(--shadow-md); padding: 12px 14px; font-size: 12.5px; line-height: 1.55; display: none;
  }
  .demo-popover.show { display: block; animation: rise 0.15s cubic-bezier(0.16, 1, 0.3, 1); }

  /* --- Quick actions: toolbar contextual, no fila de botones genéricos --- */
  .quick-actions {
    display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 14px 2px;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; min-height: 34px;
    border: 1px solid var(--border); background: var(--surface); color: var(--text-secondary);
    padding: 8px 13px 8px 11px; border-radius: 999px; font-size: 12.5px; font-weight: 550; cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s, transform 0.08s; white-space: nowrap; font-family: inherit;
  }
  .chip .icon { flex-shrink: 0; color: var(--brand-dark); opacity: 0.6; }
  .chip:hover:not(:disabled) { border-color: var(--brand); color: var(--text-primary); background: var(--brand-soft); }
  .chip:hover:not(:disabled) .icon { opacity: 1; }
  .chip:active:not(:disabled) { transform: scale(0.97); }
  .chip:disabled { opacity: 0.5; cursor: default; transform: none; }

  .chip-more-wrap { position: relative; flex-shrink: 0; }
  .chip-more-menu {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 20; min-width: 188px;
    background: var(--surface-elevated); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-md);
    padding: 6px; display: none; flex-direction: column; gap: 1px;
  }
  .chip-more-menu.show { display: flex; animation: rise 0.15s cubic-bezier(0.16, 1, 0.3, 1); }
  .chip-menu-item {
    display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; border: none; background: transparent;
    color: var(--text-primary); font-size: 13px; font-weight: 500; padding: 9px 10px; border-radius: var(--radius-sm); cursor: pointer;
    white-space: nowrap; font-family: inherit;
  }
  .chip-menu-item .icon { color: var(--text-tertiary); flex-shrink: 0; }
  .chip-menu-item:hover:not(:disabled) { background: var(--surface-subtle); }
  .chip-menu-item:disabled { opacity: 0.5; cursor: default; }

  .chat-body { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--brand-tint); }
  #messages {
    flex: 1; overflow-y: auto; padding: 16px 14px; display: flex; flex-direction: column; gap: 12px;
  }

  /* --- Estado de bienvenida: lo primero que ve el paciente, antes de
     escribir nada — nada de caja vacía esperando (ver punto 11). --- */
  .welcome-state {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 30px 26px; text-align: center; overflow-y: auto;
  }
  .welcome-avatar {
    width: 56px; height: 56px; border-radius: 50%; margin-bottom: 16px; flex-shrink: 0;
    background: var(--brand); color: white; display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 19px; overflow: hidden;
    box-shadow: 0 10px 24px -10px color-mix(in srgb, var(--brand) 65%, transparent);
  }
  .welcome-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .welcome-title { font-size: 17px; font-weight: 700; color: var(--text-primary); margin: 0 0 6px; letter-spacing: -0.01em; }
  .welcome-sub { font-size: 13px; color: var(--text-secondary); margin: 0 0 22px; max-width: 280px; line-height: 1.5; }
  .welcome-actions { display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 280px; }
  .welcome-btn {
    display: flex; align-items: center; gap: 11px; width: 100%; padding: 12px 15px; border-radius: var(--radius-md);
    border: 1px solid var(--border); background: var(--surface); color: var(--text-primary); font-size: 13.5px; font-weight: 600;
    cursor: pointer; font-family: inherit; transition: border-color 0.12s, background 0.12s, transform 0.1s, box-shadow 0.12s;
  }
  .welcome-btn .icon { color: var(--brand); flex-shrink: 0; }
  .welcome-btn:hover:not(:disabled) { border-color: var(--brand); background: var(--brand-soft); transform: translateY(-1px); box-shadow: var(--shadow-sm); }
  .welcome-btn:active:not(:disabled) { transform: translateY(0) scale(0.98); }
  .welcome-btn:disabled { opacity: 0.5; cursor: default; transform: none; }
  .welcome-btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  .welcome-note { font-size: 11px; color: var(--text-tertiary); margin: 20px 0 0; }
  .row { display: flex; gap: 8px; max-width: 88%; animation: rise 0.22s cubic-bezier(0.16, 1, 0.3, 1); }
  .row.user { align-self: flex-end; flex-direction: row-reverse; }
  .row.assistant { align-self: flex-start; }
  .row.handoff { align-self: center; max-width: 92%; }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

  .mini-avatar {
    width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0; margin-top: 2px;
    background: var(--brand-soft); color: var(--brand-dark); display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 650; letter-spacing: 0.01em;
  }
  .col { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .row.user .col { align-items: flex-end; }

  .bubble {
    padding: 9px 13px; border-radius: 15px; font-size: 14px; line-height: 1.48;
    white-space: pre-wrap; word-wrap: break-word; font-variant-numeric: tabular-nums;
  }
  .row.user .bubble {
    background: var(--brand); color: white;
    border-bottom-right-radius: 4px;
  }
  .row.assistant .bubble {
    background: var(--surface); color: var(--text-primary); border: 1px solid var(--border);
    border-bottom-left-radius: 4px;
  }
  .row.system .bubble {
    background: var(--danger-soft);
    color: var(--text-primary); border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent);
    font-size: 12.5px; text-align: center;
  }
  .row.system { align-self: center; max-width: 90%; }
  .row.handoff .bubble {
    background: var(--warning-soft);
    border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
    color: var(--text-primary); font-size: 12.5px; text-align: center; border-radius: 12px;
  }
  .timestamp { font-size: 10.5px; color: var(--text-tertiary); padding: 0 3px; }

  .typing-dots { display: flex; gap: 3px; padding: 4px 2px; }
  .typing-dots span {
    width: 5px; height: 5px; border-radius: 50%; background: var(--text-tertiary);
    animation: bounce 1.3s infinite ease-in-out;
  }
  .typing-dots span:nth-child(2) { animation-delay: 0.16s; }
  .typing-dots span:nth-child(3) { animation-delay: 0.32s; }
  @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.45; } 30% { transform: translateY(-3px); opacity: 1; } }

  form {
    display: flex; gap: 8px; padding: 12px 14px; background: var(--surface);
    border-top: 1px solid var(--border); align-items: flex-end;
  }
  textarea {
    flex: 1; padding: 10px 15px; border-radius: 19px; border: 1px solid var(--border-strong);
    background: var(--surface-subtle); color: var(--text-primary); font-size: 14px; font-family: inherit;
    outline: none; transition: border-color 0.15s, box-shadow 0.15s; resize: none;
    max-height: 110px; line-height: 1.4;
  }
  textarea::placeholder { color: var(--text-tertiary); }
  textarea:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); background: var(--surface); }
  textarea:disabled { opacity: 0.6; }
  button[type=submit] {
    background: var(--brand); color: white; border: none;
    width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; cursor: pointer;
    display: flex; align-items: center; justify-content: center; transition: transform 0.12s, background 0.12s, opacity 0.15s;
  }
  button[type=submit]:hover:not(:disabled) { background: var(--brand-hover); transform: scale(1.05); }
  button[type=submit]:active:not(:disabled) { transform: scale(0.96); }
  .icon-btn:focus-visible {
    outline: 2px solid white; outline-offset: 2px;
  }
  button[type=submit]:focus-visible, textarea:focus-visible, .chip:focus-visible, #moreChipBtn:focus-visible {
    outline: 2px solid var(--brand); outline-offset: 2px;
  }
  .chip-menu-item:focus-visible {
    outline: 2px solid var(--brand); outline-offset: -2px;
  }
  button[type=submit]:disabled { opacity: 0.4; cursor: default; }
  button[type=submit] svg { width: 17px; height: 17px; }

  .powered { text-align: center; font-size: 11.5px; color: var(--text-tertiary); }
  .powered b { color: var(--text-secondary); font-weight: 650; }

  .overlay {
    position: fixed; inset: 0; background: rgba(10, 13, 18, 0.5); backdrop-filter: blur(3px);
    display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px;
    animation: fade-in 0.15s ease-out;
  }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
  .confirm-card {
    background: var(--surface-elevated); color: var(--text-primary); border-radius: var(--radius-lg); padding: 24px;
    max-width: 300px; width: 100%; text-align: center; box-shadow: var(--shadow-lg); border: 1px solid var(--border);
    animation: pop-in 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes pop-in { from { opacity: 0; transform: scale(0.96) translateY(4px); } to { opacity: 1; transform: scale(1) translateY(0); } }
  .confirm-card p { margin: 0 0 18px; font-size: 14px; line-height: 1.55; color: var(--text-secondary); }
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

  @media (prefers-reduced-motion: reduce) {
    .row, .demo-popover.show, .overlay, .confirm-card { animation: none; }
  }
</style>
</head>
<body>
${navBar("chat", { name: settings.name, brandColor: settings.brandColor })}
<div class="stage-wrap">
  <div class="stage">
    <p class="eyebrow">Simulador de conversación — así habla un paciente con <strong>${name}</strong> por WhatsApp.</p>
    <div class="layout-row">
      <div class="shell">
        <header>
          <div class="avatar">${logoMarkup}</div>
          <div class="head-info">
            <strong>${name}</strong>
            <div class="status"><span class="dot"></span><span>${tagline || "Disponible ahora"}</span></div>
          </div>
          <div class="header-actions">
            <button id="demoPillBtn" class="demo-pill" type="button">Demo</button>
            <button id="resetBtn" class="icon-btn" type="button" title="Reiniciar conversación" aria-label="Reiniciar conversación">
              ${icon("refresh", { size: 16 })}
            </button>
          </div>
          <div id="demoPopover" class="demo-popover"></div>
        </header>

        <div class="quick-actions">
          <button class="chip" type="button" data-msg="Quiero pedir una cita">${icon("calendar", { size: 13 })}Pedir cita</button>
          <button class="chip" type="button" data-msg="¿Qué citas tengo?">${icon("list", { size: 13 })}Mis citas</button>
          <button class="chip" type="button" data-msg="Quiero cancelar mi cita">${icon("x", { size: 13 })}Cancelar</button>
          <div class="chip-more-wrap">
            <button class="chip" type="button" id="moreChipBtn" aria-haspopup="true" aria-expanded="false">Más${icon("chevron-down", { size: 13 })}</button>
            <div class="chip-more-menu" id="moreChipMenu" role="menu" aria-label="Más acciones rápidas">
              <button class="chip-menu-item" type="button" role="menuitem" data-msg="Quiero cambiar mi cita">${icon("refresh", { size: 14 })}Cambiar cita</button>
              <button class="chip-menu-item" type="button" role="menuitem" data-msg="Apúntame a la lista de espera">${icon("waitlist", { size: 14 })}Lista de espera</button>
            </div>
          </div>
        </div>

        <div class="chat-body">
          <div id="welcomeState" class="welcome-state">
            <div class="welcome-avatar">${logoMarkup}</div>
            <h2 class="welcome-title">Hola, ¿cómo podemos ayudarte?</h2>
            <p class="welcome-sub">Puedes gestionar tus citas con ${name} directamente desde aquí.</p>
            <div class="welcome-actions">
              <button class="welcome-btn" type="button" data-msg="Quiero pedir una cita">${icon("calendar", { size: 15 })}Reservar cita</button>
              <button class="welcome-btn" type="button" data-msg="¿Qué citas tengo?">${icon("list", { size: 15 })}Ver mis citas</button>
              <button class="welcome-btn" type="button" data-msg="Quiero cambiar mi cita">${icon("refresh", { size: 15 })}Cambiar cita</button>
              <button class="welcome-btn" type="button" data-msg="Quiero cancelar mi cita">${icon("x", { size: 15 })}Cancelar cita</button>
            </div>
            <p class="welcome-note">Disponible 24/7 para gestión de citas</p>
          </div>
          <div id="messages" hidden></div>
        </div>

        <form id="chatForm">
          <textarea id="textInput" rows="1" placeholder="Escribe un mensaje…" autocomplete="off"></textarea>
          <button type="submit" aria-label="Enviar">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.6 21 12 3.4 3.4 3 10l13 2-13 2z"/></svg>
          </button>
        </form>
      </div>

      <aside class="state-panel">
        <h3>Estado de conversación</h3>
        <div class="state-body" id="stateBody">
          <p class="state-empty">Inicia una conversación para ver el contexto del agente.</p>
        </div>
      </aside>
    </div>
    <p class="powered">Impulsado por <b>IA</b> · respuestas en segundos, 24/7</p>
  </div>
</div>

<script>
(function () {
  const SESSION_KEY = "clinic_agent_demo_session_id";
  let sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(SESSION_KEY, sessionId);
  }

  const CLINIC_INITIALS = "${initialsText}";
  const STATUS_BADGE_CLASS = {
    CONFIRMED: "st-confirmed", PENDING_CONFIRMATION: "st-pending", CANCELLED: "st-cancelled",
    COMPLETED: "st-completed", NO_SHOW: "st-noshow",
  };

  const messagesEl = document.getElementById("messages");
  const welcomeEl = document.getElementById("welcomeState");
  const form = document.getElementById("chatForm");
  const input = document.getElementById("textInput");
  const resetBtn = document.getElementById("resetBtn");
  const demoPillBtn = document.getElementById("demoPillBtn");
  const demoPopover = document.getElementById("demoPopover");
  const moreChipBtn = document.getElementById("moreChipBtn");
  const moreChipMenu = document.getElementById("moreChipMenu");
  // Todo lo que se puede deshabilitar mientras hay un envío en curso
  // (los chips directos, el botón "Más", los items de su menú y los
  // botones del estado de bienvenida).
  const disableableChips = Array.from(document.querySelectorAll(".chip, .chip-menu-item, .welcome-btn"));
  // Solo lo que, al pulsarlo, envía un mensaje directamente.
  const sendableChips = Array.from(document.querySelectorAll(".chip[data-msg], .chip-menu-item[data-msg], .welcome-btn[data-msg]"));
  const sendBtn = form.querySelector("button[type=submit]");
  const stateBody = document.getElementById("stateBody");

  function showWelcome(show) {
    welcomeEl.hidden = !show;
    messagesEl.hidden = show;
  }

  function closeMoreMenu() {
    moreChipMenu.classList.remove("show");
    moreChipBtn.setAttribute("aria-expanded", "false");
  }

  function setBusy(busy) {
    input.disabled = busy;
    sendBtn.disabled = busy;
    disableableChips.forEach((c) => (c.disabled = busy));
    if (busy) closeMoreMenu();
  }

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 110) + "px";
  }
  input.addEventListener("input", autoGrow);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  function timeNow() {
    return new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  }

  // Red de seguridad, no la vía principal: el prompt ya le pide al modelo
  // texto plano sin Markdown. Si aun así se cuela negrita, cursiva o
  // código entre comillas invertidas, esto lo deja como texto normal en
  // vez de enseñar los símbolos literales al paciente.
  function stripLightMarkdown(text) {
    return text
      .replace(/\\*\\*(.+?)\\*\\*/g, "$1")
      .replace(/(?<!\\w)_(.+?)_(?!\\w)/g, "$1")
      .replace(/\`(.+?)\`/g, "$1")
      .replace(/^#{1,6}\\s+/gm, "");
  }

  function addRow(role, text, opts) {
    opts = opts || {};
    const row = document.createElement("div");
    row.className = "row " + role;

    if (role === "assistant") {
      const av = document.createElement("div");
      av.className = "mini-avatar";
      av.textContent = CLINIC_INITIALS;
      row.appendChild(av);
    }

    const col = document.createElement("div");
    col.className = "col";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (opts.pending) {
      bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    } else {
      bubble.textContent = role === "assistant" ? stripLightMarkdown(text) : text;
    }
    col.appendChild(bubble);

    if (!opts.pending && role !== "system" && role !== "handoff") {
      const ts = document.createElement("div");
      ts.className = "timestamp";
      ts.textContent = timeNow();
      col.appendChild(ts);
    }

    row.appendChild(col);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return row;
  }

  demoPillBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    demoPopover.classList.toggle("show");
  });
  document.addEventListener("click", () => demoPopover.classList.remove("show"));

  moreChipBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (moreChipBtn.disabled) return;
    const opening = !moreChipMenu.classList.contains("show");
    moreChipMenu.classList.toggle("show", opening);
    moreChipBtn.setAttribute("aria-expanded", String(opening));
  });
  document.addEventListener("click", () => closeMoreMenu());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && moreChipMenu.classList.contains("show")) {
      closeMoreMenu();
      moreChipBtn.focus();
    }
  });

  function showConfirm(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "overlay";
      overlay.innerHTML =
        '<div class="confirm-card"><p></p><div class="confirm-actions">' +
        '<button class="dlg-btn-ghost" data-action="cancel">Cancelar</button>' +
        '<button class="dlg-btn-danger" data-action="ok">Reiniciar</button></div></div>';
      overlay.querySelector("p").textContent = message;
      function done(result) { overlay.remove(); resolve(result); }
      overlay.addEventListener("click", (e) => {
        const action = e.target.getAttribute("data-action");
        if (action) done(action === "ok");
        else if (e.target === overlay) done(false);
      });
      document.body.appendChild(overlay);
    });
  }

  function stateField(label, value) {
    const div = document.createElement("div");
    div.className = "state-row";
    const l = document.createElement("span"); l.className = "state-label"; l.textContent = label;
    const v = document.createElement("span"); v.className = "state-value"; v.textContent = value;
    div.appendChild(l); div.appendChild(v);
    return div;
  }

  function stateBadge(label, text, statusKey) {
    const div = document.createElement("div");
    div.className = "state-row";
    const l = document.createElement("span"); l.className = "state-label"; l.textContent = label;
    const b = document.createElement("span");
    b.className = "state-badge " + (STATUS_BADGE_CLASS[statusKey] || "st-waiting");
    b.textContent = text;
    div.appendChild(l); div.appendChild(b);
    return div;
  }

  // Estado REAL del paciente (nunca inventado): lo que ya está en base de
  // datos ahora mismo, no una simulación de "escribiendo/buscando...".
  async function refreshState() {
    try {
      const res = await fetch("/simulator/api/state?sessionId=" + encodeURIComponent(sessionId));
      const data = await res.json();
      stateBody.innerHTML = "";

      if (!data.patientName && !data.appointment && !data.waitlist) {
        stateBody.innerHTML = '<p class="state-empty">Inicia una conversación para ver el contexto del agente.</p>';
        return;
      }
      if (data.patientName) stateBody.appendChild(stateField("Paciente", data.patientName));

      if (data.appointment) {
        stateBody.appendChild(stateField("Servicio", data.appointment.service));
        if (data.appointment.professionalName) stateBody.appendChild(stateField("Profesional", data.appointment.professionalName));
        stateBody.appendChild(stateField("Fecha", data.appointment.whenLabel));
        stateBody.appendChild(stateBadge("Estado", data.appointment.statusLabel, data.appointment.status));
      } else if (data.waitlist) {
        stateBody.appendChild(stateField("Servicio", data.waitlist.service));
        stateBody.appendChild(stateBadge("Estado", data.waitlist.statusLabel, "WAITING"));
        if (data.waitlist.offeredWhenLabel) stateBody.appendChild(stateField("Hueco ofrecido", data.waitlist.offeredWhenLabel));
      } else {
        const p = document.createElement("p");
        p.className = "state-empty";
        p.textContent = "Sin citas ni listas de espera activas todavía.";
        stateBody.appendChild(p);
      }

      if (data.lastEvent) {
        const hr = document.createElement("hr");
        hr.className = "state-divider";
        stateBody.appendChild(hr);
        const row = document.createElement("div");
        row.className = "state-row";
        const label = document.createElement("span"); label.className = "state-label"; label.textContent = "Última acción";
        row.appendChild(label);
        const last = document.createElement("div");
        last.className = "state-last-action";
        last.innerHTML = ${JSON.stringify(icon("check-circle", { size: 13 }))};
        const txt = document.createElement("span");
        txt.className = "state-value";
        txt.textContent = data.lastEvent;
        last.appendChild(txt);
        row.appendChild(last);
        stateBody.appendChild(row);
      }
    } catch (e) {}
  }

  async function loadHistory() {
    const res = await fetch("/simulator/api/history?sessionId=" + encodeURIComponent(sessionId));
    const data = await res.json();
    messagesEl.innerHTML = "";
    if (!data.messages || data.messages.length === 0) {
      showWelcome(true);
    } else {
      showWelcome(false);
      data.messages.forEach((m) => addRow(m.role === "user" ? "user" : "assistant", m.content));
    }
  }

  async function sendMessage(text) {
    showWelcome(false);
    addRow("user", text);
    const pendingRow = addRow("assistant", "", { pending: true });
    setBusy(true);
    input.value = "";
    autoGrow();

    try {
      const res = await fetch("/simulator/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, text }),
      });
      const data = await res.json();
      pendingRow.remove();
      if (data.error) {
        addRow("system", data.error);
      } else {
        if (data.reply) addRow("assistant", data.reply);
        if (data.handoffReason) {
          addRow("handoff", "Conversación derivada a atención humana — motivo: " + data.handoffReason);
        }
      }
    } catch (err) {
      pendingRow.remove();
      addRow("system", "Error de red hablando con el agente.");
    } finally {
      setBusy(false);
      input.focus();
      refreshState();
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sendMessage(text);
  });

  sendableChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      if (chip.disabled) return;
      if (chip.classList.contains("chip-menu-item")) closeMoreMenu();
      sendMessage(chip.getAttribute("data-msg"));
    });
  });

  resetBtn.addEventListener("click", async () => {
    const ok = await showConfirm("¿Borrar esta conversación de demo y empezar de cero?");
    if (!ok) return;
    await fetch("/simulator/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    await loadHistory();
    await refreshState();
  });

  fetch("/simulator/api/status")
    .then((r) => r.json())
    .then((s) => {
      demoPopover.textContent = s.calendarConfigured
        ? "Modo demo: este simulador reproduce la experiencia de WhatsApp, conectado a Google Calendar real."
        : "Modo demo: calendario simulado (no hay Google Calendar conectado). Las citas solo viven en esta base de datos local.";
    })
    .catch(() => {
      demoPopover.textContent = "Modo demo: simulador local del agente.";
    });

  loadHistory();
  refreshState();
  input.focus();
})();
</script>
</body>
</html>`;
}
