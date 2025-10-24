import React, { useState, useRef } from 'react'
import { MapContainer, TileLayer, Polyline, Polygon, Circle, Marker, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Fix for default marker icons in Leaflet with webpack/vite
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

const ORS_API_KEY = import.meta.env.VITE_ORS_API_KEY || '5b3ce3597851110001cf6248a5e6e0c0f4604e7ebff16f1b63d0b8f2' // Free ORS API key for demo

function App() {
  const [waypoints, setWaypoints] = useState([])
  const [hazardPolygons, setHazardPolygons] = useState([])
  const [currentPolygon, setCurrentPolygon] = useState([])
  const [route, setRoute] = useState(null)
  const [routeInfo, setRouteInfo] = useState(null)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('none') // 'waypoint', 'hazard', 'none'
  const [waypointBufferRadius, setWaypointBufferRadius] = useState(500) // meters

  const handleCalculateRoute = async () => {
    if (waypoints.length < 2) {
      setError('Please add at least 2 waypoints')
      return
    }

    setError(null)
    setRoute(null)
    setRouteInfo(null)

    try {
      // Build avoid_polygons from hazard areas and waypoint buffers
      const avoidPolygons = []
      
      // Add drawn hazard polygons
      hazardPolygons.forEach(polygon => {
        avoidPolygons.push({
          type: 'Polygon',
          coordinates: [polygon.map(p => [p.lng, p.lat])]
        })
      })

      // Add buffered waypoints as circular polygons
      waypoints.forEach(wp => {
        if (wp.isHazard) {
          const circle = createCirclePolygon(wp.lat, wp.lng, waypointBufferRadius)
          avoidPolygons.push({
            type: 'Polygon',
            coordinates: [circle.map(p => [p[1], p[0]])]
          })
        }
      })

      // Get non-hazard waypoints for routing
      const routeWaypoints = waypoints.filter(wp => !wp.isHazard)
      
      if (routeWaypoints.length < 2) {
        setError('Please add at least 2 non-hazard waypoints for routing')
        return
      }

      // Build ORS API request
      const body = {
        coordinates: routeWaypoints.map(wp => [wp.lng, wp.lat]),
      }

      if (avoidPolygons.length > 0) {
        body.options = {
          avoid_polygons: {
            type: 'MultiPolygon',
            coordinates: avoidPolygons.map(p => p.coordinates)
          }
        }
      }

      const response = await fetch(
        `https://api.openrouteservice.org/v2/directions/driving-car/geojson`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': ORS_API_KEY
          },
          body: JSON.stringify(body)
        }
      )

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error?.message || 'Failed to calculate route')
      }

      const data = await response.json()
      
      if (data.features && data.features.length > 0) {
        const routeCoordinates = data.features[0].geometry.coordinates.map(coord => [coord[1], coord[0]])
        const properties = data.features[0].properties
        
        setRoute(routeCoordinates)
        setRouteInfo({
          distance: (properties.segments[0].distance / 1000).toFixed(2), // km
          duration: (properties.segments[0].duration / 60).toFixed(1) // minutes
        })
      }
    } catch (err) {
      setError(err.message)
      console.error('Routing error:', err)
    }
  }

  const handleClearAll = () => {
    setWaypoints([])
    setHazardPolygons([])
    setCurrentPolygon([])
    setRoute(null)
    setRouteInfo(null)
    setError(null)
  }

  return (
    <div className="app">
      <div className="controls">
        <button 
          onClick={() => setMode(mode === 'waypoint' ? 'none' : 'waypoint')}
          style={{ background: mode === 'waypoint' ? '#28a745' : '#007bff' }}
        >
          {mode === 'waypoint' ? '✓ Adding Waypoints' : 'Add Waypoints'}
        </button>
        
        <button 
          onClick={() => setMode(mode === 'hazard-point' ? 'none' : 'hazard-point')}
          style={{ background: mode === 'hazard-point' ? '#dc3545' : '#dc3545' }}
        >
          {mode === 'hazard-point' ? '✓ Adding Hazard Points' : 'Add Hazard Points'}
        </button>
        
        <button 
          onClick={() => {
            setMode(mode === 'hazard-polygon' ? 'none' : 'hazard-polygon')
            if (currentPolygon.length > 0) {
              setCurrentPolygon([])
            }
          }}
          style={{ background: mode === 'hazard-polygon' ? '#ffc107' : '#ffc107', color: '#000' }}
        >
          {mode === 'hazard-polygon' ? '✓ Drawing Hazard Area' : 'Draw Hazard Area'}
        </button>

        {mode === 'hazard-polygon' && currentPolygon.length > 0 && (
          <button 
            onClick={() => {
              if (currentPolygon.length >= 3) {
                setHazardPolygons([...hazardPolygons, [...currentPolygon]])
                setCurrentPolygon([])
                setMode('none')
              }
            }}
            style={{ background: '#28a745' }}
          >
            Finish Polygon ({currentPolygon.length} points)
          </button>
        )}

        <label>
          Buffer Radius:
          <input 
            type="number" 
            value={waypointBufferRadius} 
            onChange={(e) => setWaypointBufferRadius(Number(e.target.value))}
            min="100"
            max="5000"
            step="100"
            style={{ width: '100px', marginLeft: '5px' }}
          />
          m
        </label>

        <button onClick={handleCalculateRoute} disabled={waypoints.length < 2}>
          Calculate Route
        </button>

        <button onClick={handleClearAll} style={{ background: '#6c757d' }}>
          Clear All
        </button>
      </div>

      {error && (
        <div className="error-message">
          Error: {error}
        </div>
      )}

      <div className="map-container">
        <MapContainer 
          center={[51.505, -0.09]} 
          zoom={13} 
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          
          <MapClickHandler 
            mode={mode} 
            waypoints={waypoints}
            setWaypoints={setWaypoints}
            currentPolygon={currentPolygon}
            setCurrentPolygon={setCurrentPolygon}
          />

          {/* Render waypoints */}
          {waypoints.map((wp, idx) => (
            <React.Fragment key={idx}>
              <Marker position={[wp.lat, wp.lng]} />
              {wp.isHazard && (
                <Circle
                  center={[wp.lat, wp.lng]}
                  radius={waypointBufferRadius}
                  pathOptions={{ color: 'red', fillColor: 'red', fillOpacity: 0.3 }}
                />
              )}
            </React.Fragment>
          ))}

          {/* Render hazard polygons */}
          {hazardPolygons.map((polygon, idx) => (
            <Polygon
              key={idx}
              positions={polygon.map(p => [p.lat, p.lng])}
              pathOptions={{ color: 'orange', fillColor: 'orange', fillOpacity: 0.3 }}
            />
          ))}

          {/* Render current polygon being drawn */}
          {mode === 'hazard-polygon' && currentPolygon.length > 0 && (
            <Polygon
              positions={currentPolygon.map(p => [p.lat, p.lng])}
              pathOptions={{ color: 'yellow', fillColor: 'yellow', fillOpacity: 0.2, dashArray: '5, 5' }}
            />
          )}

          {/* Render route */}
          {route && (
            <Polyline 
              positions={route} 
              pathOptions={{ color: 'blue', weight: 4, opacity: 0.7 }}
            />
          )}
        </MapContainer>

        {routeInfo && (
          <div className="info-panel">
            <button className="close-btn" onClick={() => setRouteInfo(null)}>×</button>
            <h3>Route Information</h3>
            <p><strong>Distance:</strong> {routeInfo.distance} km</p>
            <p><strong>Duration:</strong> {routeInfo.duration} min</p>
          </div>
        )}
      </div>
    </div>
  )
}

