# alpr-sync-usa

Nightly job that fetches ALPR camera nodes from OpenStreetMap (via Overpass) **per state** and publishes JSON files you can load in your app.

## Files
- `states.json` — list of all states (lower 48 + AK, HI + DC).
- `fetch-alprs.js` — generates `public/index.json` and `public/usa/<State>.json` files.
- `.github/workflows/fetch.yml` — GitHub Actions workflow that runs nightly and publishes to `gh-pages`.
- `public/` — output folder served by GitHub Pages.

## Local test
```bash
npm i
npm run fetch
npm start
# open http://localhost:8080/index.json
# open http://localhost:8080/usa/Arizona.json
```

## License & attribution
Data © OpenStreetMap contributors, ODbL 1.0.

Generated on 2025-09-10T01:50:11.361778Z
