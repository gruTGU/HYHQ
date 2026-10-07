'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../../cloudfunctions/hyhqApi/lib/providers');
const config = { qweatherEnabled: true, qweatherApiKey: 'only-fixture-secret', qweatherApiHost: 'unit.qweatherapi.com' };
const location = { latitude: 39.09, longitude: 117.20 };
function day(extra = {}) { return { forecastStartTime: '2026-10-02T22:00Z', forecastEndTime: '2026-10-03T22:00Z', temperatureMin: { value: 12.5, unit: '°C' }, temperatureMax: { value: 23.5, unit: '°C' }, ...extra }; }
function body(days = [day()]) { return { metadata: { attributions: ['Official QWeather daily fixture'] }, days }; }
test('daily dispatch is one bounded fixed request for three days, never arbitrary paths or URL credentials', async () => {
  let calls = 0;
  const result = await provider.fetchWeather(config, 'daily', location, async (options, data, bounds) => {
    calls++; assert.equal(options.hostname, 'unit.qweatherapi.com');
    assert.equal(options.path, '/weather/v1/daily/39.09/117.20?days=3&lang=zh');
    assert.equal(options.headers['X-QW-Api-Key'], config.qweatherApiKey); assert.equal(options.method, 'GET');
    assert.equal(data, undefined); assert.equal(bounds.timeoutMs, 5000); assert.equal(bounds.maxBytes, 262144); assert.equal(bounds.gzip, true);
    assert.ok(!options.path.includes(config.qweatherApiKey)); return body();
  });
  assert.equal(calls, 1); assert.equal(result.observed_at, null); assert.deepEqual(result.attributions, ['Official QWeather daily fixture']);
  assert.equal(result.data.schema_version, 2); assert.equal(result.data.timezone, 'Asia/Shanghai');
  assert.equal(result.data.days[0].temperature_min, 12.5); assert.equal(result.data.days[0].temperature_max, 23.5);
  assert.equal(result.data.days[0].date, '2026-10-03'); assert.equal(result.data.days[0].daytime.precipitation_probability_percent, null);
  for (const kind of ['forecast', 'minute', 'cyclone', 'marine', 'solar', 'radiation', '../daily', 'daily?days=10', 'https://evil.example']) await assert.rejects(provider.fetchWeather(config, kind, location, () => assert.fail()), { code: 'unsupported_kind' });
  assert.deepEqual(Object.keys(provider.WEATHER_PATHS), ['weather', 'air', 'alerts', 'daily']);
});
test('daily requires trusted attribution, zoned valid forecast intervals and at most three nonoverlapping days', () => {
  for (const value of [
    { days: [day()] }, { metadata: { attributions: [12] }, days: [day()] }, body([]), body([day(), day()]), body(Array(4).fill(day())),
    body([day({ forecastStartTime: '2026-10-03T06:00' })]), body([day({ forecastStartTime: '2026-02-30T06:00Z' })]),
    body([day({ forecastEndTime: '2026-10-02T22:00Z' })]), body([day({ forecastEndTime: '2026-10-05T22:00Z' })]),
  ]) assert.throws(() => provider.normalizeWeather('daily', value), { code: 'invalid_response' });
  const result = provider.normalizeWeather('daily', body([day({ forecastStartTime: '2026-10-03T06:00+08:00', forecastEndTime: '2026-10-04T06:00+08:00' })]));
  assert.equal(result.data.days[0].date, '2026-10-03'); assert.equal(result.data.days[0].starts_at, '2026-10-02T22:00:00.000Z');
});
test('missing, conflicting or invalid extrema stay missing and current/minute/daytime temperatures are never used', () => {
  const missing = provider.normalizeWeather('daily', body([day({ temperatureMin: null, temperatureMax: { value: null, unit: '°C' }, temperature: { value: 99, unit: '°C' }, daytime: { temperatureMax: { value: 99, unit: '°C' } } })]));
  assert.equal(missing.data.days[0].temperature_min, null); assert.equal(missing.data.days[0].temperature_max, null);
  for (const extra of [
    { temperatureMin: { value: 80, unit: '°F' } }, { temperatureMin: { value: 30, unit: '°C' } },
    { temperatureMin: { value: '12', unit: '°C' }, temperatureMax: { value: Infinity, unit: '°C' } },
    { temperatureMin: { value: 12 }, temperatureMax: { value: 25 } },
  ]) { const row = provider.normalizeWeather('daily', body([day(extra)])).data.days[0]; assert.equal(row.temperature_min, null); assert.equal(row.temperature_max, null); }
  const zero = provider.normalizeWeather('daily', body([day({ temperatureMin: { value: 0, unit: '°C' }, temperatureMax: { value: 0, unit: '°C' } })])).data.days[0];
  assert.equal(zero.temperature_min, 0); assert.equal(zero.temperature_max, 0);
});
test('daily preserves complete attribution and redacts secrets just like the current products', () => {
  const source = 'source '.repeat(2000), value = body(); value.metadata.attributions = [source, 'ref ' + config.qweatherApiKey];
  const normalized = provider.normalizeWeather('daily', value, config.qweatherApiKey);
  assert.equal(normalized.attributions[0], source); assert.equal(normalized.attributions[1], 'ref [redacted]');
  value.metadata.attributions = ['x'.repeat(32001)]; assert.throws(() => provider.normalizeWeather('daily', value), { code: 'response_too_large' });
});
test('daily retains daytime nighttime conditions precipitation probability and wind with null-safe official units', () => {
  const part = { forecastStartTime: '2026-10-03T07:00:00+08:00', forecastEndTime: '2026-10-03T19:00:00+08:00', condition: { text: '小雨', code: '305' },
    precipitation: { probability: 0.641, amount: { value: 2.5, unit: 'mm' } }, wind: { direction: { compass: 'ne' }, speed: { value: 3.4, unit: 'm/s' }, scale: 3 } };
  const result = provider.normalizeWeather('daily', body([day({ daytime: part, nighttime: { ...part, condition: { text: '多云', code: '101' } } })]));
  assert.equal(result.data.schema_version, 2); const row = result.data.days[0];
  assert.equal(row.daytime.condition, '小雨'); assert.equal(row.nighttime.condition, '多云'); assert.equal(row.daytime.condition_code, '305');
  assert.equal(row.daytime.precipitation_probability_percent, 64.1); assert.equal(row.daytime.precipitation_amount, 2.5); assert.equal(row.daytime.precipitation_unit, 'mm');
  assert.equal(row.daytime.wind_direction, 'ne'); assert.equal(row.daytime.wind_speed, 3.4); assert.equal(row.daytime.wind_unit, 'm/s'); assert.equal(row.daytime.wind_scale, 3);
  const invalid = provider.normalizeWeather('daily', body([day({ daytime: { precipitation: { probability: 101, amount: { value: -1 } }, wind: { speed: { value: -2 }, scale: 20 } } })])).data.days[0].daytime;
  assert.equal(invalid.precipitation_probability_percent, null); assert.equal(invalid.precipitation_amount, null); assert.equal(invalid.wind_speed, null); assert.equal(invalid.wind_scale, null);
  const zero = provider.normalizeWeather('daily', body([day({ nighttime: { precipitation: { probability: 0, amount: { value: 0, unit: 'mm' } }, wind: { speed: { value: 0, unit: 'm/s' }, scale: 0 } } })])).data.days[0].nighttime;
  assert.equal(zero.precipitation_probability_percent, 0); assert.equal(zero.precipitation_amount, 0); assert.equal(zero.wind_speed, 0); assert.equal(zero.wind_scale, 0);
});