function MapClickHandler({ mode, waypoints, setWaypoints, currentPolygon, setCurrentPolygon }) {
  useMapEvents({
    click: (e) => {
      const { lat, lng } = e.latlng
      
      if (mode === 'waypoint') {
        setWaypoints([...waypoints, { lat, lng, isHazard: false }])
      } else if (mode === 'hazard-point') {
        setWaypoints([...waypoints, { lat, lng, isHazard: true }])
      } else if (mode === 'hazard-polygon') {
        setCurrentPolygon([...currentPolygon, { lat, lng }])
      }
    }
  })
  
  return null
}

// Helper function to create a circle polygon
function createCirclePolygon(lat, lng, radiusMeters, numPoints = 32) {
  const points = []
  const earthRadius = 6371000 // meters
  
  for (let i = 0; i < numPoints; i++) {
    const angle = (i * 360 / numPoints) * Math.PI / 180
    
    const dx = radiusMeters * Math.cos(angle)
    const dy = radiusMeters * Math.sin(angle)
    
    const deltaLat = dy / earthRadius
    const deltaLng = dx / (earthRadius * Math.cos(lat * Math.PI / 180))
    
    const pointLat = lat + deltaLat * 180 / Math.PI
    const pointLng = lng + deltaLng * 180 / Math.PI
    
    points.push([pointLat, pointLng])
  }
  
  // Close the polygon
  points.push(points[0])
  
  return points
}

export default App
