"use client";

import { MapContainer, TileLayer, Marker, Polyline, FeatureGroup, useMapEvent } from "react-leaflet";
import { EditControl } from "react-leaflet-draw";
import L from "leaflet";
import type { LatLngExpression, LeafletMouseEvent } from "leaflet";
import * as turf from "@turf/turf";
import { useCallback, useMemo, useRef, useState } from "react";

import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";

// Fix default marker icon
const DefaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

type Hazard = GeoJSON.Polygon | GeoJSON.MultiPolygon;

function toGeoJSONPolygon(layer: any): Hazard | null {
  if (!layer) return null;
  const gj = layer.toGeoJSON();
  if (gj?.geometry?.type === "Polygon" || gj?.geometry?.type === "MultiPolygon") {
    return gj.geometry as Hazard;
  }
  // Circle -> polygon (approx)
  if (layer instanceof (L as any).Circle) {
    const center = layer.getLatLng();
    const radius = layer.getRadius(); // meters
    const circle = turf.circle([center.lng, center.lat], radius / 1000, { steps: 64, units: "kilometers" });
    return circle.geometry as Hazard;
  }
  return null;
}

function unionHazards(polys: Hazard[]): Hazard | null {
  if (polys.length === 0) return null;
  let acc: any = turf.feature(polys[0]);
  for (let i = 1; i < polys.length; i++) {
    acc = (turf as any).union(acc, turf.feature(polys[i]));
  }
  return (acc?.geometry ?? null) as Hazard | null;
}

// useMapEvent must live under MapContainer
function ClickHandler({
  placing,
  onSetStart,
  onSetEnd,
  onAddHazardPoint,
  clearPlacing,
  hazardBufferKm,
}: {
  placing: "start" | "end" | "hazard-point" | null;
  onSetStart: (latlng: LatLngExpression) => void;
  onSetEnd: (latlng: LatLngExpression) => void;
  onAddHazardPoint: (latlng: LatLngExpression) => void;
  clearPlacing: () => void;
  hazardBufferKm: number;
}) {
  useMapEvent("click", (e: LeafletMouseEvent) => {
    if (placing === "start") onSetStart([e.latlng.lat, e.latlng.lng]);
    else if (placing === "end") onSetEnd([e.latlng.lat, e.latlng.lng]);
    else if (placing === "hazard-point") onAddHazardPoint([e.latlng.lat, e.latlng.lng]);
    if (placing) clearPlacing();
  });
  return null;
}

