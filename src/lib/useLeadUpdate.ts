import { useCallback, useState } from 'react';
import { LeadUpdateError, patchLead, type LeadPatch } from '../api/opsClient';
import type { SchoolLeadRow } from '../api/sheetsClient';

/**
 * Shows a lead change at once, writes it to the sheet, and rolls it back if the sheet refuses it
 * (for example when someone else claimed the lead first).
 */
export function useLeadUpdate(onChange: (lead: SchoolLeadRow) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const update = useCallback(
    async (lead: SchoolLeadRow, patch: LeadPatch, optimistic: Partial<SchoolLeadRow> = {}, action = 'save') => {
      const leadId = lead.Lead_id;
      if (!leadId) {
        setError('This row has no Lead_id yet, so it cannot be edited here.');
        return false;
      }
      setBusy(`${leadId}:${action}`);
      setError(null);
      if (Object.keys(optimistic).length) onChange({ ...lead, ...optimistic });
      try {
        const saved = await patchLead(leadId, patch);
        if (saved) onChange({ ...lead, ...optimistic, ...saved });
        return true;
      } catch (e) {
        onChange(lead);
        setError(
          e instanceof LeadUpdateError && e.code === 'owner_conflict' && e.owner
            ? `Already claimed by ${e.owner}.`
            : e instanceof Error
              ? e.message
              : 'Could not update the lead.'
        );
        return false;
      } finally {
        setBusy(null);
      }
    },
    [onChange]
  );

  return { update, busy, error, setError };
}
