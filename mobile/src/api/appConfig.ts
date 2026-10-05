import type { Http } from './http';
import type { AppConfig } from './types';

/**
 * §15.3 `GET /d/v1/app/config?platform&version&build` — public; at launch and on resume. The server computes
 * `force` (version < minSupported) and `softUpdate` (version < latest). Unreachable server → null (never blocks).
 */
export const appConfigApi = (http: Http) => ({
  get: async (platform: string, version: string, build?: string | null): Promise<AppConfig | null> => {
    try {
      return await http.get<AppConfig>('/v1/app/config', {
        // Only ios / android are platforms (400 bad_platform otherwise): the web preview asks without one (no gate).
        query: { platform: platform === 'ios' || platform === 'android' ? platform : undefined, version, build: build && /^\d+$/.test(build) ? build : undefined },
        timeoutMs: 5000,
      });
    } catch {
      return null;
    }
  },
});

export type UpdateGate = 'ok' | 'soft' | 'force';

export function updateGate(cfg: AppConfig | null): UpdateGate {
  if (!cfg) return 'ok';
  if (cfg.force) return 'force';
  if (cfg.softUpdate) return 'soft';
  return 'ok';
}
