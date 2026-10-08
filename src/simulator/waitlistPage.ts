import { DateTime } from "luxon";
import { pageShell, escapeHtml, ClinicBranding, icon } from "./layout";
import { serviceLabel } from "../lib/labels";
import { formatDayShort, formatShort } from "../lib/dates";

export interface WaitlistRow {
  id: string;
  patientName: string;
  service: string;
  earliestDate: Date;
  latestDate: Date;
  professionalName: string | null;
  preferredTimeOfDay: string | null;
  status: string;
  offeredSlotStart: Date | null;
  offerExpiresAt: Date | null;
  createdAt: Date;
}

const STATUS_BADGE: Record<string, string> = {
  WAITING: "badge-waiting",
  OFFERED: "badge-offered",
  ACCEPTING: "badge-offered",
};
const STATUS_LABEL: Record<string, string> = {
  WAITING: "Esperando",
  OFFERED: "Hueco ofrecido",
  ACCEPTING: "Aceptando…",
};
const TIME_OF_DAY_LABEL: Record<string, string> = { MORNING: "Mañana", AFTERNOON: "Tarde" };

// Cuánto lleva esperando, calculado en el momento de renderizar — solo
// presentación (ver punto 33/34 de la auditoría visual), no cambia nada
// del modelo de datos ni de la lógica de matching.
function waitingLabel(createdAt: Date): string {
  const days = Math.max(0, Math.floor(DateTime.now().diff(DateTime.fromJSDate(createdAt), "days").days));
  if (days === 0) return "Esperando desde hoy";
  if (days === 1) return "Esperando 1 día";
  return `Esperando ${days} días`;
}

export function renderWaitlistPage(clinic: ClinicBranding, rows: WaitlistRow[]): string {
  const listRows = rows.length
    ? rows
        .map((r) => {
          const prefBits = [
            r.professionalName ? escapeHtml(r.professionalName) : "Cualquier profesional",
            r.preferredTimeOfDay ? TIME_OF_DAY_LABEL[r.preferredTimeOfDay] || r.preferredTimeOfDay : null,
          ].filter(Boolean);
          return `<div class="wl-row" data-status="${r.status}">
        <div class="wl-main">
          <div class="wl-patient">${escapeHtml(r.patientName)}</div>
          <div class="wl-service">${escapeHtml(serviceLabel(r.service))}</div>
        </div>
        <div class="wl-pref">
          <div class="wl-pref-caption">Prefiere</div>
          <div class="wl-pref-range">${formatDayShort(r.earliestDate)} – ${formatDayShort(r.latestDate)}</div>
          <div class="wl-pref-detail">${prefBits.join(" · ")}</div>
        </div>
        <div class="wl-waiting">${waitingLabel(r.createdAt)}</div>
        <div class="wl-status">
          <span class="badge ${STATUS_BADGE[r.status] || ""}">${STATUS_LABEL[r.status] || r.status}</span>
          ${r.offeredSlotStart ? `<span class="wl-offer-time">${formatShort(r.offeredSlotStart)}</span>` : ""}
        </div>
      </div>`;
        })
        .join("")
    : `<div class="wl-empty">
        <span class="wl-empty-icon">${icon("waitlist", { size: 20 })}</span>
        <p class="wl-empty-title">No hay pacientes esperando</p>
        <p class="wl-empty-sub">La lista se actualizará automáticamente cuando alguien solicite un hueco ocupado.</p>
      </div>`;

  const body = `
  <section class="panel">
    <h1>Lista de espera</h1>
    <p class="muted">Quién está esperando un hueco, y qué le hemos ofrecido ya.</p>
    <div class="wl-header">
      <span>Paciente</span><span>Preferencias</span><span>Tiempo esperando</span><span>Estado</span>
    </div>
    <div class="wl-list">${listRows}</div>
  </section>`;

  const extraStyles = `
  .wl-header {
    display: grid; grid-template-columns: 1.3fr 1.4fr 1fr 1fr; gap: 16px;
    padding: 0 12px 8px; font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-tertiary); border-bottom: 1px solid var(--border);
  }
  .wl-list { display: flex; flex-direction: column; }
  .wl-row {
    display: grid; grid-template-columns: 1.3fr 1.4fr 1fr 1fr; gap: 16px; align-items: center;
    padding: 14px 12px 14px 14px; border-bottom: 1px solid var(--border); border-left: 3px solid transparent;
    transition: background 0.12s, border-color 0.12s;
  }
  .wl-row:last-child { border-bottom: none; }
  .wl-row:hover { background: var(--surface-subtle); }
  /* Una oferta activa es lo más urgente de escanear en esta pantalla — un
     acento de marca a la izquierda la separa del resto sin necesitar una
     fila roja/gigante (ver ronda de color, punto 21). */
  .wl-row[data-status="OFFERED"], .wl-row[data-status="ACCEPTING"] {
    border-left-color: var(--brand); background: color-mix(in srgb, var(--brand) 3%, transparent);
  }
  .wl-patient { font-size: 13.5px; font-weight: 650; }
  .wl-service { font-size: 12px; color: var(--text-secondary); margin-top: 1px; }
  .wl-pref-caption { font-size: 10px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.03em; }
  .wl-pref-range { font-size: 12.5px; font-weight: 550; margin-top: 1px; }
  .wl-pref-detail { font-size: 11.5px; color: var(--text-secondary); margin-top: 1px; }
  .wl-waiting { font-size: 12.5px; color: var(--text-secondary); }
  .wl-status { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
  .wl-offer-time { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
  .badge-waiting { background: var(--surface-subtle); color: var(--text-secondary); border: 1px solid var(--border-strong); }
  .badge-offered { background: var(--brand-soft); color: var(--brand-dark); }

  .wl-empty { text-align: center; padding: 56px 20px; }
  .wl-empty-icon {
    display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px;
    border-radius: 50%; background: var(--brand-soft); color: var(--brand-dark); margin-bottom: 14px;
  }
  .wl-empty-title { font-size: 14px; font-weight: 650; margin: 0 0 4px; color: var(--text-primary); }
  .wl-empty-sub { font-size: 12.5px; color: var(--text-tertiary); margin: 0; max-width: 320px; margin-left: auto; margin-right: auto; line-height: 1.5; }

  @media (max-width: 860px) {
    .wl-header { display: none; }
    .wl-row { grid-template-columns: 1fr; gap: 6px; padding: 14px 4px; }
    .wl-status { flex-direction: row; align-items: center; gap: 8px; }
  }
  `;

  return pageShell({
    title: `Lista de espera · ${clinic.name}`,
    brand: clinic.brandColor,
    active: "waitlist",
    clinic,
    bodyHtml: body,
    extraStyles,
  });
}
