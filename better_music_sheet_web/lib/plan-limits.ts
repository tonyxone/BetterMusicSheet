// How many sheets each plan may upload a day, as the plans pages show it.
// The server enforces these (server.py's DAILY_SHEET_LIMITS) - change both
// together. Every sheet started counts, however it ends.
export const DAILY_SHEETS = { free: 5, monthly: 20, yearly: 30 } as const;
