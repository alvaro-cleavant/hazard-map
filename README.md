# Hazard-Aware Routing MVP

A demo application for hazard-aware routing using Leaflet, React-Leaflet, and OpenRouteService Directions API.

## Features

- **Interactive Map**: Leaflet-based map with OpenStreetMap tiles
- **Waypoint Management**: Click to add route waypoints on the map
- **Hazard Points**: Add hazard waypoints that are automatically buffered into circular avoidance zones
- **Hazard Areas**: Draw custom polygon hazard areas directly on the map
- **Smart Routing**: Uses OpenRouteService API with `avoid_polygons` to route around hazards
- **Route Information**: Displays distance and duration for calculated routes

## Installation

```bash
npm install
```

## Usage

### Development Mode
```bash
npm run dev
```

### Production Build
```bash
npm run build
npm run preview
```

## How to Use

1. **Add Waypoints**: Click "Add Waypoints" button and click on the map to add route waypoints (green markers)
2. **Add Hazard Points**: Click "Add Hazard Points" and click on the map to add hazard waypoints with circular buffer zones (red circles)
3. **Draw Hazard Areas**: Click "Draw Hazard Area" and click multiple points on the map to draw a polygon, then click "Finish Polygon"
4. **Adjust Buffer Radius**: Change the buffer radius for hazard points (default: 500m)
5. **Calculate Route**: Click "Calculate Route" to generate a route that avoids all hazard areas
6. **View Results**: The route will be displayed in blue, with distance and duration information

## Technology Stack

- **React 18**: UI framework
- **Vite**: Build tool
- **Leaflet**: Interactive mapping library
- **React-Leaflet**: React components for Leaflet
- **OpenRouteService API**: Routing with polygon avoidance support

## API Key

The application uses a demo OpenRouteService API key. For production use, please register for your own API key at [OpenRouteService](https://openrouteservice.org/).

## License

MIT
