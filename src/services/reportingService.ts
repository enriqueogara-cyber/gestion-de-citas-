import { prisma } from "../db/client";

/**
 * KPIs del dashboard. Todo el cálculo vive aquí (nunca en el frontend, ver
 * README "Estadísticas") para que dashboard, futuros informes y tests usen
 * siempre la misma definición de cada métrica.
 *
 * "Ingresos recuperados" (el KPI estrella, ver README "Métrica ingresos
 * recuperados"): suma de `priceEurAtBooking` de las citas con
 * `recoveredFromWaitlist = true`. Se usa el precio guardado EN EL MOMENTO
 * de la reserva (no el precio actual del servicio) para que la cifra no
 * cambie retroactivamente si se ajustan precios más adelante, y para que
 * se pueda auditar cita a cita de dónde sale el número.
 */
export interface DashboardStats {
  totalAppointments: number;
  confirmed: number;
  pending: number;
  cancelled: number;
  noShow: number;
  completed: number;
  confirmationRate: number; // 0..1, sobre confirmadas+completadas+pendientes
  recoveredSlots: number;
  recoveredRevenueEur: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [totalAppointments, confirmed, pending, cancelled, noShow, completed, recovered] = await Promise.all([
    prisma.appointment.count(),
    prisma.appointment.count({ where: { status: "CONFIRMED" } }),
    prisma.appointment.count({ where: { status: "PENDING_CONFIRMATION" } }),
    prisma.appointment.count({ where: { status: "CANCELLED" } }),
    prisma.appointment.count({ where: { status: "NO_SHOW" } }),
    prisma.appointment.count({ where: { status: "COMPLETED" } }),
    prisma.appointment.findMany({
      where: { recoveredFromWaitlist: true },
      select: { priceEurAtBooking: true },
    }),
  ]);

  const activeBase = confirmed + pending + completed;
  const confirmationRate = activeBase > 0 ? (confirmed + completed) / activeBase : 0;
  const recoveredRevenueEur = recovered.reduce((sum, a) => sum + (a.priceEurAtBooking ?? 0), 0);

  return {
    totalAppointments,
    confirmed,
    pending,
    cancelled,
    noShow,
    completed,
    confirmationRate,
    recoveredSlots: recovered.length,
    recoveredRevenueEur,
  };
}

export async function listUpcomingAgenda(limit = 20) {
  return prisma.appointment.findMany({
    where: { startsAt: { gte: new Date() }, status: { in: ["PENDING_CONFIRMATION", "CONFIRMED"] } },
    include: { patient: true, professional: true },
    orderBy: { startsAt: "asc" },
    take: limit,
  });
}
