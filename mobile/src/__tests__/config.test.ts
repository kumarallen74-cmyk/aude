/** The API base a release can talk to: an OTA update must never ship the demo backend or a LAN / http host. */
import { resolveApiBase } from '@/config';

const brandApi = 'https://api.plugsure.asia';

describe('resolveApiBase', () => {
  it('development / preview: the override, then the build extra, then the brand (mock and http allowed)', () => {
    expect(resolveApiBase({ envApi: 'mock', extraApi: 'https://staging.plugsure.asia', brandApi, dev: true })).toBe('mock');
    expect(resolveApiBase({ envApi: 'http://192.168.1.10:9200/', brandApi, dev: true })).toBe('http://192.168.1.10:9200');
    expect(resolveApiBase({ extraApi: 'http://10.0.0.2:9200', brandApi, dev: false, channel: 'preview', appEnv: 'preview' })).toBe('http://10.0.0.2:9200');
    expect(resolveApiBase({ brandApi, dev: false, channel: null, appEnv: 'development' })).toBe(brandApi);
  });

  it('a release on a production channel ignores mock, http and the EXPO_PUBLIC override', () => {
    expect(resolveApiBase({ envApi: 'mock', extraApi: 'mock', brandApi, dev: false, channel: 'production' })).toBe(brandApi);
    expect(resolveApiBase({ envApi: 'https://evil.example', extraApi: 'http://192.168.1.10:9200', brandApi, dev: false, channel: 'production-nusantara' })).toBe(brandApi);
    expect(resolveApiBase({ extraApi: 'https://api.nusantara.example/', brandApi, dev: false, channel: 'production' })).toBe('https://api.nusantara.example');
  });

  it('a release built as production is guarded even without an update channel', () => {
    expect(resolveApiBase({ envApi: 'mock', extraApi: 'mock', brandApi, dev: false, channel: null, appEnv: 'production' })).toBe(brandApi);
  });

  it('a dev build is never forced (it has no channel; __DEV__ wins)', () => {
    expect(resolveApiBase({ envApi: 'mock', brandApi, dev: true, channel: 'production', appEnv: 'production' })).toBe('mock');
  });
});
