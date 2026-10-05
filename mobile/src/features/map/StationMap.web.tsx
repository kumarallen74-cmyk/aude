import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Image, PanResponder, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';
import { latToY, lonToX, regionForZoom, xToLon, yToLat, zoomForRegion } from '@/lib/geo';
import { useTheme } from '@/theme';
import { ClusterPin, StationPin } from './Marker';
import type { StationMapHandle, StationMapProps } from './types';

/**
 * Web fallback (react-native-maps has no web support): a light raster-tile map with the same markers, drag to
 * pan. Used for the web build (screenshots, desktop preview). Tiles come from `/d/v1/meta.map.tileUrl`; when they
 * cannot load the schematic background still shows positions correctly.
 */
export const StationMap = forwardRef<StationMapHandle, StationMapProps>(function StationMap(p, ref) {
  const { c } = useTheme();
  const [size, setSize] = useState({ w: 390, h: 700 });
  const zoom = Math.round(zoomForRegion(p.region, size.w) * 2) / 2;
  const cx = lonToX(p.region.longitude, zoom);
  const cy = latToY(p.region.latitude, zoom);
  const drag = useRef({ x: 0, y: 0 });
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // The bottom sheet covers part of the map: the region centre sits in the middle of the visible part.
  const lift = (p.bottomInset ?? 0) / 2;

  useImperativeHandle(ref, () => ({ animateTo: (r) => p.onRegionChange(r) }), [p]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 6,
        onPanResponderGrant: () => (drag.current = { x: 0, y: 0 }),
        onPanResponderMove: (_, g) => setOffset({ x: g.dx, y: g.dy }),
        onPanResponderRelease: (_, g) => {
          setOffset({ x: 0, y: 0 });
          const lon = xToLon(cx - g.dx, zoom);
          const lat = yToLat(cy - g.dy, zoom);
          p.onRegionChange(regionForZoom(lat, lon, zoom, size.w, size.h));
        },
      }),
    [cx, cy, zoom, size, p],
  );

  const z = Math.floor(zoom);
  const scale = 2 ** (zoom - z);
  const tiles = useMemo(() => {
    if (!p.tileUrl) return [];
    const tx0 = Math.floor((lonToX(p.region.longitude, z) - size.w / 2 / scale) / 256);
    const ty0 = Math.floor((latToY(p.region.latitude, z) - size.h / 2 / scale) / 256);
    const nx = Math.ceil(size.w / scale / 256) + 2;
    const ny = Math.ceil(size.h / scale / 256) + 2;
    const out: { key: string; url: string; left: number; top: number }[] = [];
    for (let x = tx0; x < tx0 + nx; x++)
      for (let y = ty0; y < ty0 + ny; y++) {
        const url = p.tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace('{s}', 'a');
        out.push({ key: `${z}/${x}/${y}`, url, left: (x * 256 - lonToX(p.region.longitude, z)) * scale + size.w / 2, top: (y * 256 - latToY(p.region.latitude, z)) * scale + size.h / 2 - lift });
      }
    return out;
  }, [p.tileUrl, p.region.longitude, p.region.latitude, z, scale, size, lift]);

  const toScreen = (lat: number, lon: number) => ({ left: lonToX(lon, zoom) - cx + size.w / 2 + offset.x, top: latToY(lat, zoom) - cy + size.h / 2 - lift + offset.y });

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.mapLand, overflow: 'hidden' }]} onLayout={(e: LayoutChangeEvent) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })} {...pan.panHandlers} accessibilityLabel={p.mapLabel ?? 'Map'}>
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Defs>
          <Pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse" x={offset.x % 64} y={offset.y % 64}>
            <Line x1="0" y1="0" x2="64" y2="0" stroke={c.mapRoad} strokeWidth="2" />
            <Line x1="0" y1="0" x2="0" y2="64" stroke={c.mapRoad} strokeWidth="2" />
          </Pattern>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#grid)" opacity={0.7} />
      </Svg>
      {tiles.map((t) => (
        <Image key={t.key} source={{ uri: t.url }} style={{ position: 'absolute', left: t.left + offset.x, top: t.top + offset.y, width: 256 * scale, height: 256 * scale, opacity: c.scheme === 'dark' ? 0.55 : 1 }} />
      ))}
      {p.items.map((it) => {
        const pos = toScreen(it.lat, it.lon);
        if (it.type === 'cluster')
          return (
            <Pressable key={`c${it.id}`} onPress={() => p.onClusterPress(it.id, it.lat, it.lon)} style={{ position: 'absolute', left: pos.left - 23, top: pos.top - 23 }} accessibilityRole="button" accessibilityLabel={p.clusterLabel ? p.clusterLabel(it.count, it.available) : `${it.count}`}>
              <ClusterPin count={it.count} available={it.available} />
            </Pressable>
          );
        return (
          <Pressable key={it.station.key} onPress={() => p.onSelect(it.station.key)} style={{ position: 'absolute', left: pos.left - 28, top: pos.top - 32, zIndex: p.selectedKey === it.station.key ? 2 : 1 }} accessibilityRole="button" accessibilityLabel={p.stationLabel ? p.stationLabel(it.station) : it.station.name}>
            <StationPin s={it.station} selected={p.selectedKey === it.station.key} stale={p.stale} />
          </Pressable>
        );
      })}
      {/* The driver's position is drawn above the pins: a cluster or pin never hides it. */}
      {p.user ? (
        <View pointerEvents="none" style={[styles.user, { ...toScreen(p.user.lat, p.user.lon), borderColor: '#fff', backgroundColor: c.info, zIndex: 5 }]} accessibilityLabel={p.userLabel} />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  user: { position: 'absolute', width: 18, height: 18, borderRadius: 9, borderWidth: 3, marginLeft: -9, marginTop: -9, boxShadow: '0px 0px 0px 6px rgba(29,95,184,0.2)' },
});
