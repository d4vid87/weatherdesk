// Synthetic forecast + station report for CI. The Desk paints nothing without one, and a
// screenshot of an empty page proves nothing. Fixed values, moving timestamps: the sun has to be
// up for the day layouts, and every chart wants times near now.
const now = Math.floor(Date.now() / 1000);
const day = Math.floor(now / 86400) * 86400;

const daily = Array.from({ length: 10 }, (_, i) => ({
  day_start_local: day + i * 86400,
  air_temp_high: 78 - i,
  air_temp_low: 58 - i,
  conditions: 'Partly Cloudy',
  icon: i % 3 === 0 ? 'partly-cloudy-day' : i % 3 === 1 ? 'rainy' : 'clear-day',
  precip_probability: (i * 10) % 70,
  sunrise: day + i * 86400 + 6 * 3600 + 40 * 60,
  sunset: day + i * 86400 + 19 * 3600 + 50 * 60,
}));

const hourly = Array.from({ length: 72 }, (_, i) => ({
  time: now - 3600 + i * 3600,
  air_temperature: 70 + 8 * Math.sin(i / 4),
  feels_like: 70 + 8 * Math.sin(i / 4),
  relative_humidity: 55 + (i % 20),
  precip_probability: (i * 7) % 90,
  precip: (i % 9 === 0) ? 0.02 : 0,
  wind_avg: 6 + (i % 5),
  wind_gust: 12 + (i % 9),
  wind_direction: (i * 17) % 360,
  sea_level_pressure: 1013 + Math.sin(i / 6),
  uv: Math.max(0, 6 - Math.abs(12 - (i % 24))),
  conditions: 'Partly Cloudy',
  icon: 'partly-cloudy-day',
}));

const fc = {
  latitude: 32.75, longitude: -97.33, timezone: 'America/Chicago', elevation: 180,
  current_conditions: {
    time: now, conditions: 'Partly Cloudy', icon: 'partly-cloudy-day',
    air_temperature: 72.4, feels_like: 74.1, dew_point: 61.2, relative_humidity: 68,
    sea_level_pressure: 1014.2, station_pressure: 993.1, pressure_trend: 'steady',
    wind_avg: 7.2, wind_gust: 14.6, wind_direction: 190, uv: 4, brightness: 42000,
    solar_radiation: 520, precip_accum_local_day: 0.12, visibility: 16093,
    air_density: 1.18, lightning_strike_count_last_3hr: 0,
  },
  forecast: { daily, hourly },
};

addEventListener('load', () => {
  dispatchEvent(new CustomEvent('wd:forecast', { detail: fc }));
  // api.OBS order: time, temp, rh, press, ... — index by name off the module the page already
  // loaded rather than hard-coding a shape that moves.
  import('./js/api.js').then(({ OBS }) => {
    const o = [];
    o[OBS.time] = now; o[OBS.temp] = 22.4; o[OBS.rh] = 68; o[OBS.press] = 993.1;
    o[OBS.windAvg] = 3.2; o[OBS.windGust] = 6.5; o[OBS.windDir] = 190;
    o[OBS.uv] = 4; o[OBS.solar] = 520; o[OBS.dayRain] = 3; o[OBS.battery] = 2.71;
    dispatchEvent(new CustomEvent('wd:ws-obs', { detail: o }));
  });
});
