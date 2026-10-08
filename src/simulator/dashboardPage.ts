import { pageShell, escapeHtml, ClinicBranding, icon } from "./layout";
import { DashboardStats } from "../services/reportingService";
import { AuditEventView } from "../services/auditLog";
import {
  serviceLabel,
  AUDIT_EVENT_LABEL,
  APPOINTMENT_STATUS_LABEL,
  APPOINTMENT_STATUS_BADGE_CLASS,
} from "../lib/labels";
import { formatShort, formatDayShort, formatTimeOnly } from "../lib/dates";
import { ServiceDef } from "../config";
import { LlmStats } from "../services/llmStats";

export interface AttentionItem {
  id: string;
  type: string;
  patientName: string | null;
  reason: string | null;
  createdAt: Date;
}

// Metadata "comercial": claves que sí merece la pena mostrar siempre en el
// feed por defecto, ya traducidas a texto legible. Cualquier otra clave
// (tool, ids técnicos...) queda oculta tras "Ver detalles" — ver punto 11
// de la auditoría: el feed es producto, no un log de debug.
function humanMeta(e: AuditEventView): string | null {
  const m = e.metadata as Record<string, any>;
  if (m.service) return serviceLabel(String(m.service));
  if (m.priceEur) return `${m.priceEur} €`;
  if (m.reason) return String(m.reason);
  return null;
}

/**
 * Tono de color por tipo de evento — no un color por cada uno de los ~20
 * tipos (eso sería "arcoíris"), solo 4 categorías con significado real:
 * éxito, aviso, problema, y "informativo" (mensajes/consultas, sin carga
 * emocional). Ver ronda de color, punto 6: la timeline debe escanearse más
 * rápido sin perder sobriedad.
 */
type EventTone = "success" | "warning" | "danger" | "brand" | "neutral";
const EVENT_TONE: Record<string, EventTone> = {
  APPOINTMENT_CREATED: "success",
  APPOINTMENT_CONFIRMED: "success",
  APPOINTMENT_COMPLETED: "success",
  WAITLIST_OFFER_ACCEPTED: "success",
  APPOINTMENT_CANCELLED: "danger",
  APPOINTMENT_NO_SHOW: "danger",
  AGENT_ERROR: "danger",
  RESCHEDULE_INCONSISTENT: "danger",
  APPOINTMENT_RESCHEDULED: "warning",
  WAITLIST_OFFER_EXPIRED: "warning",
  CALENDAR_SYNC_FAILED: "warning",
  HUMAN_HANDOFF_REQUESTED: "warning",
  SCHEDULED_JOB_FAILED: "warning",
  SLOT_RECOVERED: "brand",
  WAITLIST_OFFER_CREATED: "brand",
};
function eventTone(type: string): EventTone {
  return EVENT_TONE[type] || "neutral";
}

function eventLine(e: AuditEventView): string {
  const label = AUDIT_EVENT_LABEL[e.type] || e.type;
  const time = formatTimeOnly(new Date(e.createdAt));
  const meta = humanMeta(e);
  const rawEntries = Object.entries(e.metadata || {});
  const rawDetails = rawEntries.length
    ? `<details class="feed-details"><summary>Ver detalles</summary><code>${escapeHtml(
        rawEntries.map(([k, v]) => `${k}=${v}`).join(" · ")
      )}</code></details>`
    : "";
  // El momento de ingresos recuperados es la estrella del feed (ver punto
  // 10 de la auditoría visual) — destaca ligeramente más en la timeline,
  // el resto de eventos quedan al mismo nivel visual entre ellos, solo
  // diferenciados por su tono de color.
  const highlight = e.type === "SLOT_RECOVERED";
  const tone = eventTone(e.type);
  return `<div class="tl-row tone-${tone}${highlight ? " highlight" : ""}">
    <div class="tl-marker"><span class="tl-dot"></span></div>
    <div class="tl-content">
      <div class="tl-label">${escapeHtml(label)}</div>
      ${meta ? `<div class="tl-meta">${escapeHtml(meta)}</div>` : ""}
      <div class="tl-time">${time}</div>
      ${rawDetails}
    </div>
  </div>`;
}