export default function LeafletHazardMap() {
  // State
  const [start, setStart] = useState<LatLngExpression | null>([-6.2, 106.816]);
  const [end, setEnd] = useState<LatLngExpression | null>([-6.914744, 107.60981]);
  const [route, setRoute] = useState<LatLngExpression[] | null>(null);
  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [placing, setPlacing] = useState<"start" | "end" | "hazard-point" | null>(null);
  const [hazardBufferMeters, setHazardBufferMeters] = useState<number>(150); // for hazard point buffer

  const drawnItemsRef = useRef<L.FeatureGroup | null>(null);

  // Helpers
  const addBufferedHazardPoint = useCallback(
    (latlng: LatLngExpression) => {
      const [lat, lng] = latlng as [number, number];
      const radiusKm = Math.max(1, hazardBufferMeters) / 1000; // safety clamp
      const circle = turf.circle([lng, lat], radiusKm, { steps: 64, units: "kilometers" });
      setHazards((prev) => [...prev, circle.geometry as Hazard]);
    },
    [hazardBufferMeters]
  );

  const onCreated = useCallback((e: any) => {
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

  const avoidPolygons = useMemo<GeoJSON.MultiPolygon | null>(() => {
    if (!hazards.length) return null;
    const merged = unionHazards(hazards);
    if (!merged) return null;
    return merged.type === "Polygon"
      ? { type: "MultiPolygon", coordinates: [merged.coordinates as number[][][]] }
      : (merged as GeoJSON.MultiPolygon);
  }, [hazards]);

  const fetchRoute = useCallback(async () => {
    if (!start || !end) return;
    setRoute(null);

    const body = {
      coordinates: [
        [(start as number[])[1], (start as number[])[0]], // [lng,lat]
        [(end as number[])[1], (end as number[])[0]],
      ],
      elevation: false,
      instructions: true,
      options: {
        avoid_polygons: avoidPolygons || undefined,
        avoid_features: [] as string[], // hook this up to UI if needed
      },
    };

    const res = await fetch("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
      method: "POST",
      headers: {
        Authorization: process.env.NEXT_PUBLIC_ORS_KEY || "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(await res.text());
      alert("Routing failed (check API key/limits).");
      return;
    }
    const geo = await res.json();
    const coords = (geo.features?.[0]?.geometry?.coordinates ?? []) as [number, number][];
    const latlngs = coords.map(([lng, lat]) => [lat, lng]) as LatLngExpression[];
    setRoute(latlngs);
  }, [start, end, avoidPolygons]);

  // Simple active button styling
  const btn = "px-3 py-2 rounded text-sm font-medium";
  const solid = "bg-black text-white hover:opacity-90";
  const outline = "border border-gray-300 bg-white hover:bg-gray-50";
  const active = "ring-2 ring-emerald-500";

  return (
    <div className="w-full h-screen flex flex-col">
      {/* Sticky toolbar (always clickable) */}
      <div className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-3 py-2">
          <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                className={`${btn} ${outline} ${placing === "start" ? active : ""}`}
                onClick={() => setPlacing((p) => (p === "start" ? null : "start"))}
                title="Click on the map to set Start"
              >
                Set Start
              </button>
              <button
                className={`${btn} ${outline} ${placing === "end" ? active : ""}`}
                onClick={() => setPlacing((p) => (p === "end" ? null : "end"))}
                title="Click on the map to set End"
              >
                Set End
              </button>
              <button
                className={`${btn} ${outline} ${placing === "hazard-point" ? active : ""}`}
                onClick={() => setPlacing((p) => (p === "hazard-point" ? null : "hazard-point"))}
                title="Click on the map to drop a buffered hazard point"
              >
                Hazard Point
              </button>

              <button className={`${btn} ${solid}`} onClick={fetchRoute}>
                Route (avoid hazards)
              </button>

              <button
                className={`${btn} ${outline}`}
                onClick={() => {
                  setHazards([]);
                  drawnItemsRef.current?.clearLayers();
                }}
              >
                Clear Hazards
              </button>
            </div>

            {/* Divider */}
            <div className="hidden md:block h-6 w-px bg-gray-300" />

            {/* Buffer control & status */}
            <div className="flex items-center gap-3 flex-wrap">
              <label className="text-xs text-gray-600">
                Hazard buffer: <span className="font-semibold">{hazardBufferMeters} m</span>
              </label>
              <input
                type="range"
                min={50}
                max={1000}
                step={10}
                value={hazardBufferMeters}
                onChange={(e) => setHazardBufferMeters(parseInt(e.target.value, 10))}
                className="w-40"
              />
              <div className="text-xs text-gray-600">
                Start: <span className="font-semibold">{Array.isArray(start) ? `${start[0].toFixed(4)}, ${start[1].toFixed(4)}` : "-"}</span> ·{" "}
                End: <span className="font-semibold">{Array.isArray(end) ? `${end[0].toFixed(4)}, ${end[1].toFixed(4)}` : "-"}</span> ·{" "}
                Hazards: <span className="font-semibold">{hazards.length}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Map fills the rest; no overlaying toolbar */}
      <div className="flex-1">
        <MapContainer
          center={(start as LatLngExpression) || [0, 0]}
          zoom={9}
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

          <ClickHandler
            placing={placing}
            onSetStart={setStart}
            onSetEnd={setEnd}
            onAddHazardPoint={addBufferedHazardPoint}
            clearPlacing={() => setPlacing(null)}
            hazardBufferKm={hazardBufferMeters / 1000}
          />

          {start && <Marker position={start} />}
          {end && <Marker position={end} />}

          <Polyline positions={route || []} pathOptions={{ weight: 6 }} />

          <FeatureGroup
            ref={(fg) => {
              drawnItemsRef.current = fg ? (fg as unknown as L.FeatureGroup) : null;
            }}
          >
            <EditControl
              position="topright" // keep clear of toolbar
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

      {/* Mini legend */}
      <div className="absolute right-3 bottom-3 z-20 pointer-events-none">
        <div className="rounded-lg bg-white/90 shadow px-3 py-2 text-xs text-gray-700">
          <div className="font-semibold mb-1">Tips</div>
          <div>• Use <span className="font-medium">Hazard Point</span> for quick buffered avoids.</div>
          <div>• Draw polygons/circles for precise hazard areas.</div>
          <div>• Click <span className="font-medium">Route</span> to recompute path.</div>
        </div>
      </div>
    </div>
  );
}
