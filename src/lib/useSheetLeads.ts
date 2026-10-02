import { useCallback, useEffect, useState } from 'react';
import { fetchSheetLeads, type SchoolLeadRow } from '../api/sheetsClient';

/** Loads every lead from the sheet (optionally on a timer); pages filter them in memory. */
export function useSheetLeads({ refreshMs, enabled = true }: { refreshMs?: number; enabled?: boolean } = {}) {
  const [leads, setLeads] = useState<SchoolLeadRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSheetLeads({ limit: 2000 });
      setLeads(result.rows);
      setFetchedAt(result.fetchedAt);
    } catch (e) {
      // Keep the last good list on screen; only the error banner changes.
      setError(e instanceof Error ? e.message : 'Failed to load leads');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    if (!refreshMs) return;
    const id = setInterval(() => void reload(), refreshMs);
    return () => clearInterval(id);
  }, [enabled, reload, refreshMs]);

  /** Swaps in an edited lead (optimistic updates from the lead drawer and queue buttons). */
  const replaceLead = useCallback((next: SchoolLeadRow) => {
    if (!next.Lead_id) return;
    setLeads((prev) => prev.map((row) => (row.Lead_id === next.Lead_id ? next : row)));
  }, []);

  return { leads, loading, error, fetchedAt, reload, replaceLead };
}
