'use strict';

const { makeCache } = require('./cache');

const cache = makeCache();

const POINTS_TTL = 24 * 60 * 60 * 1000; // grid metadata basically never changes
const SUB_TTL = 15 * 60 * 1000; // forecast / hourly / obs sub-requests

async function nwsFetch(url, ua) {
  const res = await fetch(url, {
    headers: { 'User-Agent': ua, Accept: 'application/geo+json' },
  });
  if (!res.ok) throw new Error(`NWS ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// SEMO Weather Network -- a blend of community PWS stations in Cape Girardeau
// County. Current conditions only; it has no sky state and no forecast, so the
// icon/description are borrowed from the NWS hourly feed by the caller.
// Usage note asks for no more than one request per minute; our cache TTLs are
// well above that.
async function semoFetch(url, ua) {
  const res = await fetch(url, {
    headers: { 'User-Agent': ua, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`SEMO ${res.status} ${res.statusText} for ${url}`);
  const json = await res.json();
  if (!json || json.ok !== true || !json.current) {
    throw new Error('SEMO payload missing "current"');
  }
  const c = json.current;
  const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const round = (v) => (num(v) == null ? null : Math.round(num(v)));
  return {
    temp: round(c.temperature_f),
    feelsLike: round(c.feels_like_f),
    humidity: round(c.humidity_pct),
    windMph: round(c.wind_speed_mph),
    windGustMph: round(c.wind_gust_mph),
    windDir: c.wind_direction || null,
    dewPoint: round(c.dew_point_f),
    pressureInHg: num(c.pressure_inhg),
    rainTodayIn: num(c.rain_today_in_average),
    raining: num(c.rain_rate_in_per_hr_max) > 0,
    description: '', // filled from NWS hourly by getWeather
    icon: '·', //       filled from NWS hourly by getWeather
    observedAt: c.observed_at || json.generated_at || null,
    stationsReporting: num(c.stations_reporting),
    source: (json.usage && json.usage.attribution) || 'SEMO Weather Network',
  };
}

const cToF = (c) => (c * 9) / 5 + 32;

function windToMph(value, unitCode) {
  if (value == null) return null;
  if (/km_h/.test(unitCode || '')) return value * 0.621371;
  if (/m_s/.test(unitCode || '')) return value * 2.236936;
  return value; // assume already mph
}

function pickIcon(text, isDay) {
  const t = (text || '').toLowerCase();
  if (t.includes('thunder')) return '⛈️'; // ⛈️
  if (/(snow|flurr|sleet|ice|wintry|blizzard)/.test(t)) return '❄️'; // ❄️
  if (/(rain|shower|drizzle)/.test(t)) return '🌧️'; // 🌧️
  if (/(fog|haze|mist)/.test(t)) return '🌫️'; // 🌫️
  if (/(cloud|overcast)/.test(t)) {
    if (/(partly|mostly sunny|mostly clear|few)/.test(t)) return isDay ? '⛅' : '☁️';
    return '☁️'; // ☁️
  }
  if (/(sunny|clear|fair)/.test(t)) return isDay ? '☀️' : '🌙'; // ☀️ / 🌙
  if (t.includes('wind')) return '🌬️'; // 🌬️
  return isDay ? '☀️' : '🌙';
}

function normalizeObs(p) {
  if (!p) return null;
  const tempC = p.temperature && p.temperature.value;
  const feelsC =
    (p.windChill && p.windChill.value) ??
    (p.heatIndex && p.heatIndex.value) ??
    null;
  return {
    temp: tempC == null ? null : Math.round(cToF(tempC)),
    feelsLike: feelsC == null ? null : Math.round(cToF(feelsC)),
    humidity:
      p.relativeHumidity && p.relativeHumidity.value != null
        ? Math.round(p.relativeHumidity.value)
        : null,
    windMph:
      p.windSpeed && p.windSpeed.value != null
        ? Math.round(windToMph(p.windSpeed.value, p.windSpeed.unitCode))
        : null,
    description: p.textDescription || '',
    icon: pickIcon(p.textDescription, true),
    observedAt: p.timestamp || null,
  };
}

function normalizeHourly(json, count) {
  const periods = (json.properties && json.properties.periods) || [];
  return periods.slice(0, count).map((h) => ({
    time: h.startTime,
    temp: h.temperature,
    isDay: h.isDaytime,
    shortForecast: h.shortForecast,
    icon: pickIcon(h.shortForecast, h.isDaytime),
    precip:
      h.probabilityOfPrecipitation && h.probabilityOfPrecipitation.value != null
        ? h.probabilityOfPrecipitation.value
        : null,
  }));
}

function normalizeDaily(json, count) {
  const periods = (json.properties && json.properties.periods) || [];
  const days = [];
  let cur = null;

  for (const p of periods) {
    if (p.isDaytime) {
      cur = {
        name: p.name,
        date: p.startTime.slice(0, 10),
        high: p.temperature,
        low: null,
        shortForecast: p.shortForecast,
        icon: pickIcon(p.shortForecast, true),
        precip:
          p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value != null
            ? p.probabilityOfPrecipitation.value
            : null,
      };
      days.push(cur);
    } else if (cur) {
      cur.low = p.temperature;
    } else {
      // Feed started on a night period (evening run) -- make a low-only entry.
      days.push({
        name: p.name,
        date: p.startTime.slice(0, 10),
        high: null,
        low: p.temperature,
        shortForecast: p.shortForecast,
        icon: pickIcon(p.shortForecast, false),
        precip:
          p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value != null
            ? p.probabilityOfPrecipitation.value
            : null,
      });
    }
  }
  return days.slice(0, count);
}

async function getWeather(config) {
  const ua =
    config.nwsUserAgent ||
    'kindle-wall-display (configure nwsUserAgent with a contact email)';
  const lat = Number(config.lat);
  const lon = Number(config.lon);
  const hourlyCount = config.hourlyCount || 12;
  const dailyCount = config.dailyCount || 5;
  const ttl = (config.refresh && config.refresh.weatherMs) || 10 * 60 * 1000;

  return cache.get('weather', ttl, async () => {
    const points = await cache.get(`points:${lat},${lon}`, POINTS_TTL, () =>
      nwsFetch(
        `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
        ua
      )
    );
    const p = points.properties;

    const [forecast, hourly, stations] = await Promise.allSettled([
      cache.get(`forecast:${p.forecast}`, SUB_TTL, () => nwsFetch(p.forecast, ua)),
      cache.get(`hourly:${p.forecastHourly}`, SUB_TTL, () =>
        nwsFetch(p.forecastHourly, ua)
      ),
      cache.get(`stations:${p.observationStations}`, POINTS_TTL, () =>
        nwsFetch(p.observationStations, ua)
      ),
    ]);

    // Current conditions: prefer the local SEMO community-station blend, fall
    // back to the nearest NWS observation station if SEMO is unavailable.
    let current = null;
    let currentSource = null;

    if (config.semoCurrentUrl) {
      try {
        current = await cache.get('semo:current', SUB_TTL, () =>
          semoFetch(config.semoCurrentUrl, ua)
        );
        currentSource = 'semo';
      } catch (err) {
        console.warn('weather: SEMO current failed:', err.message);
      }
    }

    if (!current && stations.status === 'fulfilled') {
      const stId =
        stations.value.features &&
        stations.value.features[0] &&
        stations.value.features[0].properties.stationIdentifier;
      if (stId) {
        try {
          const obs = await cache.get(`obs:${stId}`, SUB_TTL, () =>
            nwsFetch(
              `https://api.weather.gov/stations/${stId}/observations/latest`,
              ua
            )
          );
          current = normalizeObs(obs.properties);
          currentSource = 'nws';
        } catch (err) {
          console.warn('weather: current observation failed:', err.message);
        }
      }
    }

    // SEMO reports sensor readings but no sky state -- pull the icon and
    // description from the current hour of the NWS hourly forecast.
    if (current && currentSource === 'semo' && hourly.status === 'fulfilled') {
      const h0 =
        hourly.value.properties &&
        hourly.value.properties.periods &&
        hourly.value.properties.periods[0];
      if (h0) {
        current.description =
          current.raining && !/rain|shower|drizzle|thunder/i.test(h0.shortForecast)
            ? `${h0.shortForecast} · rain`
            : h0.shortForecast;
        current.icon = current.raining
          ? pickIcon('rain', h0.isDaytime)
          : pickIcon(h0.shortForecast, h0.isDaytime);
      }
    }

    const rel = p.relativeLocation && p.relativeLocation.properties;
    return {
      updated: new Date().toISOString(),
      location: rel ? `${rel.city}, ${rel.state}` : '',
      current,
      currentSource,
      hourly:
        hourly.status === 'fulfilled'
          ? normalizeHourly(hourly.value, hourlyCount)
          : [],
      daily:
        forecast.status === 'fulfilled'
          ? normalizeDaily(forecast.value, dailyCount)
          : [],
      partial:
        forecast.status !== 'fulfilled' ||
        hourly.status !== 'fulfilled' ||
        current == null,
    };
  });
}

module.exports = { getWeather };
