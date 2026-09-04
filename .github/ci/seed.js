// Runs before any module: settings are read once at module eval, so this is the only place a CI
// run can look like a configured install rather than a first-run wizard.
localStorage.setItem('wd.settings', JSON.stringify({
  units: 'imperial', stationName: 'CI Station', theme: 'dark', accent: '#4fb8ff',
  stationSource: 'ecowitt', lat: 32.75, lon: -97.33, deskRadar: false, nightDim: false, kioskCycleSec: 0, eco: 'off',
}));
