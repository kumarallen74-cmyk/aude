import { useEffect, useReducer, useState } from 'react';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { ApiError } from '@/api/http';
import { brand } from '@/config';
import { formatKwh } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { initialSession, pollInterval, reduceSession, TERMINAL, type SessionKind } from '@/lib/sessionMachine';
import { showLiveSession } from '@/native/liveSession';
import { setActiveCharge } from '@/state/activeCharge';
import { colors } from '@/theme/tokens';

/**
 * Drives the session state machine: polls status at the interval the machine asks for (foreground only — in the
 * background push / Live Activity take over), ticks for start timeouts, sends Stop, and mirrors the snapshot to the
 * lock screen (Live Activity / ongoing notification).
 */
export function useLiveSession(kind: SessionKind, id: string) {
  const { t, i18n } = useTranslation();
  const [st, dispatch] = useReducer(reduceSession, undefined, () => initialSession(kind, id, Date.now()));
  const [foreground, setForeground] = useState(AppState.currentState === 'active' || AppState.currentState == null);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setForeground(s === 'active'));
    return () => sub.remove();
  }, []);

  const poll = async () => {
    try {
      const status = kind === 'roaming' ? await api.roaming.status(id) : await api.charge.status(id);
      dispatch({ type: 'snapshot', status, at: Date.now() });
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'not_found') {
        dispatch({ type: 'poll_failed', at: Date.now() });
        return;
      }
      dispatch({ type: 'poll_failed', at: Date.now() });
    }
  };

  // Poll loop: the interval follows the phase; a returning app polls at once.
  const interval = pollInterval(st, foreground);
  useEffect(() => {
    if (st.lastUpdate == null || foreground) void poll();
    if (interval == null) return;
    const h = setInterval(() => void poll(), interval);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, foreground, kind, id]);

  useEffect(() => {
    const h = setInterval(() => dispatch({ type: 'tick', at: Date.now() }), 1000);
    return () => clearInterval(h);
  }, []);

  // Lock-screen mirror + the floating pill.
  useEffect(() => {
    const s = st.snapshot;
    if (!s) return;
    const terminal = TERMINAL.has(st.phase);
    if (st.phase === 'charging' || st.phase === 'starting' || st.phase === 'finishing') {
      setActiveCharge({ kind, id, siteName: s.siteName, startedAt: s.startedAt ? new Date(s.startedAt).getTime() : Date.now() });
    } else if (terminal) {
      setActiveCharge(null);
    }
    if (st.phase === 'charging' || terminal) {
      const lang = i18n.language;
      const cost = s.costMinor != null ? formatMoney(s.costMinor, s.currency, lang) : '';
      void showLiveSession(
        id,
        kind,
        s,
        {
          title: terminal ? t('session.notif.finished', { site: s.siteName }) : t('session.notif.charging', { site: s.siteName }),
          body: [formatKwh(s.energyKwh, lang), s.powerKw != null ? `${Math.round(s.powerKw)} kW` : null, cost].filter(Boolean).join(' · '),
          appName: brand.appName,
          accentHex: colors.dark.fill,
        },
        terminal,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.phase, st.lastUpdate]);

  const stop = async () => {
    dispatch({ type: 'stop_requested', at: Date.now() });
    try {
      const r = kind === 'roaming' ? await api.roaming.stop(id) : await api.charge.stop(id);
      if (r.ok === false) throw new ApiError('business', r.error ?? '', 400);
      dispatch({ type: 'stop_sent', at: Date.now() });
      setTimeout(() => void poll(), 1200);
    } catch (e) {
      dispatch({ type: 'stop_failed', message: e instanceof ApiError && e.message ? e.message : t('session.stopFailed'), at: Date.now() });
    }
  };

  return { st, stop, refresh: poll };
}
