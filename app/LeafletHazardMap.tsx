"use client";

import * as turf from "@turf/turf";
import type { LatLngExpression, LeafletMouseEvent } from "leaflet";
import L from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FeatureGroup,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  useMapEvent,
} from "react-leaflet";
import { EditControl } from "react-leaflet-draw";

import "leaflet-draw/dist/leaflet.draw.css";
import "leaflet/dist/leaflet.css";

/* ---------- Marker icon fix ---------- */
const DefaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

/* ---------- Types ---------- */
type Hazard = GeoJSON.Polygon | GeoJSON.MultiPolygon;
type LngLat = [number, number];
type LatLngNum = [number, number];

/* ---------- ORS heuristic limits (tune if needed) ---------- */
const ORS_MAX_AVOID_AREA_KM2 = 200; // safe ceiling per polygon
const ORS_MAX_AVOID_BBOX_SIDE_KM = 20; // max width or height
const MAX_DRAWN_CIRCLE_RADIUS_M = 5000; // prevent huge circles at draw time
const OFF_ROUTE_THRESHOLD_M = 40; // off-route threshold
const MAX_ROUTE_KM_WITH_AVOID = 150; // guard for very long routes with avoids

/* ---------- Helpers ---------- */
function toGeoJSONPolygon(layer: any): Hazard | null {
  if (!layer) return null;
  const gj = layer.toGeoJSON?.();
  if (
    gj?.geometry?.type === "Polygon" ||
    gj?.geometry?.type === "MultiPolygon"
  ) {
    return gj.geometry as Hazard;
  }
  // Circle -> polygon (approx)
  if (layer instanceof (L as any).Circle) {
    const center = layer.getLatLng();
    const radius = layer.getRadius(); // meters
    const circle = turf.circle([center.lng, center.lat], radius / 1000, {
      steps: 64,
      units: "kilometers",
    });
    return circle.geometry as Hazard;
  }
  return null;
}

