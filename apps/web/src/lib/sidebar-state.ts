/** Persisted keys for the merged application sidebar (plans/09_tracks/07). */
export const SIDEBAR_COLLAPSED_KEY = 'eduagent:sidebar-collapsed';
export const SIDEBAR_TRACKS_OPEN_KEY = 'eduagent:sidebar-tracks-open';

interface SidebarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Read defensively: storage may be unavailable or contain an older value. */
export function readSidebarCollapsed(storage: SidebarStorage): boolean {
  try {
    return storage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(storage: SidebarStorage, collapsed: boolean): void {
  try {
    storage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    // Private browsing and locked-down webviews can reject localStorage writes.
  }
}

/** Track expansion is stored as a compact JSON array of slugs. */
export function readSidebarTracksOpen(storage: SidebarStorage): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(SIDEBAR_TRACKS_OPEN_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
}

export function writeSidebarTracksOpen(storage: SidebarStorage, openTracks: Set<string>): void {
  try {
    storage.setItem(SIDEBAR_TRACKS_OPEN_KEY, JSON.stringify([...openTracks]));
  } catch {
    // Persistence is an enhancement; navigation remains usable without it.
  }
}

/** Immutable helpers shared by the track and day disclosure levels. */
export function toggleOpenKey(current: Set<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function ensureOpenKey(current: Set<string>, key: string | null): Set<string> {
  if (key === null || current.has(key)) return current;
  const next = new Set(current);
  next.add(key);
  return next;
}
