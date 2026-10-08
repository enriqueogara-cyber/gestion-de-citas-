import { asyncRouter } from "../lib/asyncRouter";
import { getClinicSettings } from "../services/clinicSettings";
import { getServicesSync } from "../services/serviceCatalog";
import { listActiveProfessionals, parseServiceIds } from "../services/professionals";
import { renderPatientPage } from "./page";

export const patientRouter = asyncRouter();
patientRouter.get("/", async (_req, res) => {
  const [clinic, professionals] = await Promise.all([getClinicSettings(), listActiveProfessionals()]);
  res.type("html").send(renderPatientPage(clinic, getServicesSync(), professionals.map(p => ({ id: p.id, name: p.name, serviceIds: parseServiceIds(p.serviceIds) }))));
});