function unionHazards(polys: Hazard[]): Hazard | null {
  if (polys.length === 0) return null;
  if (polys.length === 1) return polys[0];
  // Try union; fallback to simple MultiPolygon concat
  try {
    let acc: any = turf.feature(polys[0]);
    for (let i = 1; i < polys.length; i++) {
      acc = (turf as any).union(acc, turf.feature(polys[i]));
    }
    if (acc?.geometry) return acc.geometry as Hazard;
  } catch {}
  const coordinates: number[][][][] = [];
  for (const g of polys) {
    if (g.type === "Polygon") {
      if ((g.coordinates?.[0]?.length ?? 0) >= 4)
        coordinates.push(g.coordinates as number[][][]);
    } else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates)
        if ((poly?.[0]?.length ?? 0) >= 4) coordinates.push(poly);
    }
  }
  if (!coordinates.length) return null;
  return { type: "MultiPolygon", coordinates } as GeoJSON.MultiPolygon;
}

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number) {
  let t: any;
  return (...args: Parameters<T>) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Simplify ORS route and sample as waypoints for Google handoff
function simplifyAndSampleWaypoints(
  routeLngLat: LngLat[],
  maxPoints = 8
): { lat: number; lng: number }[] {
  if (!routeLngLat.length) return [];
  const simplified = turf.simplify(turf.lineString(routeLngLat), {
    tolerance: 0.0009, // ~100m
    highQuality: false,
  }).geometry.coordinates as LngLat[];
  const pts =
    simplified.length <= maxPoints
      ? simplified
      : simplified.filter(
          (_, i) => i % Math.ceil(simplified.length / maxPoints) === 0
        );
  return pts.map(([lng, lat]) => ({ lat, lng }));
}

function openGMaps(
  origin: { lat: number; lng: number },
  dest: { lat: number; lng: number },
  via: { lat: number; lng: number }[]
) {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("travelmode", "driving");
  url.searchParams.set("origin", `${origin.lat},${origin.lng}`);
  url.searchParams.set("destination", `${dest.lat},${dest.lng}`);
  if (via.length)
    url.searchParams.set(
      "waypoints",
      via.map((v) => `${v.lat},${v.lng}`).join("|")
    );
  window.location.href = url.toString();
}

function polygonAreaKm2(poly: GeoJSON.Polygon) {
  return turf.area(poly) / 1_000_000;
}

function bboxSideKm(poly: GeoJSON.Polygon) {
  const [minX, minY, maxX, maxY] = turf.bbox(poly);
  const width = turf.distance([minX, maxY], [maxX, maxY], {
    units: "kilometers",
  });
  const height = turf.distance([minX, minY], [minX, maxY], {
    units: "kilometers",
  });
  return { width, height };
}

function approxStartEndKm(a: LatLngExpression, b: LatLngExpression) {
  const [alat, alng] = a as [number, number];
  const [blat, blng] = b as [number, number];
  return turf.distance([alng, alat], [blng, blat], { units: "kilometers" });
}

/* ---------- Click handler (inside MapContainer) ---------- */
function ClickHandler({
  placing,
  onSetStart,
  onSetEnd,
  onAddHazardPoint,
  clearPlacing,
}: {
  placing: "start" | "end" | "hazard-point" | null;
  onSetStart: (latlng: LatLngExpression) => void;
  onSetEnd: (latlng: LatLngExpression) => void;
  onAddHazardPoint: (latlng: LatLngExpression) => void;
  clearPlacing: () => void;
}) {
  useMapEvent("click", (e: LeafletMouseEvent) => {
    if (placing === "start") onSetStart([e.latlng.lat, e.latlng.lng]);
    else if (placing === "end") onSetEnd([e.latlng.lat, e.latlng.lng]);
    else if (placing === "hazard-point")
      onAddHazardPoint([e.latlng.lat, e.latlng.lng]);
    if (placing) clearPlacing();
  });
  return null;
}

/* ============================ MAIN COMPONENT ============================ */
export default function LeafletHazardMap() {
  // Route state
  const [start, setStart] = useState<LatLngExpression | null>([-6.2, 106.816]);
  const [end, setEnd] = useState<LatLngExpression | null>([
    -6.914744, 107.60981,
  ]);
  const [route, setRoute] = useState<LatLngExpression[] | null>(null);
  const [routeLngLat, setRouteLngLat] = useState<LngLat[] | null>(null);

  // Hazards
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [placing, setPlacing] = useState<
    "start" | "end" | "hazard-point" | null
  >(null);
  const [hazardBufferMeters, setHazardBufferMeters] = useState<number>(150);

  // Realtime nav
  const [gpsOn, setGpsOn] = useState(false);
  const [userPos, setUserPos] = useState<LatLngNum | null>(null);
  const [offRoute, setOffRoute] = useState(false);
  const [offRouteMeters, setOffRouteMeters] = useState<number>(0);
  const watchIdRef = useRef<number | null>(null);
  const wakeLockRef = useRef<any>(null);

  // Misc
  const drawnItemsRef = useRef<L.FeatureGroup | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  /* ---------- Hazards IO ---------- */
  const addBufferedHazardPoint = useCallback(
    (latlng: LatLngExpression) => {
      const [lat, lng] = latlng as [number, number];
      const circle = turf.circle(
        [lng, lat],
        Math.max(1, hazardBufferMeters) / 1000,
        { steps: 64, units: "kilometers" }
      );
      setHazards((prev) => [...prev, circle.geometry as Hazard]);
    },
    [hazardBufferMeters]
  );

  const onCreated = useCallback((e: any) => {
    // prevent very large circles (which ORS will reject)
    if (e.layer instanceof (L as any).Circle) {
      const r = e.layer.getRadius?.() ?? 0;
      if (r > MAX_DRAWN_CIRCLE_RADIUS_M) {
        alert(
          `Circle too large (>${
            MAX_DRAWN_CIRCLE_RADIUS_M / 1000
          } km radius). Please draw a smaller hazard.`
        );
        // @ts-ignore
        drawnItemsRef.current?.removeLayer?.(e.layer);
        return;
      }
    }
    const poly = toGeoJSONPolygon(e.layer);
    if (poly) setHazards((prev) => [...prev, poly]);
  }, []);

  const onEdited = useCallback(() => {
    const all: Hazard[] = [];
    drawnItemsRef.current?.eachLayer((layer: any) => {
      const p = toGeoJSONPolygon(layer);
      if (p) all.push(p);
    });
    setHazards(all);
  }, []);

  const onDeleted = useCallback(() => {
    const remaining: Hazard[] = [];
    drawnItemsRef.current?.eachLayer((layer: any) => {
      const p = toGeoJSONPolygon(layer);
      if (p) remaining.push(p);
    });
    setHazards(remaining);
  }, []);

  // Build avoid_polygons but filter out shapes that likely break ORS limits
  const avoidPolygons = useMemo<GeoJSON.MultiPolygon | null>(() => {
    if (!hazards.length) return null;

    const merged = unionHazards(hazards);
    if (!merged) return null;

    // Normalize to MultiPolygon
    const multi: GeoJSON.MultiPolygon =
      merged.type === "Polygon"
        ? {
            type: "MultiPolygon",
            coordinates: [merged.coordinates as number[][][]],
          }
        : (merged as GeoJSON.MultiPolygon);

    const validPolys: number[][][][] = [];
    const dropped: { area: number; width: number; height: number }[] = [];

    for (const polyCoords of multi.coordinates) {
      const poly = {
        type: "Polygon",
        coordinates: polyCoords,
      } as GeoJSON.Polygon;

      // Ensure outer ring is closed
      const outer = poly.coordinates[0];
      if (!outer || outer.length < 4) continue;
      const first = outer[0];
      const last = outer[outer.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        poly.coordinates[0] = [...outer, first];
      }

      const area = polygonAreaKm2(poly);
      const { width, height } = bboxSideKm(poly);

      if (
        area <= ORS_MAX_AVOID_AREA_KM2 &&
        width <= ORS_MAX_AVOID_BBOX_SIDE_KM &&
        height <= ORS_MAX_AVOID_BBOX_SIDE_KM
      ) {
        validPolys.push(poly.coordinates as number[][][]);
      } else {
        dropped.push({ area, width, height });
      }
    }

    if (dropped.length) {
      console.warn(
        "Some hazard polygons were too large for ORS and were skipped:",
        dropped
      );
      alert(
        `Some hazard areas are too large for routing and were skipped.\n\n` +
          dropped
            .map(
              (d, i) =>
                `#${i + 1}: area ≈ ${d.area.toFixed(
                  0
                )} km², bbox ≈ ${d.width.toFixed(1)}×${d.height.toFixed(1)} km`
            )
            .join("\n")
      );
    }

    if (!validPolys.length) return null;
    return { type: "MultiPolygon", coordinates: validPolys };
  }, [hazards]);

  /* ---------- ORS routing ---------- */
  const fetchRoute = useCallback(async () => {
    if (!start || !end) return;

    // Guard: very long routes with avoids often fail on free tiers
    if (avoidPolygons) {
      const dk = approxStartEndKm(
        start as [number, number],
        end as [number, number]
      );
      if (dk > MAX_ROUTE_KM_WITH_AVOID) {
        alert(
          `Route too long with hazards (≈ ${dk.toFixed(
            0
          )} km). Try a shorter leg or remove some hazards.`
        );
        return;
      }
    }

    setRoute(null);
    setRouteLngLat(null);

    const body = {
      coordinates: [
        [(start as number[])[1], (start as number[])[0]], // [lng,lat]
        [(end as number[])[1], (end as number[])[0]],
      ],
      elevation: false,
      instructions: true,
      options: {
        avoid_polygons: avoidPolygons || undefined,
        avoid_features: [] as string[],
      },
    };

    const res = await fetch(
      "https://api.openrouteservice.org/v2/directions/driving-car/geojson",
      {
        method: "POST",
        headers: {
          Authorization: process.env.NEXT_PUBLIC_ORS_KEY || "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      console.error(await res.text());
      alert(
        "Routing failed (bad request or limits). Try smaller hazards or shorter leg."
      );
      return;
    }

    const geo = await res.json();
    const coords = (geo.features?.[0]?.geometry?.coordinates ?? []) as LngLat[];
    setRouteLngLat(coords);
    const latlngs = coords.map(([lng, lat]) => [
      lat,
      lng,
    ]) as LatLngExpression[];
    setRoute(latlngs);
  }, [start, end, avoidPolygons]);

  /* ---------- Realtime GPS + off-route ---------- */
  const computeOffRoute = useCallback(
    (pos: LatLngNum) => {
      if (!routeLngLat || routeLngLat.length < 2) {
        setOffRoute(false);
        setOffRouteMeters(0);
        return;
      }
      const line = turf.lineString(routeLngLat);
      const pt = turf.point([pos[1], pos[0]]);
      const d = turf.pointToLineDistance(pt, line, { units: "meters" });
      setOffRouteMeters(d);
      setOffRoute(d > OFF_ROUTE_THRESHOLD_M);
    },
    [routeLngLat]
  );
  const debouncedComputeOffRoute = useMemo(
    () => debounce(computeOffRoute, 400),
    [computeOffRoute]
  );

  const startGPS = useCallback(async () => {
    if (watchIdRef.current != null) return;
    try {
      // @ts-ignore
      wakeLockRef.current = await navigator.wakeLock?.request?.("screen");
    } catch {}
    watchIdRef.current = navigator.geolocation.watchPosition(
      ({ coords }) => {
        const here: LatLngNum = [coords.latitude, coords.longitude];
        setUserPos(here);
        debouncedComputeOffRoute(here);
        if (mapRef.current)
          mapRef.current.setView(here, Math.max(mapRef.current.getZoom(), 14), {
            animate: true,
          });
      },
      (err) => {
        console.error(err);
        alert("GPS error. Pastikan izin lokasi aktif.");
        stopGPS();
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
    setGpsOn(true);
  }, [debouncedComputeOffRoute]);

  const stopGPS = useCallback(() => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    try {
      wakeLockRef.current?.release?.();
    } catch {}
    wakeLockRef.current = null;
    setGpsOn(false);
    setUserPos(null);
    setOffRoute(false);
    setOffRouteMeters(0);
  }, []);

  useEffect(() => {
    return () => {
      stopGPS();
    };
  }, [stopGPS]);

  /* ---------- Tailwind-only button presets ---------- */
  const btnBase =
    "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium " +
    "transition-colors duration-150 select-none outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
    "focus-visible:ring-sky-500 focus-visible:ring-offset-[color:var(--background)]";
  const btnSolid = `${btnBase} bg-sky-500 text-white hover:bg-sky-600 active:opacity-90`;
  const btnOutline =
    `${btnBase} bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 active:opacity-95 ` +
    "dark:bg-neutral-900 dark:text-neutral-200 dark:border-neutral-700 dark:hover:bg-neutral-800";
  const btnGhost =
    `${btnBase} bg-transparent text-gray-700 hover:bg-gray-100 active:opacity-95 ` +
    "dark:text-neutral-200 dark:hover:bg-neutral-800";
  const btnDanger = `${btnBase} bg-red-500 text-white hover:bg-red-600 active:opacity-90`;
  const activeRing = "ring-2 ring-sky-500";

  const canHandOff = !!(start && end && routeLngLat && routeLngLat.length >= 2);
  const handleHandOff = () => {
    if (!canHandOff) return;
    const origin = { lat: (start as number[])[0], lng: (start as number[])[1] };
    const dest = { lat: (end as number[])[0], lng: (end as number[])[1] };
    const via = simplifyAndSampleWaypoints(routeLngLat!, 8);
    const trimmed = via.slice(1, Math.max(1, via.length - 1)); // drop endpoints
    openGMaps(origin, dest, trimmed);
  };

  /* -------------------- UI -------------------- */
  return (
    <div className="w-full h-screen flex flex-col">
      {/* Toolbar */}
      <div className="sticky top-0 z-30 bg-white/90 dark:bg-neutral-900/90 backdrop-blur border-b border-gray-200 dark:border-neutral-800">
        <div className="max-w-7xl mx-auto px-3 py-2">
          <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                className={`${btnOutline} ${
                  placing === "start" ? activeRing : ""
                } px-3 py-2`}
                onClick={() =>
                  setPlacing((p) => (p === "start" ? null : "start"))
                }
                title="Click map to set Start"
              >
                Set Start
              </button>
              <button
                className={`${btnOutline} ${
                  placing === "end" ? activeRing : ""
                } px-3 py-2`}
                onClick={() => setPlacing((p) => (p === "end" ? null : "end"))}
                title="Click map to set End"
              >
                Set End
              </button>
              <button
                className={`${btnOutline} ${
                  placing === "hazard-point" ? activeRing : ""
                } px-3 py-2`}
                onClick={() =>
                  setPlacing((p) =>
                    p === "hazard-point" ? null : "hazard-point"
                  )
                }
                title="Click map to add a buffered hazard point"
              >
                Hazard Point
              </button>

              <button className={`${btnSolid} px-3 py-2`} onClick={fetchRoute}>
                Route (avoid hazards)
              </button>

              <button
                className={`${btnGhost} px-3 py-2`}
                onClick={() => {
                  setHazards([]);
                  drawnItemsRef.current?.clearLayers();
                }}
              >
                Clear Hazards
              </button>
            </div>

            {/* Divider */}
            <div className="hidden md:block h-6 w-px bg-gray-300 dark:bg-neutral-700" />

            {/* Nav controls */}
            <div className="flex items-center gap-2 flex-wrap">
              {!gpsOn ? (
                <button
                  className={`${btnSolid} px-3 py-2`}
                  onClick={startGPS}
                  title="Start live GPS & wake-lock"
                >
                  Start GPS
                </button>
              ) : (
                <button
                  className={`${btnDanger} px-3 py-2`}
                  onClick={stopGPS}
                  title="Stop live GPS"
                >
                  Stop GPS
                </button>
              )}

              <button
                className={`${btnOutline} px-3 py-2`}
                onClick={fetchRoute}
                title="Recompute with current hazards"
              >
                Re-route
              </button>

              <button
                className={`${btnOutline} px-3 py-2 ${
                  canHandOff ? "" : "opacity-60 cursor-not-allowed"
                }`}
                disabled={!canHandOff}
                onClick={handleHandOff}
              >
                Start in Google Maps
              </button>
            </div>

            {/* Divider */}
            <div className="hidden md:block h-6 w-px bg-gray-300 dark:bg-neutral-700" />

            {/* Buffer + status */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium bg-gray-100 text-gray-700 dark:bg-neutral-800 dark:text-neutral-200">
                Buffer{" "}
                <span className="mx-1 font-semibold">
                  {hazardBufferMeters} m
                </span>
              </div>
              <input
                type="range"
                min={50}
                max={1000}
                step={10}
                value={hazardBufferMeters}
                onChange={(e) =>
                  setHazardBufferMeters(parseInt(e.target.value, 10))
                }
                className="w-40 accent-sky-500"
              />

              <div className="text-xs text-gray-600 dark:text-neutral-300">
                Start:{" "}
                <span className="font-semibold">
                  {Array.isArray(start)
                    ? `${(start[0] as number).toFixed(4)}, ${(
                        start[1] as number
                      ).toFixed(4)}`
                    : "-"}
                </span>{" "}
                · End:{" "}
                <span className="font-semibold">
                  {Array.isArray(end)
                    ? `${(end[0] as number).toFixed(4)}, ${(
                        end[1] as number
                      ).toFixed(4)}`
                    : "-"}
                </span>{" "}
                · Hazards:{" "}
                <span className="font-semibold">{hazards.length}</span> ·
                Off-route:{" "}
                <span
                  className={`font-semibold ${
                    offRoute ? "text-red-600" : "text-green-600"
                  }`}
                >
                  {offRoute ? `${offRouteMeters.toFixed(0)} m` : "OK"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Map */}
      <div className="flex-1">
        <MapContainer
          ref={mapRef}
          center={(start as LatLngExpression) || [0, 0]}
          zoom={12}
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          <ClickHandler
            placing={placing}
            onSetStart={setStart}
            onSetEnd={setEnd}
            onAddHazardPoint={addBufferedHazardPoint}
            clearPlacing={() => setPlacing(null)}
          />

          {start && <Marker position={start} />}
          {end && <Marker position={end} />}
          {userPos && <Marker position={userPos} />}

          <Polyline positions={route || []} pathOptions={{ weight: 6 }} />

          <FeatureGroup
            ref={(fg) => {
              drawnItemsRef.current = fg
                ? (fg as unknown as L.FeatureGroup)
                : null;
            }}
          >
            <EditControl
              position="topright"
              onCreated={onCreated}
              onEdited={onEdited}
              onDeleted={onDeleted}
              draw={{
                marker: false,
                polyline: false,
                circlemarker: false,
                polygon: true,
                rectangle: true,
                circle: true,
              }}
            />
          </FeatureGroup>
        </MapContainer>
      </div>

      {/* Tips */}
      <div className="absolute right-3 bottom-3 z-20 pointer-events-none">
        <div className="rounded-lg bg-white/90 dark:bg-neutral-900/90 shadow px-3 py-2 text-xs text-gray-700 dark:text-neutral-200">
          <div className="font-semibold mb-1">Tips</div>
          <div>
            • Gunakan <span className="font-medium">Hazard Point</span> untuk
            avoid cepat.
          </div>
          <div>• Draw polygon/circle untuk area spesifik.</div>
          <div>
            • <span className="font-medium">Start GPS</span> untuk live position
            & off-route check.
          </div>
        </div>
      </div>
    </div>
  );
}
