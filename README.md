# Meldkamerspel script

Tampermonkey userscript for [meldkamerspel.com](https://www.meldkamerspel.com) (fire department only):

- Home Assistant lamp feedback (mission completed / missing vehicles)
- Dispatch assistant: pre-selects vehicles, water and pump capacity, dispatch-further
- Mission memory: learned minimum per mission type, best matching AAO
- Returns surplus vehicles to station automatically
- VRU (Veiligheidsregio Utrecht) naming, development plan, redistribution and personnel panels

## Install

Open the raw file and Tampermonkey offers to install it; updates are picked up automatically:
https://raw.githubusercontent.com/223Games/meldkamerspel-script/main/meldkamerspel.user.js

Home Assistant URL and webhook ID are stored in Tampermonkey (menu: "Home Assistant instellen"), not in this repository.

## Development

The installable file `meldkamerspel.user.js` is generated: edit the parts in `src/` (numbered in load order), then

```sh
npm install   # once, for the test
npm test      # builds meldkamerspel.user.js and boots it in jsdom
```

Bump `@version` in `src/00-header.js` for every release, otherwise Tampermonkey won't pick up the update.

Settings (Tampermonkey menu): Home Assistant URL/webhook and on/off switches for the dispatch assistant, dispatch-further, returning surplus vehicles, HA events and debug logging.
