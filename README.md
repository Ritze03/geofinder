# Geofinder

Geobingo-style multiplayer party game with real Google and Apple Maps. One player hosts a room (2-8 players) and sets a list of categories and a round time (5-30 minutes). Everyone then explores an embedded Google or Apple Maps view to find a spot for each category and captures a screenshot of it. When the timer runs out, or everyone is done, the group goes through the captures category by category and rates each other's finds from 1 to 5 stars. Players connect peer to peer (via Trystero), and no API key is needed: the maps are the public Google and Apple Maps websites.

## Install

**Linux**: run `ritz-get install geofinder` (see [ritz-get](https://github.com/Ritze03/ritz-get)), then start `geofinder`. Without ritz-get, clone this repo and run `./install.sh --install`; `./install.sh --remove` uninstalls it again. Building needs `node` and `npm`.

## Development

```sh
npm install
npm run dev            # Vite + Electron
npm test               # unit tests (node --test)
npm run test:e2e       # Playwright
npm run test:electron  # build, then Electron tests
```

## Troubleshooting

On Ubuntu 24.04+ Electron can fail to start because AppArmor restricts unprivileged user namespaces; run `geofinder --no-sandbox`.
