"use client";

import dynamic from "next/dynamic";

const LeafletHazardMap = dynamic(() => import("../LeafletHazardMap"), {
  ssr: false,
});

export default function HazardMapClient() {
  return <LeafletHazardMap />;
}
