# MQC-Aegis

MQC-Aegis is a real-time decision engine for live risk monitoring, incident creation, action logging, correlation analysis, and executive-ready operational visibility.

## What it does

MQC-Aegis turns fragmented signals into:
- correlated incidents
- operator actions
- live dashboard decisions
- executive summary posture

The platform evaluates live event payloads through:
- trend detection
- multi-signal correlation
- dynamic risk scoring
- action decision logic

## Core capabilities

- Real-time event processing
- Incident and action generation
- Trend and correlation labels
- Executive summary layer
- Demo mode scenarios
- Live WebSocket dashboard
- SQLite-backed local demo persistence
- Railway-ready deployment

## Dashboard modules

- Executive View
- Scenario Launcher
- Stream Filters
- Clear Demo Data
- Engine Status
- Decision Posture
- Incident Stream
- Action Feed

## Local run

Run:

    npm install
    npm start

Open:
http://localhost:3000

## API endpoints

- GET /health
- POST /event
- GET /api/incidents
- GET /api/actions
- GET /api/summary
- POST /api/admin/clear-demo

## Stack

- Node.js
- Express
- WebSocket (ws)
- SQLite
- Vanilla frontend dashboard
- Railway deployment
