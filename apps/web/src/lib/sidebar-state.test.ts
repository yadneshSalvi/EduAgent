import { describe, expect, it } from 'vitest';
import {
  ensureOpenKey,
  readSidebarCollapsed,
  readSidebarTracksOpen,
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_TRACKS_OPEN_KEY,
  toggleOpenKey,
  writeSidebarCollapsed,
  writeSidebarTracksOpen,
} from './sidebar-state';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('merged sidebar disclosure state', () => {
  it('keeps nested track and day expansion keys independent', () => {
    let open = ensureOpenKey(new Set<string>(), 'track:sql-interview');
    open = toggleOpenKey(open, 'day:13');
    open = toggleOpenKey(open, 'day:12');
    open = toggleOpenKey(open, 'day:12');

    expect([...open]).toEqual(['track:sql-interview', 'day:13']);
  });

  it('round-trips the whole-sidebar collapse toggle preference', () => {
    const storage = new MemoryStorage();
    writeSidebarCollapsed(storage, true);

    expect(storage.values.get(SIDEBAR_COLLAPSED_KEY)).toBe('true');
    expect(readSidebarCollapsed(storage)).toBe(true);
  });

  it('round-trips expanded tracks under the specified localStorage key', () => {
    const storage = new MemoryStorage();
    writeSidebarTracksOpen(storage, new Set(['sql-interview', 'python-dsa']));

    expect(storage.values.has(SIDEBAR_TRACKS_OPEN_KEY)).toBe(true);
    expect([...readSidebarTracksOpen(storage)]).toEqual(['sql-interview', 'python-dsa']);
  });
});