export interface AgendaRow {
  id: string;
  service: string;
  startsAt: Date;
  status: string;
  patientName: string;
  professionalName: string | null;
  recoveredFromWaitlist: boolean;
}

const ATTENTION_LABEL: Record<string, string> = {
  HUMAN_HANDOFF_REQUESTED: "Derivado a atención humana",
  RESCHEDULE_INCONSISTENT: "Cambio de cita pendiente de revisión",
  SCHEDULED_JOB_FAILED: "Recordatorio u oferta pendiente de revisión",
  CALENDAR_SYNC_FAILED: "Fallo sincronizando calendario",
};

/**
 * Prioridad visual por tipo de incidencia — deliberadamente solo 3 niveles
 * (ver "Estado del sistema" / "Necesita atención"): un job de recordatorio
 * fallido es molesto pero recuperable (warning); un reschedule inconsistente
 * significa dos citas activas para el mismo cambio, alguien tiene que
 * mirarlo ya (critical). Nada nuevo que modelar — reutiliza los tipos que
 * ya existían en ATTENTION_EVENT_TYPES (services/auditLog.ts).
 */
type AttentionSeverity = "info" | "warning" | "critical";
const ATTENTION_SEVERITY: Record<string, AttentionSeverity> = {
  RESCHEDULE_INCONSISTENT: "critical",
  HUMAN_HANDOFF_REQUESTED: "warning",
  SCHEDULED_JOB_FAILED: "warning",
  CALENDAR_SYNC_FAILED: "warning",
};
function attentionSeverity(type: string): AttentionSeverity {
  // Un tipo nuevo no contemplado aquí se trata como "warning" por defecto:
  // ni pasa desapercibido (info) ni dispara una alarma que no se ha
  // calibrado a propósito (critical).
  return ATTENTION_SEVERITY[type] || "warning";
}

