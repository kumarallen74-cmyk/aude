import { Platform } from 'react-native';

/** Which map the native StationMap module picks: Google Maps needs a key on Android, the tile map does not. */
function load(os: 'android' | 'ios', androidMapsKey: boolean) {
  let mod: typeof import('../StationMap') | undefined;
  let tiles: typeof import('../TileStationMap') | undefined;
  jest.isolateModules(() => {
    jest.replaceProperty(Platform, 'OS', os);
    jest.doMock('@/config', () => ({ ...jest.requireActual('@/config'), androidMapsKey }));
    // The native map module is not in the Jest environment; only which component is chosen matters here.
    jest.doMock('react-native-maps', () => ({ __esModule: true, default: () => null, Marker: () => null, PROVIDER_DEFAULT: undefined }));
    mod = require('../StationMap');
    tiles = require('../TileStationMap');
  });
  return { mod: mod!, tiles: tiles! };
}

describe('station map provider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('@/config');
    jest.dontMock('react-native-maps');
  });

  it('Android without a Maps key uses the key-free tile map (with zoom buttons)', () => {
    const { mod, tiles } = load('android', false);
    expect(mod.usesTileMap).toBe(true);
    expect(mod.StationMap).toBe(tiles.TileStationMap);
  });

  it('Android with a Maps key uses Google Maps', () => {
    const { mod, tiles } = load('android', true);
    expect(mod.usesTileMap).toBe(false);
    expect(mod.StationMap).not.toBe(tiles.TileStationMap);
  });

  it('iOS uses Apple Maps whatever the Android key', () => {
    const { mod, tiles } = load('ios', false);
    expect(mod.usesTileMap).toBe(false);
    expect(mod.StationMap).not.toBe(tiles.TileStationMap);
  });
});
