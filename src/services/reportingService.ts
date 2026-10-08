import { DateTime } from "luxon";
import { prisma } from "../db/client";
import { clinicConfig } from "../config";
export type ReportPeriod = "month" | "week" | "all";
export interface DashboardStats {
  totalAppointments: number; confirmed: number; pending: number; cancelled: number;
  noShow: number; completed: number; confirmationRate: number; recoveredSlots: number;
  recoveredRevenueEur: number; recoveredAttended: number; recoveredAttendedValueEur: number;
  recoveredPaidEur: number; pendingAttendance: number; period: ReportPeriod;
}
export async function getDashboardStats(period: ReportPeriod = "month"): Promise<DashboardStats> {
  const now = DateTime.now().setZone(clinicConfig.timezone);
  const from = period === "all" ? null : now.startOf(period === "week" ? "week" : "month");
  const to = from?.plus(period === "week" ? { weeks: 1 } : { months: 1 });
  const rows = await prisma.appointment.findMany({ where: { clinicId: "default", ...(from && to ? { startsAt: { gte: from.toJSDate(), lt: to.toJSDate() } } : {}) } });
  const count = (status: string) => rows.filter(a => a.status === status).length;
  const confirmed = count("CONFIRMED"), completed = count("COMPLETED"), arrived = count("ARRIVED"), pending = count("PENDING_CONFIRMATION");
  const recovered = rows.filter(a => a.recoveredFromWaitlist && !["CANCELLED", "NO_SHOW"].includes(a.status));
  const attended = recovered.filter(a => a.status === "COMPLETED");
  const sum = (values: typeof rows) => values.reduce((c, a) => c + Math.round((a.priceEurAtBooking || 0) * 100), 0) / 100;
  return { period, totalAppointments: rows.length, confirmed, pending, cancelled: count("CANCELLED"), noShow: count("NO_SHOW"), completed,
    confirmationRate: confirmed + completed + arrived + pending > 0 ? (confirmed + completed + arrived) / (confirmed + completed + arrived + pending) : 0,
    recoveredSlots: recovered.length, recoveredRevenueEur: sum(recovered), recoveredAttended: attended.length, recoveredAttendedValueEur: sum(attended), recoveredPaidEur: attended.reduce((c, a) => c + a.paidCents, 0) / 100,
    pendingAttendance: rows.filter(a => a.startsAt < new Date() && ["PENDING_CONFIRMATION", "CONFIRMED", "ARRIVED"].includes(a.status)).length,
  };
}
export async function listUpcomingAgenda(limit = 20) {
  return prisma.appointment.findMany({ where: { clinicId: "default", startsAt: { gte: new Date() }, status: { in: ["PENDING_CONFIRMATION", "CONFIRMED", "ARRIVED"] } }, include: { patient: true, professional: true }, orderBy: { startsAt: "asc" }, take: limit });
}