export function renderDashboardPage(
  clinic: ClinicBranding,
  stats: DashboardStats,
  events: AuditEventView[],
  agenda: AgendaRow[],
  demoService: ServiceDef,
  attention: AttentionItem[] = [],
  llmStats?: LlmStats
): string {
  const agendaRows = agenda.length
    ? agenda
        .map(
          (a) => `<div class="agenda-row">
        <div class="agenda-when"><span class="agenda-day">${formatDayShort(a.startsAt)}</span><span class="agenda-time">${formatTimeOnly(a.startsAt)}</span></div>
        <div class="agenda-main">
          <div class="agenda-patient">${escapeHtml(a.patientName)}</div>
          <div class="agenda-meta">${escapeHtml(serviceLabel(a.service))}${a.professionalName ? ` · ${escapeHtml(a.professionalName)}` : ""}</div>
        </div>
        <div class="agenda-status">
          <span class="badge ${APPOINTMENT_STATUS_BADGE_CLASS[a.status] || ""}">${APPOINTMENT_STATUS_LABEL[a.status] || a.status}</span>
          ${a.recoveredFromWaitlist ? '<span class="badge badge-recovered">recuperada</span>' : ""}
        </div>
      </div>`
        )
        .join("")
    : `<div class="empty-cell">No hay citas próximas todavía.<br><span class="muted">Prueba el simulador de chat o el escenario de demo de abajo.</span></div>`;

  const feedHtml = events.length
    ? `<div class="timeline">${events.map(eventLine).join("")}</div>`
    : `<div class="empty-cell">Todavía no hay actividad.<br><span class="muted">Habla con el agente en el chat o ejecuta la demo.</span></div>`;

  const demoPrice = demoService.priceEur != null ? `${demoService.priceEur} €` : "";

  // El título y el contenido de la sección reflejan el estado REAL del
  // sistema en vez de un heading fijo ("Necesita atención" quedaba mal
  // semánticamente cuando debajo decía "Todo al día") — ver punto 3 de
  // esta ronda. El conteo y los elementos son datos reales de AuditLog
  // (services/auditLog.ts -> listAttentionItems), nunca inventados.
  const hasAttention = attention.length > 0;
  const hasCriticalAttention = attention.some((a) => attentionSeverity(a.type) === "critical");
  const attentionTitle = hasAttention ? "Necesita atención" : "Estado del sistema";
  const attentionCountLine = hasAttention
    ? `<p class="attention-count">${attention.length} elemento${attention.length === 1 ? "" : "s"} pendiente${attention.length === 1 ? "" : "s"}</p>`
    : "";
  const attentionBody = hasAttention
    ? attention
        .map(
          (a) => `<div class="attention-row sev-${attentionSeverity(a.type)}">
        <span class="attention-icon">${icon("alert-triangle", { size: 14 })}</span>
        <div class="attention-text">
          <span class="attention-label">${escapeHtml(ATTENTION_LABEL[a.type] || a.type)}</span>
          <span class="attention-meta">${a.patientName ? escapeHtml(a.patientName) + " · " : ""}${a.reason ? escapeHtml(a.reason) : formatShort(a.createdAt)}</span>
        </div>
      </div>`
        )
        .join("")
    : `<div class="attention-ok">
        <span class="attention-ok-icon">${icon("check", { size: 13 })}</span>
        <div>
          <div class="attention-ok-title">Todo al día</div>
          <div class="attention-ok-sub">No hay nada pendiente de revisión.</div>
        </div>
      </div>`;

  const llmPanel = llmStats && llmStats.calls > 0
    ? `<section class="panel dev-panel">
      <div class="demo-panel-head"><h2>Rendimiento del agente</h2><span class="demo-tag">dev</span></div>
      <div class="llm-stats-grid">
        <div><span class="llm-value">${llmStats.calls}</span><span class="llm-label">llamadas LLM</span></div>
        <div><span class="llm-value">${llmStats.avgLatencyMs} ms</span><span class="llm-label">latencia media</span></div>
        <div><span class="llm-value">${llmStats.p95LatencyMs} ms</span><span class="llm-label">p95</span></div>
        <div><span class="llm-value">${Math.round(llmStats.successRate * 100)}%</span><span class="llm-label">éxito</span></div>
        <div><span class="llm-value">${(llmStats.totalPromptTokens + llmStats.totalCompletionTokens).toLocaleString("es-ES")}</span><span class="llm-label">tokens totales</span></div>
        <div><span class="llm-value">${llmStats.estimatedCostUsd != null ? "$" + llmStats.estimatedCostUsd.toFixed(4) : "—"}</span><span class="llm-label">coste aprox.</span></div>
      </div>
    </section>`
    : "";

  const body = `
  <section class="panel"><h1>Overview</h1><p>Resumen de la clínica · Este mes</p></section>
  <section class="hero-kpi">
    <div class="hero-kpi-label">${icon("calendar", { size: 12 })} Citas gestionadas</div>
    <div class="hero-kpi-value">${stats.totalAppointments}</div>
    <p class="hero-kpi-sub">Este mes · Consulta el estado de las citas, la próxima agenda y los asuntos pendientes.</p>
  </section>

  <section class="panel"><p>${stats.pendingAttendance} citas pendientes de registrar asistencia.</p><p>Citas recuperadas atendidas: <strong>${stats.recoveredAttended}</strong> · Valor atendido: <strong>${stats.recoveredAttendedValueEur.toLocaleString("es-ES")} €</strong> · Cobros registrados: <strong>${stats.recoveredPaidEur.toLocaleString("es-ES")} €</strong></p><a class="btn btn-primary" href="/simulator/operations">Abrir recepción y elegir periodo</a></section>
  <section class="stat-strip">
    <div class="stat-cell tone-brand"><span class="stat-icon">${icon("calendar", { size: 13 })}</span><div class="stat-value">${stats.recoveredSlots}</div><div class="stat-label">Huecos recuperados</div></div>
    <div class="stat-cell tone-success"><span class="stat-icon">${icon("check-circle", { size: 13 })}</span><div class="stat-value">${Math.round(stats.confirmationRate * 100)}%</div><div class="stat-label">Citas confirmadas</div></div>
    <div class="stat-cell tone-warning"><span class="stat-icon">${icon("alert-triangle", { size: 13 })}</span><div class="stat-value">${stats.noShow}</div><div class="stat-label">No-shows</div></div>
    <div class="stat-cell tone-neutral"><span class="stat-icon">${icon("list", { size: 13 })}</span><div class="stat-value">${stats.totalAppointments}</div><div class="stat-label">Citas gestionadas</div></div>
  </section>

  <section class="panel attention-panel${hasAttention ? (hasCriticalAttention ? " has-critical" : " has-items") : ""}">
    <h2>${attentionTitle}</h2>
    ${attentionCountLine}
    <div class="attention-list">${attentionBody}</div>
  </section>

  <div class="grid-2">
    <section class="panel">
      <h2>Agenda próxima</h2>
      <div class="agenda-list" id="agendaBody">${agendaRows}</div>
    </section>

    <section class="panel">
      <h2>Actividad en directo</h2>
      <div class="feed" id="feed">${feedHtml}</div>
    </section>
  </div>

  <section class="panel demo-panel">
    <div class="demo-panel-head">
      <h2>Demo</h2>
      <span class="demo-tag">solo para enseñar el producto</span>
    </div>
    <p class="muted">No existirían así de cara al paciente real — son atajos para demostrar el flujo completo sin esperar a que pase de verdad.</p>
    <div class="demo-actions">
      <button class="btn btn-primary btn-sm" id="btnRecover" ${!demoService.id ? "disabled" : ""}>${icon("play", { size: 13 })} Ejecutar demo: recuperar hueco${demoPrice ? ` (${demoPrice})` : ""}</button>
      <button class="btn btn-ghost btn-sm" id="btnSeed">${icon("seed", { size: 13 })} Sembrar datos de ejemplo</button>
      <button class="btn btn-danger-ghost btn-sm" id="btnReset">${icon("trash", { size: 13 })} Reiniciar datos de demo</button>
    </div>
  </section>

  ${llmPanel}
  `;

  const extraStyles = `
  .hero-kpi {
    background: linear-gradient(160deg, var(--brand-tint), var(--surface) 55%);
    border: 1px solid color-mix(in srgb, var(--brand) 18%, var(--border)); border-radius: var(--radius-lg);
    padding: 26px 28px 28px; margin-bottom: 14px; position: relative; overflow: hidden;
  }
  .hero-kpi::before {
    content: ""; position: absolute; top: -50%; right: -10%; width: 340px; height: 340px; border-radius: 50%;
    background: var(--brand); opacity: 0.12; filter: blur(75px); pointer-events: none;
  }
  .hero-kpi-label {
    display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; color: var(--brand-dark);
    position: relative; text-transform: uppercase; letter-spacing: 0.03em;
  }
  .hero-kpi-label .icon { opacity: 0.85; }
  .hero-kpi-value { font-size: 54px; font-weight: 750; letter-spacing: -0.025em; line-height: 1.1; font-variant-numeric: tabular-nums; position: relative; margin-top: 6px; color: var(--text-primary); }
  .hero-kpi-sub { font-size: 12.5px; color: var(--text-secondary); margin: 5px 0 0; max-width: 440px; position: relative; }

  .stat-strip { display: grid; grid-template-columns: repeat(4, 1fr); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); margin-bottom: 16px; overflow: hidden; }
  .stat-cell { padding: 15px 18px; border-right: 1px solid var(--border); }
  .stat-cell:last-child { border-right: none; }
  .stat-icon {
    display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;
    border-radius: 6px; margin-bottom: 8px;
  }
  .stat-cell.tone-brand .stat-icon { background: var(--brand-soft); color: var(--brand-dark); }
  .stat-cell.tone-success .stat-icon { background: var(--success-soft); color: var(--success); }
  .stat-cell.tone-warning .stat-icon { background: var(--warning-soft); color: var(--warning); }
  .stat-cell.tone-neutral .stat-icon { background: var(--surface-subtle); color: var(--text-tertiary); }
  .stat-value { font-size: 21px; font-weight: 700; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
  .stat-label { font-size: 11.5px; color: var(--text-secondary); margin-top: 3px; }
  @media (max-width: 640px) {
    .stat-strip { grid-template-columns: repeat(2, 1fr); }
    .stat-cell:nth-child(odd) { border-right: 1px solid var(--border); }
    .stat-cell:nth-child(even) { border-right: none; }
    .stat-cell:nth-child(-n+2) { border-bottom: 1px solid var(--border); }
  }

  .grid-2 { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; align-items: start; }
  @media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }

  /* --- Agenda: filas escaneables, no una tabla de 5 columnas (ver punto 11) --- */
  .agenda-list { display: flex; flex-direction: column; }
  .agenda-row { display: grid; grid-template-columns: 56px 1fr auto; gap: 12px; align-items: center; padding: 10px 2px; border-bottom: 1px solid var(--border); }
  .agenda-row:last-child { border-bottom: none; }
  .agenda-when { display: flex; flex-direction: column; }
  .agenda-day { font-size: 10px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.03em; }
  .agenda-time { font-size: 13.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .agenda-main { min-width: 0; }
  .agenda-patient { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agenda-meta { font-size: 12px; color: var(--text-secondary); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agenda-status { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  @media (max-width: 480px) {
    .agenda-row { grid-template-columns: 44px 1fr auto; gap: 8px; }
    .agenda-meta { white-space: normal; }
  }

  .badge-confirmed { background: var(--success-soft); color: var(--success); }
  .badge-pending { background: var(--warning-soft); color: var(--warning); }
  .badge-cancelled { background: var(--danger-soft); color: var(--danger); }
  .badge-completed { background: var(--surface-subtle); color: var(--text-secondary); }
  .badge-noshow { background: var(--danger-soft); color: var(--danger); }
  .badge-recovered { background: var(--brand-soft); color: var(--brand-dark); }

  /* --- Activity feed: timeline con línea de conexión (ver punto 10) --- */
  .feed { max-height: 400px; overflow-y: auto; }
  .timeline { display: flex; flex-direction: column; }
  .tl-row { display: flex; gap: 10px; padding: 0 2px; animation: feed-in 0.25s ease-out; }
  @keyframes feed-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
  .tl-marker { position: relative; width: 14px; flex-shrink: 0; display: flex; justify-content: center; padding-top: 9px; }
  .tl-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border-strong); position: relative; z-index: 1; flex-shrink: 0; }
  .tl-marker::before { content: ""; position: absolute; top: 15px; bottom: -12px; left: 50%; width: 1px; background: var(--border); transform: translateX(-50%); }
  .tl-row:last-child .tl-marker::before { display: none; }
  .tl-content { flex: 1; min-width: 0; padding: 8px 0 12px; }
  .tl-label { font-size: 12.5px; font-weight: 600; }
  .tl-meta { font-size: 11.5px; color: var(--text-secondary); margin-top: 1px; }
  .tl-time { font-size: 10.5px; color: var(--text-tertiary); margin-top: 2px; font-variant-numeric: tabular-nums; }
  /* Tono por tipo de evento — solo el punto de la timeline se colorea,
     nada de chips ni fondos grandes (ver ronda de color, punto 6). */
  .tl-row.tone-success .tl-dot { background: var(--success); }
  .tl-row.tone-danger .tl-dot { background: var(--danger); }
  .tl-row.tone-warning .tl-dot { background: var(--warning); }
  .tl-row.tone-brand .tl-dot { background: var(--brand); }
  .tl-row.highlight .tl-dot { box-shadow: 0 0 0 3px var(--brand-soft); }
  .tl-row.highlight .tl-label { color: var(--brand-dark); }
  .tl-row.highlight .tl-meta { color: var(--brand-dark); font-weight: 650; }
  .feed-details { margin-top: 3px; }
  .feed-details summary { color: var(--text-tertiary); font-size: 10.5px; cursor: pointer; user-select: none; }
  .feed-details code { display: block; margin-top: 3px; font-size: 10.5px; color: var(--text-tertiary); word-break: break-all; }

  /* --- Panel de demo: deliberadamente secundario (ver punto 36) --- */
  .demo-panel { background: var(--surface-subtle); border-style: dashed; }
  .demo-panel-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .demo-panel-head h2 { margin: 0; font-size: 13px; color: var(--text-secondary); }
  .demo-tag { font-size: 9.5px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary); border: 1px solid var(--border-strong); padding: 1px 6px; border-radius: 999px; }
  .demo-panel p { font-size: 12px; margin: 0 0 14px; line-height: 1.5; }
  .demo-actions { display: flex; flex-wrap: wrap; gap: 8px; }

  .attention-panel h2 { margin: 0 0 4px; }
  .attention-panel { border-color: var(--border); transition: border-color 0.15s; }
  .attention-panel.has-items { border-color: color-mix(in srgb, var(--warning) 45%, var(--border)); }
  .attention-panel.has-critical { border-color: color-mix(in srgb, var(--danger) 50%, var(--border)); }
  .attention-count { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: var(--warning); }
  .attention-panel.has-critical .attention-count { color: var(--danger); }
  .attention-list { display: flex; flex-direction: column; gap: 6px; }
  .attention-row {
    display: flex; gap: 8px; align-items: flex-start; font-size: 13px;
    padding: 8px 10px; background: var(--surface-subtle); border-radius: var(--radius-sm);
  }
  .attention-icon { flex-shrink: 0; margin-top: 1px; color: var(--warning); }
  .attention-row.sev-critical .attention-icon { color: var(--danger); }
  .attention-row.sev-info .attention-icon { color: var(--brand); }
  .attention-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .attention-label { font-weight: 600; }
  .attention-meta { color: var(--text-secondary); font-size: 12px; }
  .attention-ok {
    display: flex; align-items: center; gap: 12px; padding: 10px 12px;
    background: var(--success-soft); border-radius: var(--radius-sm);
  }
  .attention-ok-icon {
    width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0;
    background: var(--surface); color: var(--success);
    display: flex; align-items: center; justify-content: center;
  }
  .attention-ok-title { font-size: 13.5px; font-weight: 650; color: var(--text-primary); }
  .attention-ok-sub { font-size: 12px; color: var(--text-secondary); margin-top: 1px; }

  .dev-panel { opacity: 0.92; }
  .llm-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 12px; }
  .llm-stats-grid > div { display: flex; flex-direction: column; }
  .llm-value { font-size: 16px; font-weight: 650; }
  .llm-label { font-size: 11px; color: var(--text-secondary); }

  .recovery-card { max-width: 340px; text-align: left; }
  .recovery-steps { display: flex; flex-direction: column; gap: 10px; margin: 18px 0; min-height: 168px; }
  .recovery-step { display: flex; align-items: center; gap: 10px; font-size: 13.5px; opacity: 0.3; transition: opacity 0.2s; }
  .recovery-step.done { opacity: 1; }
  .recovery-step .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border-strong); flex-shrink: 0; }
  .recovery-step.done .dot { background: var(--success); }
  .recovery-result { text-align: center; opacity: 0; transform: translateY(6px) scale(0.98); transition: opacity 0.25s, transform 0.25s; }
  .recovery-result.show { opacity: 1; transform: translateY(0) scale(1); }
  .recovery-result .amount { font-size: 32px; font-weight: 700; color: var(--success); letter-spacing: -0.02em; }
  .recovery-result .caption { font-size: 12.5px; color: var(--text-secondary); margin-top: 2px; }
  @media (prefers-reduced-motion: reduce) { .tl-row { animation: none; } .recovery-step, .recovery-result { transition: none; } }
  `;

  const bodyScript = `
  async function refreshDashboard() {
    try {
      const res = await fetch("/simulator/api/dashboard");
      const data = await res.json();
      document.querySelector(".hero-kpi-value").textContent = data.stats.totalAppointments;
      const statVals = document.querySelectorAll(".stat-value");
      statVals[0].textContent = data.stats.recoveredSlots;
      statVals[1].textContent = Math.round(data.stats.confirmationRate * 100) + "%";
      statVals[2].textContent = data.stats.noShow;
      statVals[3].textContent = data.stats.totalAppointments;
    } catch (e) {}
  }
  setInterval(refreshDashboard, 8000);

  function setBusy(btn, busy) { btn.disabled = busy; }

  document.getElementById("btnSeed").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    setBusy(btn, true);
    try {
      const res = await fetch("/simulator/api/demo/seed", { method: "POST" });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast("Datos de ejemplo sembrados");
      setTimeout(() => location.reload(), 700);
    } catch (err) { toast("Error: " + err.message, "error"); }
    finally { setBusy(btn, false); }
  });

  document.getElementById("btnReset").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const ok = await confirmDialog("¿Borrar todos los datos de demo (pacientes demo-*, citas, listas, actividad)?", "Reiniciar");
    if (!ok) return;
    setBusy(btn, true);
    try {
      const res = await fetch("/simulator/api/demo/reset-all", { method: "POST" });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast("Demo reiniciada");
      setTimeout(() => location.reload(), 700);
    } catch (err) { toast("Error: " + err.message, "error"); }
    finally { setBusy(btn, false); }
  });

  const RECOVERY_STEPS = [
    "La cita se cancela",
    "Buscando lista de espera compatible",
    "Oferta enviada al siguiente candidato",
    "Oferta aceptada",
    "Nueva cita creada",
  ];

  function showRecoveryOverlay() {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML =
      '<div class="confirm-card recovery-card">' +
      '<p style="margin-bottom:10px;font-weight:650;color:var(--text-primary);">Simulando recuperación de hueco…</p>' +
      '<div class="recovery-steps">' +
      RECOVERY_STEPS.map((s) => '<div class="recovery-step"><span class="dot"></span><span>' + s + '</span></div>').join("") +
      '</div>' +
      '<div class="recovery-result"><div class="amount"></div><div class="caption"></div></div>' +
      '</div>';
    document.body.appendChild(overlay);
    return overlay;
  }

  async function playSteps(overlay) {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const steps = overlay.querySelectorAll(".recovery-step");
    for (const step of steps) {
      step.classList.add("done");
      if (!reduceMotion) await new Promise((r) => setTimeout(r, 240));
    }
  }

  document.getElementById("btnRecover").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    setBusy(btn, true);
    const overlay = showRecoveryOverlay();
    try {
      const [data] = await Promise.all([
        fetch("/simulator/api/demo/recover-slot-scenario", { method: "POST" }).then((r) => r.json()),
        playSteps(overlay),
      ]);
      if (data.error) throw new Error(data.error);

      const result = overlay.querySelector(".recovery-result");
      result.querySelector(".amount").textContent = "+" + data.priceEur + " €";
      result.querySelector(".caption").textContent = "Hueco recuperado · " + data.serviceLabel;
      result.classList.add("show");
      await refreshDashboard();
      setTimeout(() => { overlay.remove(); location.reload(); }, 1700);
    } catch (err) {
      overlay.remove();
      toast("Error: " + err.message, "error");
    } finally {
      setBusy(btn, false);
    }
  });
  `;

  return pageShell({
    title: `Overview · ${clinic.name}`,
    brand: clinic.brandColor,
    active: "dashboard",
    clinic,
    bodyHtml: body,
    extraStyles,
    bodyScript,
  });
}
