# MQC-Aegis

**MQC-Aegis** is a live AI decision engine for operational risk events.

It ingests raw events, normalizes them, scores risk, detects trend and correlation patterns, decides actions, stores results, and streams everything live to a dashboard.

## What it does

MQC-Aegis processes incoming events such as:

- login attempts
- payment events
- suspicious velocity spikes
- geo mismatches
- repeated attempts
- high-risk multi-signal patterns

For each event, MQC-Aegis can:

- normalize the payload
- calculate a risk score
- detect trend anomalies
- detect multi-signal correlation
- decide an action
- store incidents and actions in SQLite
- update the live dashboard over WebSocket

## Core capabilities

- Live incident engine
- Decision engine with action output
- Trend and correlation detection
- SQLite persistence
- Filterable API endpoints
- Summary endpoint
- Live WebSocket dashboard
- API key protection for write access

## Live deployment

Public dashboard:

`https://mqc-aegis-production.up.railway.app`

## API overview

### Public read endpoints

- `GET /health`
- `GET /api/incidents`
- `GET /api/actions`
- `GET /api/summary`

### Protected write endpoint

- `POST /event`

`POST /event` requires an API key in the request header:

`x-api-key: YOUR_SIGNALDESK_API_KEY`

---

## Example event flow

Raw event input:

```json
{
  "type": "payment",
  "user": "anna",
  "amount": 25000,
  "risk": 65,
  "attempts": 4,
  "ip": "unknown",
  "geoMismatch": true,
  "velocitySpike": true
}
