const LAT = 23.1291;
const LON = 113.2644;

function d2r(d) { return d * Math.PI / 180; }
function r2d(r) { return r * 180 / Math.PI; }

function dayOfYear(month, day) {
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let doy = 0;
  for (let i = 0; i < month - 1; i++) doy += days[i];
  return doy + day;
}

function getSolarParams(doy) {
  const n = doy;
  const Jstar = n + (0 - 120 + 0) / 360;
  const M = d2r(357.5291 + 0.98560028 * Jstar);
  const C = d2r((1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)));
  const lambda = M + C + d2r(180 + 102.9372);
  const delta = Math.asin(Math.sin(lambda) * Math.sin(d2r(23.44)));
  return { M, C, lambda, delta };
}

function getDeclination(doy) {
  return getSolarParams(doy).delta;
}

function getEquationOfTime(doy) {
  const params = getSolarParams(doy);
  const y = Math.tan(d2r(23.44) / 2) ** 2;
  const L = params.lambda;
  const eot = r2d(y * Math.sin(2 * L) - 2 * 0.0167 * Math.sin(params.M) + 
               4 * 0.0167 * y * Math.cos(params.M) * Math.cos(2 * L) - 
               0.5 * y * y * Math.sin(4 * L) - 
               1.25 * 0.0167 ** 2 * Math.sin(2 * params.M));
  return eot * 4;
}

function calcSunTimes(doy) {
  const params = getSolarParams(doy);
  const delta = params.delta;
  const eot = getEquationOfTime(doy);
  
  const Jtransit = 12 - (LON - 120) / 15 - eot / 60;
  
  const latRad = d2r(LAT);
  
  const sunRiseSetAngle = -d2r(0.83);
  
  const cosH = (Math.sin(sunRiseSetAngle) - Math.sin(latRad) * Math.sin(delta)) / 
                (Math.cos(latRad) * Math.cos(delta));
  
  if (cosH > 1) {
    return { sunrise: null, sunset: null, dayLength: 0, isPolarNight: true };
  }
  if (cosH < -1) {
    return { sunrise: 0, sunset: 24, dayLength: 24, isPolarDay: true };
  }
  
  const Hdeg = r2d(Math.acos(cosH));
  
  const Jset = Jtransit + Hdeg / 15;
  const Jrise = Jtransit - Hdeg / 15;
  
  const sunrise = ((Jrise % 24) + 24) % 24;
  const sunset = ((Jset % 24) + 24) % 24;
  const dayLength = sunset - sunrise;
  
  return { sunrise, sunset, dayLength };
}

function calcSolarElevation(doy, hour) {
  const eqTime = getEquationOfTime(doy);
  const solarTime = hour - (eqTime / 60) - (LON - 120) / 15;
  const hourAngle = d2r(15 * (solarTime - 12));
  const decl = getDeclination(doy);
  const latRad = d2r(LAT);
  const sinAlt = Math.sin(latRad) * Math.sin(decl) + 
                 Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngle);
  return r2d(Math.asin(sinAlt));
}

function getGoldenWindows(sunData) {
  if (sunData.dayLength < 0.5) return null;
  
  const morningEnd = Math.min(sunData.sunrise + 1, sunData.sunset);
  const eveningStart = Math.max(sunData.sunset - 1, sunData.sunrise);
  
  return {
    morning: { start: sunData.sunrise, end: morningEnd },
    evening: { start: eveningStart, end: sunData.sunset }
  };
}

function formatTime(hours) {
  if (hours === null || hours === undefined) return '极夜';
  if (hours === 0) return '00:00';
  if (hours === 24) return '24:00';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Test for DOY 172 (June 21, summer solstice)
const doy = 172;
const sunData = calcSunTimes(doy);
console.log('Sunrise:', formatTime(sunData.sunrise));
console.log('Sunset:', formatTime(sunData.sunset));
console.log('Day length:', sunData.dayLength.toFixed(2), 'hours');

const goldenWindows = getGoldenWindows(sunData);
console.log('\nGolden windows:');
console.log('Morning:', formatTime(goldenWindows.morning.start), '->', formatTime(goldenWindows.morning.end));
console.log('Evening:', formatTime(goldenWindows.evening.start), '->', formatTime(goldenWindows.evening.end));

const mElev = calcSolarElevation(doy, (goldenWindows.morning.start + goldenWindows.morning.end) / 2);
const eElev = calcSolarElevation(doy, (goldenWindows.evening.start + goldenWindows.evening.end) / 2);
console.log('\nMorning midpoint elevation:', mElev.toFixed(1), '°');
console.log('Evening midpoint elevation:', eElev.toFixed(1), '°');

// Test UV
const noonElev = calcSolarElevation(doy, 12);
console.log('\nNoon elevation:', noonElev.toFixed(1), '°');

// Test DOY 355 (Dec 21, winter solstice)
const doy2 = 355;
const sunData2 = calcSunTimes(doy2);
console.log('\n--- Winter Solstice (DOY 355) ---');
console.log('Sunrise:', formatTime(sunData2.sunrise));
console.log('Sunset:', formatTime(sunData2.sunset));
console.log('Day length:', sunData2.dayLength.toFixed(2), 'hours');

const gw2 = getGoldenWindows(sunData2);
if (gw2) {
  console.log('Morning:', formatTime(gw2.morning.start), '->', formatTime(gw2.morning.end));
  console.log('Evening:', formatTime(gw2.evening.start), '->', formatTime(gw2.evening.end));
}