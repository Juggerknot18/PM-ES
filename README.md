# PM-ES

Public website for PM-ES, an independent R&D project based in France exploring permanent-magnet electrical machines, power electronics, embedded supervision and regenerative energy management.

This repository is the dedicated public website surface for PM-ES. It is not a firmware repository, hardware release, private engineering archive or product brochure.

## Public website

- Website: https://juggerknot18.github.io/PM-ES/
- Telemetry preview: https://juggerknot18.github.io/PM-ES/telemetry/
- Project contact: research.pmes@gmail.com

The telemetry page is a sanitized monitoring-only visualization built from simulated illustrative data. It does not publish the private Raspberry Pi dashboard application, backend, protocol implementation, hardware mappings, control paths or measured performance.

## Local Preview

Serve the repository root with any static server:

```sh
python -m http.server 8000
```

Open `http://localhost:8000/`.

## Publication Model

The site is designed for manual GitHub Pages publication from `main` and `/(root)` after human review and merge. Canonical URL:

`https://juggerknot18.github.io/PM-ES/`

Deployment remains a manual human-controlled action. No workflow is installed in this release.

## Public Boundary

Only public, approved project facts are included. No personal identity, private repository links, firmware source, hardware pin maps, exact protection thresholds, credentials or measured performance claims are published.
