import { useEffect, useState } from 'react';
import { fetchSettings, type AppSettings } from '../api/opsClient';

let cached: Promise<AppSettings | null> | null = null;

/** App settings (targets, caps, modes), fetched once per page load and shared; null until loaded or on error. */
export function useAppSettings(): AppSettings | null {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  useEffect(() => {
    cached ??= fetchSettings().catch(() => null);
    let alive = true;
    void cached.then((s) => alive && setSettings(s));
    return () => {
      alive = false;
    };
  }, []);
  return settings;
}

/** Drops the shared copy after the Admin page saves, so other pages pick up the new values. */
export function forgetAppSettings() {
  cached = null;
}
