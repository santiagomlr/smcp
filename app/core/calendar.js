// The Tasks window shows the day's events next to the tasks. The scripts live in src/eventkit.js.
import { createEventKit, EVENTS } from "../../src/eventkit.js";

export const eventKit = createEventKit();

export const calendarStatus = () => eventKit.status(EVENTS);
export const requestCalendar = () => eventKit.request(EVENTS);

/** Never asks for access: the window has its own button for that. */
export const calendarEvents = ({ from, to }) => eventKit.events({ from, to, passive: true });
