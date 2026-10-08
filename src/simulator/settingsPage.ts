import { pageShell, ClinicBranding, escapeHtml, icon } from "./layout";
import { ClinicSettings } from "../services/clinicSettings";
import type { Professional } from "@prisma/client";
import { parseServiceIds } from "../services/professionals";
import { ServiceDef } from "../config";
import { OpeningHours } from "../services/serviceCatalog";

const WEEKDAYS: { idx: number; label: string; short: string }[] = [
  { idx: 1, label: "Lunes", short: "L" },
  { idx: 2, label: "Martes", short: "M" },
  { idx: 3, label: "Miércoles", short: "X" },
  { idx: 4, label: "Jueves", short: "J" },
  { idx: 5, label: "Viernes", short: "V" },
  { idx: 6, label: "Sábado", short: "S" },
  { idx: 0, label: "Domingo", short: "D" },
];

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Un servicio requiere al menos un profesional activo con asignación explícita. */
function hasNoEligibleProfessional(serviceId: string, activeProfessionals: Professional[]): boolean {
  if (activeProfessionals.length === 0) return true;
  return !activeProfessionals.some((p) => {
    const ids = parseServiceIds(p.serviceIds);
    return ids.includes(serviceId);
  });
}

export function renderSettingsPage(
  settings: ClinicSettings,
  professionals: Professional[] = [],
  services: (ServiceDef & { active: boolean })[] = [],
  openingHours: OpeningHours = {}
): string {
  const clinic: ClinicBranding = { name: settings.name, brandColor: settings.brandColor };

  const servicesRows = services.length
    ? services
        .map((s) => {
          // Solo tiene sentido avisar de servicios ACTIVOS: uno inactivo ya
          // no admite reservas nuevas por sí mismo, así que la advertencia
          // no aportaría nada (ver punto "Servicio ↔ Profesional").
          const unstaffed = s.active && hasNoEligibleProfessional(s.id, professionals);
          return `<div class="svc-row${s.active ? "" : " row-inactive"}">
            <div class="svc-main">
              <div class="svc-name">${escapeHtml(s.label)}</div>
              <div class="svc-meta">${s.durationMinutes} min${s.priceEur != null ? ` · ${s.priceEur} €` : ""}</div>
              ${unstaffed ? `<div class="unstaffed-warning" title="Mientras no tenga un profesional que lo realice, este servicio no podrá recibir reservas nuevas.">${icon("alert-triangle", { size: 11 })} Sin profesionales asignados</div>` : ""}
            </div>
            <span class="badge ${s.active ? "badge-active" : "badge-inactive"}">${s.active ? "Activo" : "Inactivo"}</span>
            <div class="svc-actions">
              <button type="button" class="btn-text" data-edit-service='${escapeHtml(JSON.stringify(s))}'>${icon("edit", { size: 13 })} Editar</button>
              <button type="button" class="btn-text${s.active ? " danger" : ""}" data-toggle-service="${s.id}" data-next-active="${!s.active}">${s.active ? "Desactivar" : "Activar"}</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="empty-cell">No hay servicios todavía.</div>`;

  const professionalsRows = professionals.length
    ? professionals
        .map((p) => {
          const selected = new Set(parseServiceIds(p.serviceIds));
          const activeServices = services.filter((s) => s.active);
          const chips = activeServices.length
            ? activeServices
                .map(
                  (s) => `<button type="button" class="service-toggle-chip${selected.has(s.id) ? " selected" : ""}"
                    data-service-id="${s.id}" aria-pressed="${selected.has(s.id)}">
                    <span class="check" aria-hidden="true">${icon("check", { size: 10 })}</span><span class="chip-label">${escapeHtml(s.label)}</span>
                  </button>`
                )
                .join("")
            : `<span class="muted">No hay servicios activos que asignar.</span>`;
          return `<div class="pro-row">
            <div class="pro-head">
              <span class="pro-name">${escapeHtml(p.name)}</span>
              <span class="badge badge-active">Activo</span>
              <button type="button" class="btn-text danger pro-deactivate" data-deactivate="${p.id}">Dar de baja</button>
            </div>
            <div class="service-chip-group" data-professional="${p.id}" role="group" aria-label="Servicios de ${escapeHtml(p.name)}">${chips}</div>
            <span class="hint">Vacío = cualquier servicio · toca para activar/desactivar</span>
          </div>`;
        })
        .join("")
    : `<div class="empty-cell">No hay profesionales dados de alta — cualquier servicio se asigna automáticamente.</div>`;

  const hoursBlocks = WEEKDAYS.map(({ idx, label, short }) => {
    const ranges = openingHours[idx] || [];
    const rowsHtml = ranges
      .map(
        (r, i) => `<div class="hour-row" data-idx="${i}">
          <input type="time" class="hour-start" value="${r.start}" aria-label="Hora de inicio del tramo ${i + 1} — ${label}" />
          <span class="hour-sep" aria-hidden="true">–</span>
          <input type="time" class="hour-end" value="${r.end}" aria-label="Hora de fin del tramo ${i + 1} — ${label}" />
          <button type="button" class="btn-icon-remove" data-remove-block aria-label="Eliminar este tramo">${icon("x", { size: 13 })}</button>
        </div>`
      )
      .join("");
    return `<div class="day-block" data-weekday="${idx}">
      <div class="day-head">
        <span class="day-badge${ranges.length > 0 ? " is-open" : ""}">${short}</span>
        <strong>${label}</strong>
        <span class="closed-tag"${ranges.length === 0 ? "" : " hidden"}>Cerrado</span>
        <span class="unsaved-badge" hidden>· cambios sin guardar</span>
      </div>
      <div class="hour-rows">${rowsHtml}</div>
      <div class="day-error" role="alert" hidden></div>
      <div class="day-actions">
        <button type="button" class="btn-text" data-add-block>${icon("plus", { size: 13 })} Añadir tramo</button>
        <button type="button" class="btn btn-ghost btn-sm" data-save-day>Guardar</button>
      </div>
    </div>`;
  }).join("");

  const body = `
  <div class="settings-page-head">
    <h1>Ajustes</h1>
    <p class="muted">Cámbialo y guarda: el simulador entero se actualiza al momento.</p>
  </div>

  <div class="settings-grid">
    <div class="settings-col">
      <section class="panel">
        <div class="panel-head"><span class="section-icon-chip">${icon("sparkle", { size: 15 })}</span><h2>Identidad</h2></div>
        <p class="panel-desc">Cómo se presenta el centro en el chat y en esta demo.</p>

        <form id="settingsForm">
          <label>Nombre del centro
            <input type="text" name="name" value="${attr(settings.name)}" required />
          </label>
          <label>Subtítulo (tagline)
            <input type="text" name="tagline" value="${attr(settings.tagline)}" placeholder="Asistente virtual de citas" />
          </label>
          <label>Color de marca
            <div class="color-row">
              <label class="color-swatch-wrap">
                <input type="color" name="brandColorPicker" value="${attr(settings.brandColor)}" />
              </label>
              <input type="text" name="brandColor" value="${attr(settings.brandColor)}" pattern="^#[0-9a-fA-F]{6}$" class="color-hex" />
            </div>
          </label>
          <label>URL del logo (opcional)
            <input type="url" name="logoUrl" value="${attr(settings.logoUrl)}" placeholder="https://…/logo.png" />
            <span class="hint">Vacío = avatar con las iniciales del centro, en el color de marca.</span>
          </label>
          <label>Zona horaria
            <input type="text" name="timezone" value="${attr(settings.timezone)}" placeholder="Europe/Madrid" />
          </label>

          <button class="btn btn-primary" type="submit">Guardar cambios</button>
        </form>
      </section>

      <section class="panel">
        <div class="panel-head"><span class="section-icon-chip">${icon("tag", { size: 15 })}</span><h2>Servicios</h2></div>
        <p class="panel-desc">Lo que ofrece el centro. Desactivar un servicio no borra las citas ya hechas con él — solo deja de poder reservarse.</p>
        <div class="svc-list" id="servicesBody">${servicesRows}</div>
        <button type="button" class="btn btn-ghost btn-sm" id="addServiceBtn" style="margin-top:14px">${icon("plus", { size: 13 })} Nuevo servicio</button>
      </section>

      <section class="panel">
        <div class="panel-head"><span class="section-icon-chip">${icon("user", { size: 15 })}</span><h2>Profesionales</h2></div>
        <p class="panel-desc">Quién atiende, y qué servicios sabe hacer cada uno (sin asignaciones = no recibe citas). El motor de reservas respeta esto siempre.</p>
        <div class="pro-list" id="professionalsBody">${professionalsRows}</div>
        <form id="addProfessionalForm" class="inline-form">
          <input type="text" name="name" placeholder="Nombre del profesional" maxlength="80" required />
          <button class="btn btn-ghost btn-sm" type="submit">${icon("plus", { size: 13 })} Añadir</button>
        </form>
      </section>

      <section class="panel">
        <div class="panel-head"><span class="section-icon-chip">${icon("waitlist", { size: 15 })}</span><h2>Horario de apertura</h2></div>
        <p class="panel-desc">Un tramo, horario partido (mañana/tarde), o "Cerrado" si quitas todos los tramos de un día.</p>
        <div class="hours-grid">${hoursBlocks}</div>
      </section>
    </div>

    <aside class="preview-col">
      <div class="preview-sticky">
        <span class="preview-label">Vista previa en vivo</span>
        <div class="preview-frame">
          <div class="preview-phone" id="previewPhone">
            <div class="preview-header" id="previewHeader">
              <div class="preview-avatar" id="previewAvatar">${settings.logoUrl ? `<img src="${attr(settings.logoUrl)}" />` : escapeHtml(initials(settings.name))}</div>
              <div>
                <strong id="previewName">${escapeHtml(settings.name)}</strong>
                <div class="preview-status"><span class="preview-dot"></span><span id="previewTagline">${escapeHtml(settings.tagline)}</span></div>
              </div>
            </div>
            <div class="preview-body">
              <div class="preview-bubble">Escribe algo como "hola, quiero pedir cita" para empezar.</div>
            </div>
          </div>
        </div>
        <p class="preview-hint">Así se verá el chat con estos datos — sin necesidad de guardar.</p>
      </div>
    </aside>
  </div>

  <div class="overlay" id="serviceModalOverlay" style="display:none">
    <div class="confirm-card service-modal">
      <h3 id="serviceModalTitle">Nuevo servicio</h3>
      <form id="serviceForm">
        <input type="hidden" name="id" />
        <label>Nombre <input type="text" name="name" required maxlength="80" /></label>
        <label>Duración (minutos) <input type="number" name="durationMinutes" min="1" max="480" required /></label>
        <label>Precio en € (opcional) <input type="number" name="priceEur" min="0" step="0.01" /></label>
        <div class="confirm-actions">
          <button type="button" class="dlg-btn-ghost" id="serviceModalCancel">Cancelar</button>
          <button type="submit" class="btn btn-primary">Guardar</button>
        </div>
      </form>
    </div>
  </div>`;

  const extraStyles = `
  .settings-page-head { margin-bottom: 20px; }
  .settings-page-head p { margin: 4px 0 0; }
  .settings-grid { display: flex; flex-direction: column; gap: 16px; align-items: flex-start; }
  @media (min-width: 1080px) {
    .settings-grid { flex-direction: row; }
    .settings-col { flex: 1; min-width: 0; }
    .preview-col { width: 300px; flex-shrink: 0; }
  }
  .panel { max-width: 640px; padding: 22px 24px; }
  .panel-head { margin-bottom: 2px; }

  .color-row { display: flex; gap: 8px; align-items: center; }
  .color-swatch-wrap { display: block; width: 38px; height: 38px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); overflow: hidden; cursor: pointer; flex-shrink: 0; }
  input[type=color] { width: 100%; height: 100%; border: none; padding: 0; cursor: pointer; }
  .color-hex { font-variant-numeric: tabular-nums; text-transform: uppercase; }
  .btn-icon-remove { background: none; border: none; color: var(--text-tertiary); cursor: pointer; padding: 4px; line-height: 1; border-radius: 6px; display: inline-flex; }
  .btn-icon-remove:hover { color: var(--danger); background: var(--danger-soft); }
  .actions-cell { white-space: nowrap; }

  /* --- Servicios: filas compactas, no una tabla ancha (ver punto 28) --- */
  .svc-list { display: flex; flex-direction: column; }
  .svc-row { display: flex; align-items: center; gap: 12px; padding: 12px 2px; border-bottom: 1px solid var(--border); }
  .svc-row:last-child { border-bottom: none; }
  .svc-row.row-inactive { opacity: 0.55; }
  .svc-main { flex: 1; min-width: 0; }
  .svc-name { font-size: 13.5px; font-weight: 600; }
  .svc-meta { font-size: 12px; color: var(--text-secondary); margin-top: 1px; }
  .svc-actions { display: flex; gap: 2px; flex-shrink: 0; }
  .badge-active { background: var(--success-soft); color: var(--success); }
  .badge-inactive { background: var(--surface-subtle); color: var(--text-secondary); }
  .unstaffed-warning { display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--warning); margin-top: 3px; }

  /* --- Profesionales --- */
  .pro-list { display: flex; flex-direction: column; gap: 16px; }
  .pro-row { padding: 14px 2px; border-bottom: 1px solid var(--border); }
  .pro-row:last-child { border-bottom: none; padding-bottom: 2px; }
  .pro-head { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
  .pro-name { font-size: 13.5px; font-weight: 650; }
  .pro-deactivate { margin-left: auto; }
  .inline-form { flex-direction: row; gap: 8px; margin-top: 14px; }
  .inline-form input { flex: 1; margin: 0; }

  .service-chip-group { display: flex; flex-wrap: wrap; gap: 7px; max-width: 440px; max-height: 96px; overflow-y: auto; padding-right: 2px; }
  .service-toggle-chip {
    display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border-strong); background: var(--surface-subtle);
    color: var(--text-secondary); padding: 6px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 550;
    cursor: pointer; font-family: inherit; transition: background 0.12s, border-color 0.12s, color 0.12s, transform 0.08s;
    max-width: 100%;
  }
  .service-toggle-chip .chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .service-toggle-chip .check { display: none; }
  .service-toggle-chip:hover:not(:disabled) { border-color: var(--brand); background: var(--surface); transform: translateY(-1px); }
  .service-toggle-chip.selected {
    background: var(--brand-soft); border-color: var(--brand); color: var(--brand-dark); font-weight: 650;
  }
  .service-toggle-chip.selected .check { display: inline-flex; }
  .service-toggle-chip:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
  .service-toggle-chip:disabled { opacity: 0.5; cursor: default; }

  /* --- Horario: días diferenciados, sin saturar de CTAs (ver punto 31/32) --- */
  .hours-grid { display: flex; flex-direction: column; gap: 8px; }
  .day-block { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 13px 15px; transition: border-color 0.15s; }
  .day-block.has-error { border-color: var(--danger); }
  .day-head { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; margin-bottom: 9px; font-size: 13px; }
  .day-badge {
    width: 20px; height: 20px; border-radius: 6px; background: var(--surface-subtle); color: var(--text-tertiary);
    display: flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 700; flex-shrink: 0;
    transition: background 0.15s, color 0.15s;
  }
  /* El propio color de la inicial del día ya dice si está abierto — menos
     texto, más escaneo visual (ver ronda de color). */
  .day-badge.is-open { background: var(--brand-soft); color: var(--brand-dark); }
  .closed-tag { font-size: 10.5px; color: var(--text-tertiary); background: var(--surface-subtle); padding: 2px 8px; border-radius: 999px; }
  .unsaved-badge { font-size: 11px; color: var(--warning); font-weight: 600; margin-left: auto; }
  .day-error {
    display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
    border-radius: var(--radius-sm); padding: 7px 10px; margin: 8px 0 0;
  }
  /* Bug real corregido (ronda anterior): la propiedad display:flex de la
     regla de arriba (una regla de autor) gana siempre a display:none del
     atributo hidden (regla de user-agent), sin importar el orden — así que
     sin este override el contenedor de error se veía como una barra roja
     vacía aunque hidden estuviera puesto y no hubiera ningún error real. */
  .day-error[hidden] { display: none; }
  .hour-rows { display: flex; flex-direction: column; gap: 6px; }
  .hour-row { display: flex; align-items: center; gap: 8px; }
  .hour-row input[type=time] { padding: 6px 9px; font-size: 12.5px; height: 32px; width: 104px; }
  .hour-sep { color: var(--text-tertiary); }
  .day-actions { display: flex; gap: 4px; align-items: center; margin-top: 9px; }
  /* El botón de guardar solo "destaca" (primary) cuando ese día tiene
     cambios sin guardar — el resto del tiempo queda neutro, para no tener
     7 CTAs verdes fuertes uno debajo de otro (ver punto 32). */
  .day-actions [data-save-day] { margin-left: auto; }

  .service-modal { max-width: 340px; text-align: left; }
  .service-modal h3 { margin: 0 0 14px; font-size: 15px; }

  .preview-sticky { position: sticky; top: 72px; display: flex; flex-direction: column; gap: 10px; }
  .preview-label { font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary); }
  /* Halo de marca detrás del móvil — la preview es una mini-demo de marca,
     no una caja neutra más (ver ronda de color, punto 17). */
  .preview-frame { position: relative; padding: 10px; }
  .preview-frame::before {
    content: ""; position: absolute; inset: -6px; border-radius: calc(var(--radius-lg) + 10px);
    background: radial-gradient(circle at 30% 0%, var(--brand), transparent 65%);
    opacity: 0.16; filter: blur(22px); pointer-events: none; z-index: 0;
  }
  .preview-phone {
    position: relative; z-index: 1; border: 1px solid color-mix(in srgb, var(--brand) 22%, var(--border));
    border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow-md); background: var(--surface);
    transition: transform 0.18s ease;
  }
  .preview-phone.pulse { animation: preview-pulse 0.4s ease-out; }
  @keyframes preview-pulse { 0% { transform: scale(1); } 45% { transform: scale(1.012); } 100% { transform: scale(1); } }
  .preview-header { display: flex; align-items: center; gap: 10px; padding: 14px; color: white; }
  .preview-avatar { width: 38px; height: 38px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; overflow: hidden; flex-shrink: 0; }
  .preview-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .preview-header strong { font-size: 13.5px; display: block; }
  .preview-status { display: flex; align-items: center; gap: 5px; font-size: 11px; opacity: 0.9; margin-top: 1px; }
  .preview-dot { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; }
  .preview-body { background: var(--surface-subtle); padding: 14px; min-height: 90px; }
  .preview-bubble { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; font-size: 12.5px; color: var(--text-primary); max-width: 85%; }
  .preview-hint { font-size: 11px; color: var(--text-tertiary); margin: 0; }
  @media (prefers-reduced-motion: reduce) { .preview-phone.pulse { animation: none; } }
  `;

  const bodyScript = `
  const form = document.getElementById("settingsForm");
  const colorPicker = form.brandColorPicker;
  const colorText = form.brandColor;

  let previewPulseTimer = null;
  function updatePreview(pulse) {
    document.getElementById("previewName").textContent = form.name.value || "Tu clínica";
    document.getElementById("previewTagline").textContent = form.tagline.value || "Asistente virtual de citas";
    document.getElementById("previewHeader").style.background =
      "linear-gradient(135deg, " + form.brandColor.value + ", " + form.brandColor.value + "cc)";
    const avatar = document.getElementById("previewAvatar");
    if (form.logoUrl.value.trim()) {
      avatar.innerHTML = '<img src="' + form.logoUrl.value.trim().replace(/"/g, "") + '" />';
    } else {
      const words = (form.name.value || "?").trim().split(/\\s+/).filter(Boolean);
      const ini = words.length === 0 ? "?" : words.length === 1 ? words[0].slice(0,2).toUpperCase() : (words[0][0]+words[1][0]).toUpperCase();
      avatar.textContent = ini;
    }
    // Pequeño pulso al reaccionar a un cambio real — la preview "responde"
    // en vez de solo actualizarse en silencio (microinteracción sutil).
    if (pulse) {
      const phone = document.getElementById("previewPhone");
      phone.classList.remove("pulse");
      void phone.offsetWidth;
      phone.classList.add("pulse");
      clearTimeout(previewPulseTimer);
      previewPulseTimer = setTimeout(() => phone.classList.remove("pulse"), 450);
    }
  }
  ["name","tagline","logoUrl"].forEach((n) => form[n].addEventListener("input", () => updatePreview(true)));
  colorPicker.addEventListener("input", () => { colorText.value = colorPicker.value; updatePreview(true); });
  colorText.addEventListener("input", () => { if (/^#[0-9a-fA-F]{6}$/.test(colorText.value)) colorPicker.value = colorText.value; updatePreview(true); });
  updatePreview(false);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      const payload = {
        name: form.name.value, tagline: form.tagline.value, brandColor: form.brandColor.value,
        logoUrl: form.logoUrl.value, timezone: form.timezone.value,
      };
      const res = await fetch("/simulator/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast("Configuración guardada");
      setTimeout(() => location.reload(), 600);
    } catch (err) { toast("Error: " + err.message, "error"); }
    finally { submitBtn.disabled = false; }
  });

  // --- Profesionales (alta/baja ya existían; se añade edición de servicios) ---
  const addProForm = document.getElementById("addProfessionalForm");
  addProForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = addProForm.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const res = await fetch("/simulator/api/professionals", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: addProForm.name.value }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast("Profesional añadido");
      setTimeout(() => location.reload(), 500);
    } catch (err) { toast("Error: " + err.message, "error"); btn.disabled = false; }
  });

  document.getElementById("professionalsBody").addEventListener("click", async (e) => {
    const id = e.target.closest("[data-deactivate]") && e.target.closest("[data-deactivate]").getAttribute("data-deactivate");
    if (!id) return;
    const ok = await confirmDialog("¿Dar de baja a este profesional? Ya no se le asignarán citas nuevas.", "Dar de baja");
    if (!ok) return;
    try {
      const res = await fetch("/simulator/api/professionals/" + id + "/deactivate", { method: "POST" });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast("Profesional dado de baja");
      setTimeout(() => location.reload(), 500);
    } catch (err) { toast("Error: " + err.message, "error"); }
  });

  // Chips de servicio por profesional (sustituye al <select multiple>
  // nativo). Cada clic alterna visualmente al instante; el guardado se
  // debounce-ea un poco tras el último clic para que marcar varios
  // servicios seguidos dispare UNA sola petición (y un solo toast, ver
  // dedup en layout.ts) en vez de una por clic. El endpoint y el payload
  // ({serviceIds: string[]}) son EXACTAMENTE los mismos que antes.
  const proServiceSaveTimers = {};
  document.querySelectorAll(".service-chip-group").forEach((group) => {
    group.addEventListener("click", (e) => {
      const chip = e.target.closest(".service-toggle-chip");
      if (!chip || chip.disabled) return;
      const nowSelected = !chip.classList.contains("selected");
      chip.classList.toggle("selected", nowSelected);
      chip.setAttribute("aria-pressed", String(nowSelected));

      const proId = group.getAttribute("data-professional");
      clearTimeout(proServiceSaveTimers[proId]);
      proServiceSaveTimers[proId] = setTimeout(async () => {
        const ids = Array.from(group.querySelectorAll(".service-toggle-chip.selected")).map((c) => c.getAttribute("data-service-id"));
        try {
          const res = await fetch("/simulator/api/professionals/" + proId + "/services", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serviceIds: ids }),
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          toast("Servicios actualizados");
        } catch (err) {
          toast("Error: " + err.message, "error");
        }
      }, 450);
    });
  });

  // --- Servicios ---
  const serviceOverlay = document.getElementById("serviceModalOverlay");
  const serviceForm = document.getElementById("serviceForm");
  const serviceModalTitle = document.getElementById("serviceModalTitle");

  function openServiceModal(service) {
    serviceForm.reset();
    serviceForm.id.value = service ? service.id : "";
    serviceForm.name.value = service ? service.label : "";
    serviceForm.durationMinutes.value = service ? service.durationMinutes : "";
    serviceForm.priceEur.value = service && service.priceEur != null ? service.priceEur : "";
    serviceModalTitle.textContent = service ? "Editar servicio" : "Nuevo servicio";
    serviceOverlay.style.display = "flex";
  }
  document.getElementById("addServiceBtn").addEventListener("click", () => openServiceModal(null));
  document.getElementById("serviceModalCancel").addEventListener("click", () => { serviceOverlay.style.display = "none"; });
  serviceOverlay.addEventListener("click", (e) => { if (e.target === serviceOverlay) serviceOverlay.style.display = "none"; });

  document.getElementById("servicesBody").addEventListener("click", async (e) => {
    const editBtn = e.target.closest("[data-edit-service]");
    if (editBtn) { openServiceModal(JSON.parse(editBtn.getAttribute("data-edit-service"))); return; }
    const toggleBtn = e.target.closest("[data-toggle-service]");
    if (toggleBtn) {
      const toggleId = toggleBtn.getAttribute("data-toggle-service");
      const nextActive = toggleBtn.getAttribute("data-next-active") === "true";
      try {
        const res = await fetch("/simulator/api/services/" + toggleId + "/active", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: nextActive }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        toast(nextActive ? "Servicio activado" : "Servicio desactivado");
        setTimeout(() => location.reload(), 500);
      } catch (err) { toast("Error: " + err.message, "error"); }
    }
  });

  serviceForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = serviceForm.querySelector("button[type=submit]");
    btn.disabled = true;
    const id = serviceForm.id.value;
    const payload = {
      name: serviceForm.name.value,
      durationMinutes: Number(serviceForm.durationMinutes.value),
      priceEur: serviceForm.priceEur.value === "" ? null : Number(serviceForm.priceEur.value),
    };
    try {
      const res = await fetch(id ? "/simulator/api/services/" + id : "/simulator/api/services", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast("Servicio guardado");
      setTimeout(() => location.reload(), 500);
    } catch (err) { toast("Error: " + err.message, "error"); btn.disabled = false; }
  });

  // --- Horario ---
  // Validación en el cliente ANTES de guardar (mismas reglas que el
  // backend en services/serviceCatalog.ts -> replaceOpeningHoursForDay:
  // sin tramos incompletos, fin > inicio, sin solapes) — feedback visible
  // al instante en vez de esperar el viaje al servidor; el backend sigue
  // siendo quien de verdad valida y persiste.
  function readRanges(rowsEl) {
    return Array.from(rowsEl.querySelectorAll(".hour-row")).map((r) => ({
      start: r.querySelector(".hour-start").value,
      end: r.querySelector(".hour-end").value,
    }));
  }

  function validateDayRanges(ranges) {
    for (const r of ranges) {
      if (!r.start || !r.end) return "Hay un tramo sin completar.";
      if (r.end <= r.start) return "El tramo " + r.start + "–" + r.end + " termina antes (o igual) de empezar.";
    }
    const sorted = ranges.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < sorted[i - 1].end) {
        return "Los tramos " + sorted[i - 1].start + "–" + sorted[i - 1].end + " y " + sorted[i].start + "–" + sorted[i].end + " se solapan.";
      }
    }
    return null;
  }

  document.querySelectorAll(".day-block").forEach((block) => {
    const rowsEl = block.querySelector(".hour-rows");
    const errorEl = block.querySelector(".day-error");
    const closedTag = block.querySelector(".closed-tag");
    const unsavedBadge = block.querySelector(".unsaved-badge");
    const saveBtn = block.querySelector("[data-save-day]");
    let pristineKey = JSON.stringify(readRanges(rowsEl));

    function refresh() {
      const ranges = readRanges(rowsEl);
      closedTag.hidden = ranges.length !== 0;
      const error = validateDayRanges(ranges);
      block.classList.toggle("has-error", !!error);
      errorEl.hidden = !error;
      errorEl.textContent = error || "";
      saveBtn.disabled = !!error;
      const dirty = JSON.stringify(ranges) !== pristineKey;
      unsavedBadge.hidden = !dirty;
      // Solo el día que de verdad tiene cambios sin guardar "destaca" con
      // el botón primary — evita una fila de CTAs fuertes idénticos
      // (ver punto 32 de la auditoría visual).
      saveBtn.classList.toggle("btn-primary", dirty && !error);
      saveBtn.classList.toggle("btn-ghost", !(dirty && !error));
    }

    block.querySelector("[data-add-block]").addEventListener("click", () => {
      const row = document.createElement("div");
      row.className = "hour-row";
      row.innerHTML = '<input type="time" class="hour-start" value="09:00" /><span class="hour-sep" aria-hidden="true">–</span><input type="time" class="hour-end" value="14:00" /><button type="button" class="btn-icon-remove" data-remove-block aria-label="Eliminar este tramo">${icon("x", { size: 13 })}</button>';
      rowsEl.appendChild(row);
      refresh();
    });
    rowsEl.addEventListener("click", (e) => {
      if (e.target.closest("[data-remove-block]")) {
        e.target.closest(".hour-row").remove();
        refresh();
      }
    });
    rowsEl.addEventListener("input", refresh);

    block.querySelector("[data-save-day]").addEventListener("click", async () => {
      const ranges = readRanges(rowsEl);
      if (validateDayRanges(ranges)) { refresh(); return; } // el botón ya está deshabilitado en este caso; por si acaso
      try {
        const res = await fetch("/simulator/api/opening-hours/" + block.getAttribute("data-weekday"), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ranges }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        pristineKey = JSON.stringify(ranges);
        toast("Horario guardado");
        setTimeout(() => location.reload(), 500);
      } catch (err) { toast("Error: " + err.message, "error"); }
      refresh();
    });

    refresh();
  });
  `;

  return pageShell({
    title: `Ajustes · ${settings.name}`,
    brand: settings.brandColor,
    active: "settings",
    clinic,
    bodyHtml: body,
    extraStyles,
    bodyScript,
  });
}

function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
