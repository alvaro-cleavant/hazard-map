"use client";

import dynamic from "next/dynamic";

// Only load LeafletHazardMap in the browser
const HazardMap = dynamic(() => import("../LeafletHazardMap"), { ssr: false });

export default function HazardMapClient() {
  return <HazardMap />;
}
