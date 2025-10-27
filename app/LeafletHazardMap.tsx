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

type ORSGeocodeFeature = {
  geometry: { coordinates: [number, number] };
  properties?: { label?: string };
};

/* ---------- ORS heuristic limits ---------- */
const ORS_MAX_AVOID_AREA_KM2 = 200;
const ORS_MAX_AVOID_BBOX_SIDE_KM = 20;
const MAX_DRAWN_CIRCLE_RADIUS_M = 5000;
const OFF_ROUTE_THRESHOLD_M = 40;
const MAX_ROUTE_KM_WITH_AVOID = 150;

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

function simplifyAndSampleWaypoints(
  routeLngLat: LngLat[],
  maxPoints = 8
): { lat: number; lng: number }[] {
  if (!routeLngLat.length) return [];
  const simplified = turf.simplify(turf.lineString(routeLngLat), {
    tolerance: 0.0009,
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
  if (via.length) {
    url.searchParams.set(
      "waypoints",
      via.map((v) => `${v.lat},${v.lng}`).join("|")
    );
  }
  window.open(url.toString(), "_blank", "noopener,noreferrer");
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
  activeMode,
}: {
  placing: "start" | "end" | "hazard-point" | null;
  onSetStart: (latlng: LatLngExpression) => void;
  onSetEnd: (latlng: LatLngExpression) => void;
  onAddHazardPoint: (latlng: LatLngExpression) => void;
  clearPlacing: () => void;
  activeMode: "hazard" | "navigate";
}) {
  useMapEvent("click", (e: LeafletMouseEvent) => {
    if (activeMode === "navigate") {
      if (placing === "start") onSetStart([e.latlng.lat, e.latlng.lng]);
      else if (placing === "end") onSetEnd([e.latlng.lat, e.latlng.lng]);
    } else if (activeMode === "hazard") {
      if (placing === "hazard-point")
        onAddHazardPoint([e.latlng.lat, e.latlng.lng]);
    }
    if (placing) clearPlacing();
  });
  return null;
}

/* ---------- Small search box component ---------- */
function SearchBox({
  placeholder,
  value,
  onPick,
  onTyping,
}: {
  placeholder: string;
  value: string;
  onPick: (coord: LatLngNum, label: string) => void;
  onTyping?: (text: string) => void;
}) {
  const [q, setQ] = useState(value);
  const [results, setResults] = useState<ORSGeocodeFeature[] | null>(null);
  const [open, setOpen] = useState(false);

  const search = useMemo(
    () =>
      debounce(async (text: string) => {
        if (!text || text.length < 2) {
          setResults(null);
          return;
        }
        try {
          const res = await fetch(
            `https://api.openrouteservice.org/geocode/autocomplete?api_key=${encodeURIComponent(
              process.env.NEXT_PUBLIC_ORS_KEY || ""
            )}&text=${encodeURIComponent(text)}&size=6`
          );
          const data = await res.json();
          setResults((data?.features ?? []) as ORSGeocodeFeature[]);
          setOpen(true);
        } catch (e) {
          console.error(e);
          setResults(null);
          setOpen(false);
        }
      }, 300),
    []
  );

  useEffect(() => {
    setQ(value);
  }, [value]);

  return (
    <div className="relative w-full max-w-md">
      <input
        value={q}
        onChange={(e) => {
          const t = e.target.value;
          setQ(t);
          onTyping?.(t);
          search(t);
        }}
        onFocus={() => results?.length && setOpen(true)}
        placeholder={placeholder}
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white dark:bg-neutral-900 dark:border-neutral-700"
      />
      {open && results && results.length > 0 && (
        <div className="absolute z-[11000] mt-1 w-full rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow">
          {results.map((f, i) => {
            const lbl =
              f.properties?.label ??
              `${f.geometry.coordinates[1].toFixed(
                5
              )}, ${f.geometry.coordinates[0].toFixed(5)}`;
            return (
              <button
                key={i}
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-neutral-800"
                onClick={() => {
                  const [lng, lat] = f.geometry.coordinates;
                  onPick([lat, lng], lbl);
                  setOpen(false);
                }}
              >
                {lbl}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================ MAIN COMPONENT ============================ */
export default function LeafletHazardMap() {
  const [mode, setMode] = useState<"hazard" | "navigate">("hazard");

  // Route state
  const [start, setStart] = useState<LatLngExpression | null>([-6.2, 106.816]);
  const [end, setEnd] = useState<LatLngExpression | null>([
    -6.914744, 107.60981,
  ]);
  const [route, setRoute] = useState<LatLngExpression[] | null>(null);
  const [routeLngLat, setRouteLngLat] = useState<LngLat[] | null>(null);
  const [instructions, setInstructions] = useState<
    { text: string; distance: number }[]
  >([]);

  // Navigate search fields
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");

  // Hazards
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [placing, setPlacing] = useState<
    "start" | "end" | "hazard-point" | null
  >(null);
  const [hazardBufferMeters, setHazardBufferMeters] = useState<number>(150);

  // Realtime nav (real GPS)
  const [navigating, setNavigating] = useState(false);
  const [userPos, setUserPos] = useState<LatLngNum | null>(null);
  const [offRoute, setOffRoute] = useState(false);
  const [offRouteMeters, setOffRouteMeters] = useState<number>(0);
  const watchIdRef = useRef<number | null>(null);
  const wakeLockRef = useRef<any>(null);

  // Realtime nav (simulation)
  const [simulateOn, setSimulateOn] = useState(false);
  const [simSpeedKmh, setSimSpeedKmh] = useState(40);
  const simTimerRef = useRef<number | null>(null);
  const simDistKmRef = useRef(0);

  // Misc
  const drawnItemsRef = useRef<L.FeatureGroup | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  /* ---------- Hazards IO ---------- */
  const addBufferedHazardPoint = useCallback(
    (latlng: LatLngExpression) => {
      const [lat, lng] = latlng as [number, number];

      // Visible circle layer persists across modes
      const layer = L.circle([lat, lng], {
        radius: Math.max(1, hazardBufferMeters),
        color: "#ef4444",
        weight: 2,
        fillColor: "#ef4444",
        fillOpacity: 0.2,
      });
      drawnItemsRef.current?.addLayer(layer);

      // Add to hazards state for ORS avoidance
      const circle = turf.circle(
        [lng, lat],
        Math.max(1, hazardBufferMeters) / 1000,
        {
          steps: 64,
          units: "kilometers",
        }
      );
      setHazards((prev) => [...prev, circle.geometry as Hazard]);
    },
    [hazardBufferMeters]
  );

  const onCreated = useCallback((e: any) => {
    if (e.layer instanceof (L as any).Circle) {
      const r = e.layer.getRadius?.() ?? 0;
      if (r > MAX_DRAWN_CIRCLE_RADIUS_M) {
        alert(
          `Circle too large (> ${
            MAX_DRAWN_CIRCLE_RADIUS_M / 1000
          } km). Draw a smaller hazard.`
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

  // Build avoid_polygons and filter out shapes too large for ORS
  const avoidPolygons = useMemo<GeoJSON.MultiPolygon | null>(() => {
    if (!hazards.length) return null;

    const merged = unionHazards(hazards);
    if (!merged) return null;

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
      console.warn("Skipped large hazards:", dropped);
      alert(
        `Some hazards are too large and were skipped:\n` +
          dropped
            .map(
              (d, i) =>
                `#${i + 1} area≈${d.area.toFixed(0)}km² bbox≈${d.width.toFixed(
                  1
                )}×${d.height.toFixed(1)}km`
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

    if (avoidPolygons) {
      const dk = approxStartEndKm(
        start as [number, number],
        end as [number, number]
      );
      if (dk > MAX_ROUTE_KM_WITH_AVOID) {
        alert(
          `Route too long with hazards (≈ ${dk.toFixed(
            0
          )} km). Try a shorter leg or fewer hazards.`
        );
        return;
      }
    }

    setRoute(null);
    setRouteLngLat(null);
    setInstructions([]);

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
        "Routing failed (bad request or limits). Try smaller hazards / shorter leg."
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

    // Basic instructions list (segment 0)
    const steps =
      geo.features?.[0]?.properties?.segments?.[0]?.steps ??
      geo.features?.[0]?.properties?.segments?.[0]?.steps ??
      [];
    const list = steps.map((s: any) => ({
      text: s.instruction as string,
      distance: s.distance as number,
    }));
    setInstructions(list);
  }, [start, end, avoidPolygons]);

  /* ---------- Off-route compute (shared) ---------- */
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

  /* ---------- Realtime Navigation (REAL GPS) ---------- */
  const startNavigation = useCallback(async () => {
    if (!routeLngLat || routeLngLat.length < 2) {
      alert("Get directions first.");
      return;
    }
    if (simulateOn) {
      alert("Stop simulation first.");
      return;
    }
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
        alert("GPS error. Please enable location permission.");
        stopNavigation();
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
    setNavigating(true);
  }, [routeLngLat, debouncedComputeOffRoute, simulateOn]);

  const stopNavigation = useCallback(() => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    try {
      wakeLockRef.current?.release?.();
    } catch {}
    wakeLockRef.current = null;
    setNavigating(false);
    setUserPos(null);
    setOffRoute(false);
    setOffRouteMeters(0);
  }, []);

  /* ---------- Realtime Navigation (SIMULATION) ---------- */
  const stepSimulation = useCallback(() => {
    if (!routeLngLat || routeLngLat.length < 2) return;
    const line = turf.lineString(routeLngLat);
    const totalKm = turf.length(line, { units: "kilometers" });

    // advance distance: tick = 500ms
    const dtSeconds = 0.5;
    const dvKm = (simSpeedKmh / 3600) * dtSeconds;
    simDistKmRef.current += dvKm;

    // stop when finished
    if (simDistKmRef.current >= totalKm) {
      simDistKmRef.current = totalKm;
      if (simTimerRef.current) {
        clearInterval(simTimerRef.current);
        simTimerRef.current = null;
      }
      setSimulateOn(false);
    }

    // compute position and feed into same flow as real GPS
    const pt = turf.along(line, simDistKmRef.current, { units: "kilometers" });
    const [lng, lat] = pt.geometry.coordinates as [number, number];
    const here: [number, number] = [lat, lng];
    setUserPos(here);
    computeOffRoute(here);
    if (mapRef.current) {
      mapRef.current.setView(here, Math.max(mapRef.current.getZoom(), 14), {
        animate: true,
      });
    }
  }, [routeLngLat, simSpeedKmh, computeOffRoute]);

  const startSimulation = useCallback(() => {
    if (!routeLngLat || routeLngLat.length < 2) {
      alert("Get directions first, then start simulation.");
      return;
    }
    if (navigating) {
      alert("Stop real navigation first.");
      return;
    }
    simDistKmRef.current = 0;
    setSimulateOn(true);
    if (simTimerRef.current) clearInterval(simTimerRef.current);
    simTimerRef.current = window.setInterval(
      stepSimulation,
      500
    ) as unknown as number;
  }, [routeLngLat, navigating, stepSimulation]);

  const stopSimulation = useCallback(() => {
    if (simTimerRef.current) {
      clearInterval(simTimerRef.current);
      simTimerRef.current = null;
    }
    setSimulateOn(false);
  }, []);

  useEffect(() => {
    return () => {
      stopNavigation();
      stopSimulation();
    };
  }, [stopNavigation, stopSimulation]);

  /* ---------- Buttons (Tailwind-only) ---------- */
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
    const trimmed = via.slice(1, Math.max(1, via.length - 1));
    openGMaps(origin, dest, trimmed);
  };

  /* -------------------- UI -------------------- */
  return (
    <div className="w-full h-screen flex flex-col relative">
      {/* Topbar */}
      <div className="sticky top-0 z-[1000] bg-white/90 dark:bg-neutral-900/90 backdrop-blur border-b border-gray-200 dark:border-neutral-800">
        <div className="max-w-7xl mx-auto px-3 py-2 flex flex-col gap-2">
          {/* Mode Switcher */}
          <div className="flex items-center gap-2">
            <button
              className={`${btnOutline} ${
                mode === "hazard" ? activeRing : ""
              } px-3 py-2`}
              onClick={() => {
                setMode("hazard");
                setPlacing(null);
              }}
            >
              Hazard Mode
            </button>
            <button
              className={`${btnOutline} ${
                mode === "navigate" ? activeRing : ""
              } px-3 py-2`}
              onClick={() => {
                setMode("navigate");
                setPlacing(null);
              }}
            >
              Navigate Mode
            </button>
          </div>

          {/* HAZARD MODE CONTROLS */}
          {mode === "hazard" && (
            <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  className={`${btnOutline} ${
                    placing === "hazard-point" ? activeRing : ""
                  } px-3 py-2`}
                  onClick={() =>
                    setPlacing((p) =>
                      p === "hazard-point" ? null : "hazard-point"
                    )
                  }
                >
                  Hazard Point
                </button>

                <span className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium bg-gray-100 text-gray-700 dark:bg-neutral-800 dark:text-neutral-200">
                  Buffer{" "}
                  <span className="mx-1 font-semibold">
                    {hazardBufferMeters} m
                  </span>
                </span>
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
              <div className="text-xs text-gray-600 dark:text-neutral-300">
                Hazards: <span className="font-semibold">{hazards.length}</span>
              </div>
            </div>
          )}

          {/* NAVIGATE MODE CONTROLS */}
          {mode === "navigate" && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col md:flex-row gap-2">
                <SearchBox
                  placeholder="From (search or use “My location”)"
                  value={fromText}
                  onTyping={setFromText}
                  onPick={(coord, label) => {
                    setFromText(label);
                    setStart(coord);
                    mapRef.current?.setView(coord, 14);
                  }}
                />
                <SearchBox
                  placeholder="To (search a destination)"
                  value={toText}
                  onTyping={setToText}
                  onPick={(coord, label) => {
                    setToText(label);
                    setEnd(coord);
                    mapRef.current?.setView(coord, 14);
                  }}
                />
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  className={`${btnOutline} px-3 py-2`}
                  onClick={() =>
                    setPlacing((p) => (p === "start" ? null : "start"))
                  }
                  title="Click map to set Start"
                >
                  Set Start on Map
                </button>
                <button
                  className={`${btnOutline} px-3 py-2`}
                  onClick={() =>
                    setPlacing((p) => (p === "end" ? null : "end"))
                  }
                  title="Click map to set End"
                >
                  Set End on Map
                </button>

                <button
                  className={`${btnOutline} px-3 py-2`}
                  onClick={() => {
                    navigator.geolocation.getCurrentPosition(
                      (pos) => {
                        const here: LatLngNum = [
                          pos.coords.latitude,
                          pos.coords.longitude,
                        ];
                        setStart(here);
                        setFromText("My location");
                        mapRef.current?.setView(here, 14);
                      },
                      () => alert("Location blocked. Please allow access.")
                    );
                  }}
                >
                  Use My Location (From)
                </button>

                <button
                  className={`${btnSolid} px-3 py-2`}
                  onClick={fetchRoute}
                >
                  Get Directions
                </button>

                {!navigating ? (
                  <button
                    className={`${btnSolid} px-3 py-2`}
                    onClick={startNavigation}
                  >
                    Start Navigation
                  </button>
                ) : (
                  <button
                    className={`${btnDanger} px-3 py-2`}
                    onClick={stopNavigation}
                  >
                    Stop Navigation
                  </button>
                )}

                <button
                  className={`${btnOutline} px-3 py-2 ${
                    canHandOff ? "" : "opacity-60 cursor-not-allowed"
                  }`}
                  disabled={!canHandOff}
                  onClick={handleHandOff}
                  title="Open in Google Maps (with via points)"
                >
                  Open in Google Maps
                </button>

                {/* Simulation controls */}
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-600 dark:text-neutral-300">
                    Sim speed:
                  </label>
                  <select
                    className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:bg-neutral-900 dark:border-neutral-700"
                    value={simSpeedKmh}
                    onChange={(e) =>
                      setSimSpeedKmh(parseInt(e.target.value, 10))
                    }
                  >
                    <option value={20}>20 km/h</option>
                    <option value={40}>40 km/h</option>
                    <option value={60}>60 km/h</option>
                    <option value={80}>80 km/h</option>
                  </select>

                  {!simulateOn ? (
                    <button
                      className={`${btnOutline} px-3 py-2`}
                      onClick={startSimulation}
                    >
                      Simulate GPS
                    </button>
                  ) : (
                    <button
                      className={`${btnDanger} px-3 py-2`}
                      onClick={stopSimulation}
                    >
                      Stop Simulation
                    </button>
                  )}
                </div>

                <div className="text-xs text-gray-600 dark:text-neutral-300">
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
          )}
        </div>
      </div>

      {/* Map */}
      <div className="flex-1">
        <MapContainer
          ref={mapRef as any}
          center={(start as LatLngExpression) || [-6.2, 106.816]}
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
            activeMode={mode}
          />

          {start && <Marker position={start} />}
          {end && <Marker position={end} />}
          {userPos && <Marker position={userPos} />}

          <Polyline positions={route || []} pathOptions={{ weight: 6 }} />

          {/* Draw layers ALWAYS mounted so hazards remain visible across modes */}
          <FeatureGroup
            ref={(fg) => {
              drawnItemsRef.current = fg
                ? (fg as unknown as L.FeatureGroup)
                : null;
            }}
          >
            {mode === "hazard" && (
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
            )}
          </FeatureGroup>
        </MapContainer>
      </div>

      {/* MINI NAV PANEL (Navigate mode) */}
      {mode === "navigate" && route && (
        <div className="absolute left-3 bottom-3 z-[10000] pointer-events-auto">
          <div className="rounded-lg bg-white/90 dark:bg-neutral-900/90 shadow px-3 py-2 text-xs text-gray-700 dark:text-neutral-200 max-w-sm">
            <div className="font-semibold mb-1">Navigation</div>
            {instructions.length ? (
              <div className="space-y-1 max-h-40 overflow-auto pr-1">
                {instructions.slice(0, 4).map((s, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="mt-0.5 inline-block w-1.5 h-1.5 rounded-full bg-sky-500" />
                    <span>
                      {s.text}{" "}
                      <span className="text-gray-500">
                        ({Math.round(s.distance)} m)
                      </span>
                    </span>
                  </div>
                ))}
                {instructions.length > 4 && (
                  <div className="text-gray-500">
                    … {instructions.length - 4} more steps
                  </div>
                )}
              </div>
            ) : (
              <div>Get directions to see steps.</div>
            )}
            <div className="mt-2">
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
      )}

      {/* Tips card */}
      <div className="absolute right-3 bottom-3 z-[10000] pointer-events-none">
        <div className="rounded-lg bg-white/90 dark:bg-neutral-900/90 shadow px-3 py-2 text-xs text-gray-700 dark:text-neutral-200">
          <div className="font-semibold mb-1">Tips</div>
          {mode === "hazard" ? (
            <>
              <div>• Use Hazard Point + Buffer for quick avoid.</div>
              <div>• Draw polygon/rectangle/circle for specific areas.</div>
            </>
          ) : (
            <>
              <div>• Search “From/To” then Get Directions.</div>
              <div>
                • Start Navigation or Simulate GPS to test realtime updates.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
