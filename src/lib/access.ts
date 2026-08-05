/** Accepted access codes (case-insensitive). Vision / perception themed. */
export const ACCESS_CODES = [
  "FOVEA",
  "RETINA",
  "GAZE",
  "SALIENCY",
  "ATTENTION",
  "PERIPHERY",
  "MACULA",
  "FIXATION",
  "INSIGHT",
  "ACUITY",
] as const;

const STORAGE_KEY = "visuals-insight-access";

export function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidAccessCode(value: string): boolean {
  const code = normalizeCode(value);
  return ACCESS_CODES.some((accepted) => accepted === code);
}

export function hasUnlockedAccess(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function unlockAccess(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Ignore storage failures; unlock still works for this session in memory.
  }
}
