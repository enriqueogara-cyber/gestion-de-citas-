import fs from "fs";
import { env } from "../config";
import { logger } from "../lib/logger";
import * as googleCalendar from "./googleCalendar";
import * as mockCalendar from "./mockCalendar";

const hasGoogleCredentials = fs.existsSync(env.googleServiceAccountPath);

if (!hasGoogleCredentials) {
  logger.warn("calendar_using_mock", {
    reason: `No se encontró "${env.googleServiceAccountPath}"`,
    hint: 'Sigue la sección "Google Calendar" del README para conectar el calendario real.',
  });
}

const impl = hasGoogleCredentials ? googleCalendar : mockCalendar;

export const findAvailableSlots = impl.findAvailableSlots;
export const isSlotFree = impl.isSlotFree;
export const createCalendarEvent = impl.createCalendarEvent;
export const deleteCalendarEvent = impl.deleteCalendarEvent;
export const isUsingRealGoogleCalendar = hasGoogleCredentials;
