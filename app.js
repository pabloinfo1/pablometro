const WORKER_URL = 'https://api-pablometro.pabloinfo1.com/';
const MAX_DATA_AGE_MS = 30 * 60 * 1000; // 30 minutos
const MAX_RECENT_MUNICIPIOS = 5;
let municipiosDB = [];
let municipiosCargando = true;
let deferredInstallPrompt = null;
let currentWeatherData = null;
let lastFetchTimestamp = 0;
let diaSeleccionadoIndex = null; // null = Próximas 24h desde hora actual, >0 = Día futuro seleccionado
let currentWeatherAbortController = null;

const DEFAULT_ADV_PREFS = {
  uv: false,
  nieve: false,
  tormenta: false,
  sensacion: false,
  viento: false,
  precip: false
};

/* --- GESTIÓN DE BLOQUEO DE SCROLL EN MODALES --- */
function actualizarBloqueoScrollBody() {
  const idsModales = [
    'welcome-modal',
    'search-modal',
    'options-modal',
    'privacy-modal',
    'faq-modal',
    'alert-modal',
    'ios-pwa-modal',
    'timeout-modal'
  ];
  const algunModalAbierto = idsModales.some(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });

  document.body.classList.toggle('overflow-hidden', algunModalAbierto);
  document.documentElement.classList.toggle('overflow-hidden', algunModalAbierto);
}

/* --- WATCHDOG (DETECCIÓN DE CARGA LENTA) --- */
let tareasPendientes = 0;
let watchdogTimer = null;

function registrarTareaCarga() {
  if (tareasPendientes === 0) {
    watchdogTimer = setTimeout(() => {
      const modal = document.getElementById('timeout-modal');
      const panel = document.getElementById('timeout-modal-panel');
      if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        void modal.offsetWidth; // forzar reflow
        modal.classList.remove('opacity-0');
        if (panel) panel.classList.remove('scale-95');
        actualizarBloqueoScrollBody();
      }
    }, 12000); // 12 segundos de margen
  }
  tareasPendientes++;
}

function finalizarTareaCarga() {
  tareasPendientes = Math.max(0, tareasPendientes - 1);
  if (tareasPendientes === 0) {
    clearTimeout(watchdogTimer);
    const modal = document.getElementById('timeout-modal');
    const panel = document.getElementById('timeout-modal-panel');
    if (modal && !modal.classList.contains('hidden')) {
       modal.classList.add('opacity-0');
       if (panel) panel.classList.add('scale-95');
       setTimeout(() => {
         modal.classList.add('hidden');
         modal.classList.remove('flex');
         actualizarBloqueoScrollBody();
       }, 300);
    }
  }
}

/* --- FUNCIÓN DE RASTREO (ANALYTICS) --- */
function trackEvent(eventName, eventParams = {}) {
  if (typeof window.gtag === 'function') {
    window.gtag('event', eventName, eventParams);
  }
}

function cargarPreferenciasAvanzadas() {
  try {
    const guardadas = JSON.parse(localStorage.getItem('app_advanced_prefs'));
    if (guardadas && typeof guardadas === 'object') {
      return { ...DEFAULT_ADV_PREFS, ...guardadas };
    }
  } catch {
    // Ignorar error de parseo y usar valores por defecto
  }
  return { ...DEFAULT_ADV_PREFS };
}

let advPrefs = cargarPreferenciasAvanzadas();

/* --- UTILIDADES, ESCAPADO XSS Y REPARACIÓN DE CODIFICACIÓN --- */
function escaparHTML(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function repararTextoMojibake(str) {
  if (typeof str !== 'string') return str;
  if (!/[ÃÂâ]/.test(str)) return str;
  try {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code > 255) return str;
      bytes[i] = code;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return str;
  }
}

function obtenerNombreMunicipioLimpio(data) {
  const ineActual = String(data?.municipio?.id_ine || localStorage.getItem('saved_ine') || '').padStart(5, '0');
  if (municipiosDB.length > 0 && ineActual) {
    const encontrado = municipiosDB.find(m => m.id_ine === ineActual);
    if (encontrado && encontrado.nombre) {
      return encontrado.nombre;
    }
  }
  return repararTextoMojibake(data?.municipio?.nombre || 'Localidad');
}

function normalizarTexto(str) {
  if (!str) return '';
  return repararTextoMojibake(String(str))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function primerValorDefinido(...valores) {
  for (const val of valores) {
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return undefined;
}

function obtenerNumeroValido(...valores) {
  for (const val of valores) {
    if (val !== undefined && val !== null && val !== '' && val !== '--') {
      const num = Number(val);
      if (!isNaN(num)) return num;
    }
  }
  return null;
}

function parsearPrecipitacionMm(valorRaw) {
  if (valorRaw === undefined || valorRaw === null || valorRaw === '') return 0;
  if (typeof valorRaw === 'number') return valorRaw > 0 ? valorRaw : 0;
  const str = String(valorRaw).trim().toLowerCase();
  if (str === 'ip') return 0.1;
  const num = parseFloat(str.replace(',', '.'));
  return (!isNaN(num) && num > 0) ? num : 0;
}

function parsearProbabilidadPct(valorRaw) {
  if (valorRaw === undefined || valorRaw === null || valorRaw === '') return null;
  const num = typeof valorRaw === 'number' ? valorRaw : parseInt(String(valorRaw).trim(), 10);
  if (isNaN(num)) return null;
  return Math.max(0, Math.min(100, num));
}

function hayRiesgoRealNieve(horaObj) {
  if (!horaObj) return false;
  const cotaRaw = horaObj.cota_nieve;
  if (cotaRaw === undefined || cotaRaw === null || cotaRaw === '' || cotaRaw === '0' || cotaRaw === 0) {
    return false;
  }
  const cotaNum = parseInt(String(cotaRaw).replace(/[^\d]/g, ''), 10);
  if (isNaN(cotaNum) || cotaNum <= 0) return false;

  const tempNum = obtenerNumeroValido(horaObj.temperatura, horaObj.sensacion_termica);
  const precipMm = parsearPrecipitacionMm(horaObj.precipitacion_mm);
  const probPrecip = parsearProbabilidadPct(horaObj.prob_precipitacion) ?? 0;

  const hayPrecipitacionPrevista = precipMm > 0 || probPrecip >= 35;
  const haceFrioParaNieve = (tempNum !== null && tempNum <= 6) || cotaNum <= 700;

  return hayPrecipitacionPrevista && haceFrioParaNieve;
}

function extraerNumeroHora(horaStr) {
  if (horaStr === undefined || horaStr === null) return null;
  const num = parseInt(String(horaStr).trim().split(':')[0], 10);
  return isNaN(num) ? null : num;
}

function obtenerFechaLocalISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function obtenerRelojMunicipio(ine) {
  const codProv = String(ine || localStorage.getItem('saved_ine') || '').padStart(5, '0').slice(0, 2);
  const timeZone = (codProv === '35' || codProv === '38') ? 'Atlantic/Canary' : 'Europe/Madrid';
  try {
    const partes = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false
    }).formatToParts(new Date());

    const map = {};
    partes.forEach(p => { map[p.type] = p.value; });
    return {
      fechaHoyISO: `${map.year}-${map.month}-${map.day}`,
      horaActualNum: parseInt(map.hour, 10) % 24,
      timeZone
    };
  } catch {
    const ahora = new Date();
    return {
      fechaHoyISO: obtenerFechaLocalISO(ahora),
      horaActualNum: ahora.getHours(),
      timeZone: 'Europe/Madrid'
    };
  }
}

/* --- GESTIÓN DE HISTORIAL DE MUNICIPIOS RECIENTES --- */
function obtenerMunicipiosRecientes() {
  try {
    const raw = JSON.parse(localStorage.getItem('recent_municipios'));
    if (Array.isArray(raw)) return raw;
  } catch {}
  return [];
}

function guardarMunicipioReciente(ine) {
  const ineNorm = String(ine || '').padStart(5, '0');
  if (!/^\d{5}$/.test(ineNorm)) return;

  const encontrado = municipiosDB.find(m => m.id_ine === ineNorm);
  const nombre = encontrado?.nombre || (currentWeatherData?.municipio?.id_ine === ineNorm ? repararTextoMojibake(currentWeatherData.municipio.nombre) : null);
  const provincia = encontrado?.provincia || (currentWeatherData?.municipio?.id_ine === ineNorm ? repararTextoMojibake(currentWeatherData.municipio.provincia) : '');

  if (!nombre) return;

  const actuales = obtenerMunicipiosRecientes().filter(m => m.id_ine !== ineNorm);
  actuales.unshift({ id_ine: ineNorm, nombre, provincia });
  try {
    localStorage.setItem('recent_municipios', JSON.stringify(actuales.slice(0, MAX_RECENT_MUNICIPIOS)));
  } catch {}
}

let toastTimeout;
function mostrarToast(mensaje, icono = 'info') {
  const toast = document.getElementById('toast-notification');
  const toastMsg = document.getElementById('toast-message');
  const toastIcon = document.getElementById('toast-icon');
  if (!toast) return;

  toastMsg.textContent = mensaje;
  toastIcon.textContent = icono;

  toast.classList.remove('opacity-0', '-translate-y-4');
  toast.classList.add('opacity-100', 'translate-y-0');

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove('opacity-100', 'translate-y-0');
    toast.classList.add('opacity-0', '-translate-y-4');
  }, 3500);
}

function setEstadoCarga(cargando) {
  const content = document.getElementById('weather-content');
  if (!content) return;

  if (cargando) {
    content.classList.add('animate-pulse', 'opacity-50', 'pointer-events-none');
    const carrusel = document.getElementById('ui-carrusel-horas');
    if (carrusel && carrusel.children.length === 0) {
      carrusel.innerHTML = Array(6).fill(`
        <div class="snap-start shrink-0 bg-md-surface-container rounded-2xl p-4 flex flex-col items-center w-20 h-28 shadow-sm"></div>
      `).join('');
    }
    const lista = document.getElementById('ui-lista-dias');
    if (lista && lista.children.length === 0) {
      lista.innerHTML = Array(5).fill(`
        <div class="h-14 border-b border-border-color last:border-0"></div>
      `).join('');
    }
  } else {
    content.classList.remove('animate-pulse', 'opacity-50', 'pointer-events-none');
  }
}

function actualizarThemeColorNavegador() {
  const metaTheme = document.getElementById('meta-theme-color');
  if (!metaTheme) return;
  const currentTheme = localStorage.getItem('app_theme') || 'system';
  const isDark = currentTheme === 'dark' || (currentTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  metaTheme.setAttribute('content', isDark ? '#0f172a' : '#f8fafc');
}

function habilitarScrollArrastre(contenedor) {
  if (!contenedor) return;
  let isDown = false;
  let startX;
  let scrollLeft;

  contenedor.classList.add('cursor-grab');

  contenedor.addEventListener('mousedown', (e) => {
    isDown = true;
    contenedor.classList.add('cursor-grabbing');
    contenedor.classList.remove('cursor-grab', 'snap-x', 'scroll-smooth');
    startX = e.pageX - contenedor.offsetLeft;
    scrollLeft = contenedor.scrollLeft;
  });

  contenedor.addEventListener('mouseleave', () => {
    if (!isDown) return;
    isDown = false;
    contenedor.classList.remove('cursor-grabbing');
    contenedor.classList.add('cursor-grab', 'snap-x', 'scroll-smooth');
  });

  contenedor.addEventListener('mouseup', () => {
    isDown = false;
    contenedor.classList.remove('cursor-grabbing');
    contenedor.classList.add('cursor-grab', 'snap-x', 'scroll-smooth');
  });

  contenedor.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - contenedor.offsetLeft;
    const walk = (x - startX) * 2.5;
    contenedor.scrollLeft = scrollLeft - walk;
  });
}

/* --- NAVEGACIÓN INFERIOR DINÁMICA --- */
function actualizarBarraNavegacion(seccionActiva = 'tiempo') {
  const mapaBotones = {
    tiempo: document.getElementById('btn-tiempo'),
    buscar: document.getElementById('btn-search'),
    opciones: document.getElementById('btn-options')
  };

  Object.entries(mapaBotones).forEach(([clave, btn]) => {
    if (!btn) return;
    const icon = btn.querySelector('.nav-icon');
    const label = btn.querySelector('.nav-label');
    const activo = clave === seccionActiva;

    if (activo) {
      btn.className = 'nav-btn flex items-center justify-center gap-2 px-5 py-2.5 bg-md-surface-container-high rounded-full transition-all duration-200 text-md-primary';
      if (icon) icon.style.fontVariationSettings = "'FILL' 1";
      if (label) label.classList.remove('hidden');
    } else {
      btn.className = 'nav-btn flex items-center justify-center p-2.5 hover:bg-md-surface-container/50 rounded-full transition-all duration-200 text-text-muted hover:text-text-main';
      if (icon) icon.style.fontVariationSettings = "'FILL' 0";
      if (label) label.classList.add('hidden');
    }
  });
}

/* --- CONFIGURACIÓN PWA --- */
function inicializarPWA() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    const pwaSection = document.getElementById('pwa-install-section');
    if (pwaSection) pwaSection.classList.add('hidden');
    mostrarToast('Aplicación instalada correctamente', 'check_circle');
  });
}

inicializarPWA();

/* --- PROCESAMIENTO Y SINCRONIZACIÓN HORARIA --- */
function agruparHorasPorSaltosDeDia(horasTotales) {
  if (!Array.isArray(horasTotales) || horasTotales.length === 0) return [];
  const grupos = [[]];
  let diaActualIdx = 0;
  let horaAnteriorNum = null;

  horasTotales.forEach((item, idx) => {
    const horaNum = item._horaNum ?? extraerNumeroHora(item.hora);
    if (idx > 0 && horaNum !== null && horaAnteriorNum !== null && horaNum < horaAnteriorNum) {
      diaActualIdx++;
      grupos[diaActualIdx] = [];
    }
    if (horaNum !== null) horaAnteriorNum = horaNum;
    grupos[diaActualIdx].push(item);
  });

  return grupos;
}

function obtenerHorasParaDia(data, diaObj, indexEnLista) {
  if (!data || !diaObj) return [];
  if (Array.isArray(diaObj.horas) && diaObj.horas.length > 0) return diaObj.horas;

  if (Array.isArray(data.hoy_horas) && data.hoy_horas.length > 0) {
    if (diaObj.fecha) {
      const fechaDia = String(diaObj.fecha).slice(0, 10);
      const porFecha = data.hoy_horas.filter(h => h.fecha && String(h.fecha).startsWith(fechaDia));
      if (porFecha.length > 0) return porFecha;
    }
    const grupos = agruparHorasPorSaltosDeDia(data.hoy_horas);
    if (grupos[indexEnLista] && grupos[indexEnLista].length > 0) {
      return grupos[indexEnLista];
    }
  }

  return [];
}

function obtenerEstadoSincronizado(data) {
  const { fechaHoyISO, horaActualNum } = obtenerRelojMunicipio(data?.municipio?.id_ine);

  let poolHoras = [];
  if (Array.isArray(data.hoy_horas) && data.hoy_horas.length > 0) {
    poolHoras = data.hoy_horas;
  } else if (Array.isArray(data.proximos_dias)) {
    data.proximos_dias.forEach((d, idx) => {
      const hDia = obtenerHorasParaDia(data, d, idx);
      if (hDia.length > 0) {
        poolHoras.push(...hDia.map(h => ({ ...h, fecha: h.fecha || d.fecha })));
      }
    });
  }

  let horasFuturas = [];
  if (poolHoras.length > 0) {
    horasFuturas = poolHoras.filter(h => {
      const fechaItem = String(h.fecha || '').slice(0, 10);
      const horaNum = h._horaNum ?? extraerNumeroHora(h.hora);
      if (!fechaItem || horaNum === null) return true;
      if (fechaItem > fechaHoyISO) return true;
      if (fechaItem === fechaHoyISO) return horaNum >= horaActualNum;
      return false;
    });
  }

  if (horasFuturas.length === 0 && poolHoras.length > 0) {
    horasFuturas = poolHoras;
  }

  const proximas24Horas = horasFuturas.slice(0, 24);
  const horaEnCurso = proximas24Horas[0] || {};
  const baseActual = data.actual || {};

  const actualSincronizado = {
    ...baseActual,
    hora: primerValorDefinido(horaEnCurso.hora, baseActual.hora),
    temperatura: primerValorDefinido(horaEnCurso.temperatura, baseActual.temperatura),
    estado_cielo: primerValorDefinido(horaEnCurso.estado_cielo, baseActual.estado_cielo),
    icono: primerValorDefinido(horaEnCurso.icono, baseActual.icono, 'cloud'),
    humedad: primerValorDefinido(horaEnCurso.humedad, baseActual.humedad),
    viento_kmh: primerValorDefinido(horaEnCurso.viento_kmh, baseActual.viento_kmh),
    sensacion_termica: primerValorDefinido(horaEnCurso.sensacion_termica, baseActual.sensacion_termica, horaEnCurso.temperatura, baseActual.temperatura),
    prob_precipitacion: primerValorDefinido(horaEnCurso.prob_precipitacion, baseActual.prob_precipitacion),
    precipitacion_mm: primerValorDefinido(horaEnCurso.precipitacion_mm, baseActual.precipitacion_mm),
    cota_nieve: primerValorDefinido(horaEnCurso.cota_nieve, baseActual.cota_nieve),
    prob_tormenta: primerValorDefinido(horaEnCurso.prob_tormenta, baseActual.prob_tormenta),
    rachas_viento: primerValorDefinido(horaEnCurso.rachas_viento, baseActual.rachas_viento),
    direccion_viento: primerValorDefinido(horaEnCurso.direccion_viento, baseActual.direccion_viento),
    uv: primerValorDefinido(horaEnCurso.uv, baseActual.uv)
  };

  return { actualSincronizado, proximas24Horas };
}

function extraerDatosAvanzadosActuales(data, actualSincronizado) {
  const actual = actualSincronizado || data.actual || {};
  const dia0 = (Array.isArray(data.proximos_dias) && data.proximos_dias[0]) || {};

  const { horaActualNum } = obtenerRelojMunicipio(data?.municipio?.id_ine);
  const esDeNoche = horaActualNum < 7 || horaActualNum >= 21;

  return {
    uv: esDeNoche ? 0 : primerValorDefinido(actual.uv, dia0.uv_max),
    nieveRaw: primerValorDefinido(actual.cota_nieve, dia0.cota_nieve),
    tormenta: primerValorDefinido(actual.prob_tormenta, dia0.prob_tormenta),
    sensacion: primerValorDefinido(actual.sensacion_termica, actual.temperatura),
    racha: primerValorDefinido(actual.rachas_viento, dia0.racha_max, actual.viento_kmh),
    direccion: primerValorDefinido(actual.direccion_viento, dia0.direccion_viento)
  };
}

/* --- ALERTAS Y MODAL DETALLADO DE AVISOS --- */
function obtenerEstilosNivelAlerta(nivelRaw) {
  const nivelNorm = normalizarTexto(nivelRaw);
  if (nivelNorm.includes('roj')) {
    return {
      etiqueta: 'Aviso Rojo · Riesgo Extremo',
      etiquetaCorta: 'Aviso Rojo',
      badgeStyle: 'background-color: rgba(239, 68, 68, 0.18); border: 1px solid rgba(239, 68, 68, 0.5); color: #ef4444;',
      iconWrapStyle: 'background-color: rgba(239, 68, 68, 0.18); color: #ef4444;',
      descripcionFallback: 'Riesgo meteorológico extremo (fenómenos no habituales de intensidad excepcional). Se recomienda extremar la precaución y seguir las indicaciones oficiales.'
    };
  }
  if (nivelNorm.includes('naranj')) {
    return {
      etiqueta: 'Aviso Naranja · Riesgo Importante',
      etiquetaCorta: 'Aviso Naranja',
      badgeStyle: 'background-color: rgba(249, 115, 22, 0.18); border: 1px solid rgba(249, 115, 22, 0.5); color: #f97316;',
      iconWrapStyle: 'background-color: rgba(249, 115, 22, 0.18); color: #f97316;',
      descripcionFallback: 'Riesgo meteorológico importante. Existe un grado de peligro para las actividades usuales en la zona afectada.'
    };
  }
  if (nivelNorm.includes('amarill')) {
    return {
      etiqueta: 'Aviso Amarillo · Riesgo',
      etiquetaCorta: 'Aviso Amarillo',
      badgeStyle: 'background-color: rgba(234, 179, 8, 0.18); border: 1px solid rgba(234, 179, 8, 0.5); color: #eab308;',
      iconWrapStyle: 'background-color: rgba(234, 179, 8, 0.18); color: #eab308;',
      descripcionFallback: 'No existe riesgo meteorológico para la población en general, aunque sí para alguna actividad concreta expuesta al fenómeno.'
    };
  }
  const limpio = String(nivelRaw || 'Activo');
  return {
    etiqueta: limpio.toLowerCase().startsWith('aviso') ? limpio : `Aviso ${limpio}`,
    etiquetaCorta: limpio.toLowerCase().startsWith('aviso') ? limpio : `Aviso ${limpio}`,
    badgeStyle: 'background-color: rgba(59, 130, 246, 0.16); border: 1px solid rgba(59, 130, 246, 0.45); color: var(--md-primary);',
    iconWrapStyle: 'background-color: rgba(59, 130, 246, 0.16); color: var(--md-primary);',
    descripcionFallback: 'Aviso meteorológico oficial activo para este municipio o zona.'
  };
}

function formatearTramoAlerta(inicioISO, finISO, ine) {
  if (!inicioISO && !finISO) return '';
  const { fechaHoyISO, timeZone } = obtenerRelojMunicipio(ine);

  const formatearPunto = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;

    const partes = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(d);

    const map = {};
    partes.forEach(p => { map[p.type] = p.value; });
    const fechaISO = `${map.year}-${map.month}-${map.day}`;
    const horaStr = `${String(parseInt(map.hour, 10) % 24).padStart(2, '0')}:${map.minute}`;

    if (fechaISO === fechaHoyISO) return `hoy a las ${horaStr}`;

    const mananaDate = new Date();
    mananaDate.setDate(mananaDate.getDate() + 1);
    const mananaPartes = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(mananaDate);
    if (fechaISO === mananaPartes) return `mañana a las ${horaStr}`;

    const diaCorto = new Intl.DateTimeFormat('es-ES', { timeZone, weekday: 'short', day: 'numeric' }).format(d);
    return `${diaCorto} a las ${horaStr}`;
  };

  const iniTxt = formatearPunto(inicioISO);
  const finTxt = formatearPunto(finISO);

  if (iniTxt && finTxt) return `Vigencia: desde ${iniTxt} hasta ${finTxt}`;
  if (iniTxt) return `Inicio previsto: ${iniTxt}`;
  if (finTxt) return `Activo hasta ${finTxt}`;
  return '';
}

function extraerAlertasActivas(data) {
  if (!data || !Array.isArray(data.alertas)) return [];
  const vistas = new Set();
  const alertasLimpias = [];

  data.alertas.forEach(item => {
    if (!item) return;
    const nivel = repararTextoMojibake(String(item.nivel || 'Aviso activo'));
    const fenomeno = repararTextoMojibake(String(item.fenomeno || ''));
    const descripcion = repararTextoMojibake(String(item.descripcion || ''));
    const inicio = item.inicio || null;
    const fin = item.fin || null;
    const esFuturo = Boolean(item.es_futuro) || (inicio ? Date.parse(inicio) > Date.now() : false);

    const clave = `${normalizarTexto(nivel)}-${normalizarTexto(fenomeno)}-${esFuturo ? 'futuro' : 'activo'}`;
    if (!vistas.has(clave)) {
      vistas.add(clave);
      alertasLimpias.push({ nivel, fenomeno, descripcion, inicio, fin, es_futuro: esFuturo });
    }
  });

  const obtenerPeso = (niv) => {
    const n = normalizarTexto(niv);
    if (n.includes('roj')) return 3;
    if (n.includes('naranj')) return 2;
    if (n.includes('amarill')) return 1;
    return 0;
  };

  return alertasLimpias.sort((a, b) => {
    if (a.es_futuro !== b.es_futuro) return Number(a.es_futuro) - Number(b.es_futuro);
    return obtenerPeso(b.nivel) - obtenerPeso(a.nivel);
  });
}

function abrirModalAlerta(alertaPrincipal, todasLasAlertas = []) {
  const modal = document.getElementById('alert-modal');
  const panel = document.getElementById('alert-modal-panel');
  const iconWrap = document.getElementById('alert-modal-icon-wrap');
  const badge = document.getElementById('alert-modal-badge');
  const title = document.getElementById('alert-modal-title');
  const municipioEl = document.getElementById('alert-modal-municipio');
  const horarioWrap = document.getElementById('alert-modal-horario-wrap');
  const horarioEl = document.getElementById('alert-modal-horario');
  const descEl = document.getElementById('alert-modal-desc');
  const otherContainer = document.getElementById('alert-modal-list-container');
  const otherList = document.getElementById('alert-modal-other-list');

  if (!modal || !alertaPrincipal) return;

  const estilos = obtenerEstilosNivelAlerta(alertaPrincipal.nivel);
  iconWrap.style.cssText = estilos.iconWrapStyle;
  badge.style.cssText = estilos.badgeStyle;
  
  const prefijoFuturo = alertaPrincipal.es_futuro ? 'Próximo ' : '';
  badge.textContent = `${prefijoFuturo}${estilos.etiqueta}`;

  title.textContent = alertaPrincipal.fenomeno || estilos.etiquetaCorta;
  municipioEl.textContent = obtenerNombreMunicipioLimpio(currentWeatherData);
  descEl.textContent = alertaPrincipal.descripcion || estilos.descripcionFallback;

  const textoTramo = formatearTramoAlerta(alertaPrincipal.inicio, alertaPrincipal.fin, currentWeatherData?.municipio?.id_ine);
  if (horarioWrap && horarioEl) {
    if (textoTramo) {
      horarioEl.textContent = textoTramo;
      horarioWrap.classList.remove('hidden');
      horarioWrap.classList.add('flex');
    } else {
      horarioWrap.classList.add('hidden');
      horarioWrap.classList.remove('flex');
    }
  }

  const otras = todasLasAlertas.filter(a => a !== alertaPrincipal);
  if (otras.length > 0 && otherContainer && otherList) {
    otherContainer.classList.remove('hidden');
    otherContainer.classList.add('flex');
    otherList.innerHTML = '';

    otras.forEach(otra => {
      const estOtra = obtenerEstilosNivelAlerta(otra.nivel);
      const itemBtn = document.createElement('button');
      itemBtn.type = 'button';
      itemBtn.className = 'w-full text-left p-3 rounded-2xl bg-md-surface-container hover:bg-md-surface-container-high transition flex items-center justify-between gap-2 border border-border-color/50';
      const prefijoFuturoOtra = otra.es_futuro ? 'Próximo ' : '';
      const tituloOtra = `${prefijoFuturoOtra}${estOtra.etiquetaCorta}${otra.fenomeno ? ` · ${otra.fenomeno}` : ''}`;
      const descOtra = otra.descripcion || estOtra.descripcionFallback;

      itemBtn.innerHTML = `
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="material-symbols-rounded text-[18px] shrink-0" style="color: ${estOtra.badgeStyle.split('color:')[1] || 'var(--md-primary)'}">warning</span>
          <div class="flex flex-col min-w-0">
            <span class="text-xs font-bold text-text-main truncate">${escaparHTML(tituloOtra)}</span>
            <span class="text-xs text-text-muted truncate">${escaparHTML(descOtra)}</span>
          </div>
        </div>
        <span class="material-symbols-rounded text-text-muted text-base shrink-0">chevron_right</span>
      `;
      itemBtn.addEventListener('click', () => abrirModalAlerta(otra, todasLasAlertas));
      otherList.appendChild(itemBtn);
    });
  } else if (otherContainer) {
    otherContainer.classList.add('hidden');
    otherContainer.classList.remove('flex');
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  void modal.offsetWidth;
  modal.classList.remove('opacity-0');
  if (panel) panel.classList.remove('scale-95');
  actualizarBloqueoScrollBody();
}

function cerrarModalAlerta() {
  const modal = document.getElementById('alert-modal');
  const panel = document.getElementById('alert-modal-panel');
  if (!modal || modal.classList.contains('hidden')) return;

  modal.classList.add('opacity-0');
  if (panel) panel.classList.add('scale-95');
  setTimeout(() => {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    actualizarBloqueoScrollBody();
  }, 300);
}

/* --- LÓGICA METEOROLÓGICA --- */
async function cargarTiempo(ine, silencioso = false, forzar = false) {
  if (currentWeatherAbortController) {
    currentWeatherAbortController.abort();
  }
  const controller = new AbortController();
  currentWeatherAbortController = controller;

  registrarTareaCarga();
  if (!silencioso) setEstadoCarga(true);
  try {
    const refreshParam = forzar ? '&refresh=1' : '';
    const fetchOptions = {
      signal: controller.signal,
      ...(forzar ? { cache: 'no-cache' } : {})
    };
    const res = await fetch(`${WORKER_URL}?ine=${encodeURIComponent(ine)}${refreshParam}`, fetchOptions);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (currentWeatherAbortController !== controller) return;

    currentWeatherData = data;
    lastFetchTimestamp = Date.now();
    if (!silencioso) diaSeleccionadoIndex = null;

    localStorage.setItem('saved_ine', ine);
    guardarMunicipioReciente(ine);
    renderizarUI();

    if (forzar) {
      mostrarToast('Datos meteorológicos actualizados', 'check_circle');
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('Fallo al cargar el tiempo:', error);
    if (!currentWeatherData) {
      document.getElementById('ui-municipio').textContent = 'Error de conexión';
    }
    mostrarToast('No se pudo conectar con el servidor meteorológico', 'cloud_off');
  } finally {
    if (currentWeatherAbortController === controller && !silencioso) {
      setEstadoCarga(false);
    }
    finalizarTareaCarga();
  }
}

function renderizarCarrusel(horasArray, titulo = 'Próximas horas', esDiaFuturo = false) {
  const tituloEl = document.getElementById('titulo-carrusel-horas');
  const btnVolverHoy = document.getElementById('btn-volver-hoy');

  if (tituloEl) {
    tituloEl.textContent = titulo;
    tituloEl.classList.remove('text-text-muted');
    tituloEl.classList.add('text-md-primary');
    setTimeout(() => {
      tituloEl.classList.add('text-text-muted');
      tituloEl.classList.remove('text-md-primary');
    }, 900);
  }

  if (btnVolverHoy) {
    if (esDiaFuturo) {
      btnVolverHoy.classList.remove('hidden');
      btnVolverHoy.classList.add('flex');
    } else {
      btnVolverHoy.classList.add('hidden');
      btnVolverHoy.classList.remove('flex');
    }
  }

  const carrusel = document.getElementById('ui-carrusel-horas');
  if (!carrusel) return;
  carrusel.innerHTML = '';

  const mode = localStorage.getItem('app_lifestyle_mode');
  const esModoLifestyle = mode === 'moto' || mode === 'botellon';

  horasArray.forEach((hora, index) => {
    const probPrecip = parsearProbabilidadPct(hora.prob_precipitacion);
    const precipMm = parsearPrecipitacionMm(hora.precipitacion_mm);
    const probTorm = parsearProbabilidadPct(hora.prob_tormenta) || 0;

    let motivoFrio = false;
    let motivoCalor = false;
    let motivoViento = false;
    let motivoNieve = false;
    let motivoPrecip = false;

    const racha = obtenerNumeroValido(hora.rachas_viento, hora.viento_kmh) ?? 0;
    const st = obtenerNumeroValido(hora.sensacion_termica, hora.temperatura) ?? 20;

    if (mode === 'moto') {
      if (hayRiesgoRealNieve(hora)) motivoNieve = true;
      if (precipMm > 0.1) motivoPrecip = true;
      if (racha > 35) motivoViento = true;
      if (st < 6) motivoFrio = true;
      if (st > 34) motivoCalor = true;
    } else if (mode === 'botellon') {
      if (precipMm > 0.1) motivoPrecip = true;
      if (st < 12) motivoFrio = true;
      if (racha > 30) motivoViento = true;
    }

    let bloquePrecipitacionHTML = '';

    if (advPrefs.precip && probPrecip !== null) {
      const probMostrar = probPrecip !== null ? probPrecip : 0;
      bloquePrecipitacionHTML += `
        <div class="flex items-center gap-[2px] text-text-muted" title="Probabilidad de precipitación">
          <span class="material-symbols-rounded text-[14px]">water_drop</span>
          <span class="text-[11px] font-bold">${probMostrar}%</span>
        </div>
      `;
    }

    if (precipMm > 0) {
      const mmFormateado = Number.isInteger(precipMm) ? precipMm : precipMm.toFixed(1).replace('.0', '');
      const mtClass = bloquePrecipitacionHTML ? 'mt-1 ' : '';
      const iconoPrecip = probTorm > 0 ? '💧⚡' : '💧';
      const clasesChip = motivoPrecip ? 'bg-md-surface-container border-red-500/50 text-red-500/90' : 'bg-md-surface-container border-md-primary text-md-primary';

      bloquePrecipitacionHTML += `
        <span class="${mtClass}px-1.5 py-0.5 rounded-md border text-[10px] font-semibold leading-none whitespace-nowrap ${clasesChip}" title="Precipitación acumulada prevista">
          ${iconoPrecip} ${mmFormateado} mm
        </span>
      `;
    }

    let detallesExtraHoraHTML = '';
    const itemsExtraHora = [];

    const mostrarSensacion = advPrefs.sensacion || motivoFrio || motivoCalor;
    const mostrarViento = advPrefs.viento || motivoViento;
    const mostrarNieve = advPrefs.nieve || motivoNieve;

    if (mostrarSensacion && hora.sensacion_termica !== undefined) {
      const color = (motivoFrio || motivoCalor) ? 'text-red-500/90 font-semibold' : 'text-text-muted';
      itemsExtraHora.push(`<span class="truncate max-w-full ${color}">ST ${escaparHTML(hora.sensacion_termica)}°</span>`);
    }
    if (advPrefs.tormenta) {
      const torm = parsearProbabilidadPct(hora.prob_tormenta);
      if (torm !== null) itemsExtraHora.push(`<span class="truncate max-w-full text-text-muted">⚡ ${torm}%</span>`);
    }
    if (mostrarViento) {
      const color = motivoViento ? 'text-red-500/90 font-semibold' : 'text-text-muted';
      const rachaH = primerValorDefinido(hora.rachas_viento, hora.viento_kmh);
      const dirH = hora.direccion_viento || '';
      if (rachaH !== undefined) itemsExtraHora.push(`<span class="truncate max-w-full ${color}">${escaparHTML(rachaH)}km/h${dirH ? ' ' + escaparHTML(dirH) : ''}</span>`);
    }
    if (mostrarNieve) {
      const color = motivoNieve ? 'text-red-500/90 font-semibold' : 'text-text-muted';
      const nieveH = hora.cota_nieve;
      if (nieveH !== undefined && nieveH !== null && nieveH !== '0' && nieveH !== 0) {
        const nieveTxt = String(nieveH).endsWith('m') ? nieveH : `${nieveH}m`;
        itemsExtraHora.push(`<span class="truncate max-w-full ${color}">❄ ${escaparHTML(nieveTxt)}</span>`);
      }
    }

    if (itemsExtraHora.length > 0) {
      const bColor = 'border-border-color/60';
      detallesExtraHoraHTML = `
        <div class="w-full border-t ${bColor} mt-2 pt-1.5 flex flex-col items-center gap-0.5 text-[10px] font-medium leading-tight text-center">
          ${itemsExtraHora.join('')}
        </div>
      `;
    }

    const esAhora = !esDiaFuturo && index === 0;
    const etiquetaHora = esAhora ? 'Ahora' : escaparHTML(hora.hora || '--:--');

    let bordeFondoClase = '';
    let colorHoraClase = '';
    let colorIconoClase = '';

    if (esAhora) {
      bordeFondoClase = 'ring-2 ring-inset ring-md-primary bg-md-surface-container-high';
      colorHoraClase = 'font-bold text-md-primary';
      colorIconoClase = 'text-md-primary';
    } else {
      bordeFondoClase = 'bg-md-surface-container border border-transparent';
      colorHoraClase = 'font-medium text-text-muted';
      colorIconoClase = 'text-md-primary';
    }

    const anchoCard = (itemsExtraHora.length > 0 || precipMm > 0) ? 'w-[96px]' : 'w-[84px]';
    const card = document.createElement('div');
    card.className = `snap-start shrink-0 ${bordeFondoClase} rounded-2xl p-3.5 flex flex-col items-center ${anchoCard} shadow-sm transition-all`;

    const tempColor = (motivoFrio || motivoCalor) ? 'text-red-500/90' : 'text-text-main';

    let bottomContentHTML = '';
    
    if (esModoLifestyle) {
      bottomContentHTML = `
        <div class="flex flex-col items-center">
          ${bloquePrecipitacionHTML}
        </div>
        <div class="mt-auto w-full flex flex-col items-center justify-end">
          ${detallesExtraHoraHTML}
        </div>
      `;
    } else {
      bottomContentHTML = `
        <div class="flex flex-col items-center mt-auto w-full">
          ${bloquePrecipitacionHTML}
        </div>
        ${detallesExtraHoraHTML}
      `;
    }

    card.innerHTML = `
      <span class="text-xs ${colorHoraClase} mb-1.5 shrink-0">${etiquetaHora}</span>
      <span class="material-symbols-rounded text-[30px] ${colorIconoClase} mb-1.5 shrink-0">${escaparHTML(hora.icono || 'cloud')}</span>
      <span class="text-[17px] font-semibold ${tempColor} leading-none mb-2 shrink-0">${escaparHTML(hora.temperatura ?? '--')}°</span>
      ${bottomContentHTML}
    `;
    
    carrusel.appendChild(card);
  });

  requestAnimationFrame(() => {
    if (esDiaFuturo && horasArray.length > 0) {
      const targetIndex = horasArray.findIndex(h => {
        const num = h._horaNum ?? parseInt(String(h.hora).split(':')[0], 10);
        return !isNaN(num) && num >= 7;
      });

      if (targetIndex !== -1 && carrusel.children[targetIndex]) {
        const targetEl = carrusel.children[targetIndex];
        const firstEl = carrusel.children[0];
        const scrollPos = Math.max(0, targetEl.offsetLeft - firstEl.offsetLeft - 24);
        carrusel.scrollTo({ left: scrollPos, behavior: 'auto' });
        return;
      }
    }
    
    carrusel.scrollTo({ left: 0, behavior: 'smooth' });
  });
}

function renderizarModoLifestyle(actualSincronizado, proximas24Horas = []) {
  const container = document.getElementById('ui-lifestyle-mode');
  if (!container) return;

  const mode = localStorage.getItem('app_lifestyle_mode');
  if (!mode || mode === 'none') {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  const actual = actualSincronizado || {};
  const getHoraNum = (h) => h?._horaNum ?? extraerNumeroHora(h?.hora) ?? 12;
  const horaActual = getHoraNum(actual);

  let horasEvaluar = [];

  if (mode === 'moto') {
    const ventana12h = [actual, ...proximas24Horas.slice(0, 12)];
    const horasRuta = ventana12h.filter(h => {
      const hn = getHoraNum(h);
      return hn >= 7 || hn === 0;
    });
    horasEvaluar = horasRuta.length > 0 ? horasRuta : ventana12h.slice(0, 6);
  } else if (mode === 'botellon') {
    if (horaActual >= 6 && horaActual < 18) {
      const horasTardeNoche = proximas24Horas.filter(h => {
        const hn = getHoraNum(h);
        return hn >= 18 || hn <= 4;
      }).slice(0, 11);
      horasEvaluar = horasTardeNoche.length > 0 ? horasTardeNoche : [actual, ...proximas24Horas.slice(0, 10)];
    } else {
      const ventanaActual = [actual, ...proximas24Horas.slice(0, 10)].filter(h => {
        const hn = getHoraNum(h);
        return hn >= 18 || hn <= 5;
      });
      horasEvaluar = ventanaActual.length > 0 ? ventanaActual : [actual, ...proximas24Horas.slice(0, 8)];
    }
  }

  const stValores = horasEvaluar.map(h => obtenerNumeroValido(h.sensacion_termica, h.temperatura) ?? 20);
  const minSt = Math.min(...stValores);
  const maxSt = Math.max(...stValores);
  const maxMmLluvia = Math.max(...horasEvaluar.map(h => parsearPrecipitacionMm(h.precipitacion_mm) || 0));
  const maxRacha = Math.max(...horasEvaluar.map(h => obtenerNumeroValido(h.rachas_viento, h.viento_kmh) ?? 0));
  const hayNieve = horasEvaluar.some(h => hayRiesgoRealNieve(h));

  const horasNocturnas = horasEvaluar.filter(h => {
    const hn = getHoraNum(h);
    return hn >= 20 || hn <= 5;
  });
  const maxStNoche = horasNocturnas.length > 0
    ? Math.max(...horasNocturnas.map(h => obtenerNumeroValido(h.sensacion_termica, h.temperatura) ?? 20))
    : 0;

  const dia0 = (currentWeatherData && Array.isArray(currentWeatherData.proximos_dias) && currentWeatherData.proximos_dias[0]) || {};
  const uvMax = obtenerNumeroValido(actual.uv, dia0.uv_max) ?? 0;
  const esHorarioSolTardeo = horaActual >= 11 && horaActual <= 19;

  let titulo = '';
  let mensaje = '';
  let icono = '';

  if (mode === 'moto') {
    titulo = 'Modo Moto';
    icono = 'two_wheeler';

    if (hayNieve) {
      mensaje = 'Posible nieve o hielo en ruta. Mejor deja la moto aparcada hoy, no te la juegues.';
    } else if (maxMmLluvia > 0.1) {
      mensaje = 'Riesgo de lluvia y asfalto mojado en las próximas horas. Tacto con el gas y aumenta la distancia de seguridad.';
    } else if (maxRacha > 35) {
      mensaje = `Viento lateral fuerte previsto (hasta ${maxRacha} km/h). Ojo en puentes y adelantamientos con la moto.`;
    } else if (minSt < 6) {
      mensaje = `Hará un frío que pela (ST bajando a ${minSt}°C). Equípate bien y ten cuidado con las placas de hielo en curva.`;
    } else if (maxSt > 34) {
      mensaje = `Asfalto hirviendo (ST hasta ${maxSt}°C). Vigila presiones y no te ases con la chaqueta.`;
    } else {
      mensaje = 'Condiciones espectaculares para arrancar la moto y salir a curvear. ¡Disfruta de la ruta y V\'s!';
    }
  } else if (mode === 'botellon') {
    titulo = 'Modo Botellón';
    icono = 'local_bar';

    if (maxMmLluvia > 0.1) {
      mensaje = 'Pinta feo en la calle para el plan. Mejor montad un evento bajo techo estilo Pablo\'s House o se os aguará la fiesta.';
    } else if (minSt < 12) {
      mensaje = `Rasquita seria prevista (ST bajando a ${minSt}°C). O llevas buen abrigo a la plaza o tendréis que calentar a base de chupitos.`;
    } else if (maxRacha > 30) {
      mensaje = `Mucho viento previsto (hasta ${maxRacha} km/h). Cuidado en la calle que vuelan los vasos y el hielo.`;
    } else if (esHorarioSolTardeo && uvMax >= 8) {
      mensaje = `Precaución si es tardeo, el sol pega fuerte (UV ${uvMax}). Busca buena sombra o te torrarás vivo.`;
    } else if (maxStNoche > 26 || maxSt > 30) {
      const refTemp = maxStNoche > 26 ? maxStNoche : maxSt;
      mensaje = `Noche tropical (ST ${refTemp}°C). Bebed rápido que los hielos en la calle os van a durar un suspiro.`;
    } else {
      mensaje = 'Clima perfecto para la plaza. Buen rollo, que rule el hielo y no hagáis mucho ruido.';
    }
  }

  container.innerHTML = `
    <div class="px-4 py-3.5 rounded-2xl border border-md-primary/30 bg-md-primary/10 flex items-start gap-3.5 transition-all shadow-sm">
      <span class="material-symbols-rounded text-[28px] text-md-primary shrink-0 mt-0.5">${icono}</span>
      <div class="flex flex-col">
        <span class="font-bold text-xs tracking-wider uppercase text-md-primary opacity-90">${titulo}</span>
        <span class="font-medium text-sm mt-0.5 leading-snug text-text-main">${mensaje}</span>
      </div>
    </div>
  `;
  container.classList.remove('hidden');
}

function formatearFechaActualizacion(isoString) {
  const fecha = isoString ? new Date(isoString) : new Date();
  if (isNaN(fecha.getTime())) return '';

  const ahora = new Date();
  const hh = String(fecha.getHours()).padStart(2, '0');
  const mm = String(fecha.getMinutes()).padStart(2, '0');

  const fechaISO = obtenerFechaLocalISO(fecha);
  const hoyISO = obtenerFechaLocalISO(ahora);

  if (fechaISO === hoyISO) {
    return `Última actualización: hoy a las ${hh}:${mm}`;
  }

  const ayer = new Date(ahora);
  ayer.setDate(ahora.getDate() - 1);
  if (fechaISO === obtenerFechaLocalISO(ayer)) {
    return `Última actualización: ayer a las ${hh}:${mm}`;
  }

  const fechaCorta = fecha.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  return `Última actualización: ${fechaCorta} a las ${hh}:${mm}`;
}

function renderizarUI() {
  if (!currentWeatherData) return;
  const data = currentWeatherData;

  const { actualSincronizado, proximas24Horas } = obtenerEstadoSincronizado(data);

  document.getElementById('ui-municipio').textContent = obtenerNombreMunicipioLimpio(data);
  document.getElementById('ui-temp-actual').textContent = actualSincronizado.temperatura ?? '--';
  document.getElementById('ui-desc-actual').textContent = repararTextoMojibake(actualSincronizado.estado_cielo ?? '--');
  
  // Mostrar Temperatura Máxima y Mínima de hoy en la tarjeta principal
  const tmaxminEl = document.getElementById('ui-tmaxmin-actual');
  const dia0 = (Array.isArray(data.proximos_dias) && data.proximos_dias[0]) || {};
  if (tmaxminEl) {
    const tmax = dia0.temp_max;
    const tmin = dia0.temp_min;
    if (tmax !== undefined && tmin !== undefined && tmax !== '--' && tmin !== '--') {
      tmaxminEl.textContent = `Máx. ${tmax}° · Mín. ${tmin}°`;
      tmaxminEl.classList.remove('hidden');
    } else {
      tmaxminEl.classList.add('hidden');
    }
  }

  document.getElementById('ui-humedad').textContent = `${actualSincronizado.humedad ?? '--'}%`;
  document.getElementById('ui-viento').textContent = `${actualSincronizado.viento_kmh ?? '--'} km/h`;
  document.getElementById('ui-icono-actual').textContent = actualSincronizado.icono || 'cloud';

  const alertasDiv = document.getElementById('ui-alertas');
  const alertasActivas = extraerAlertasActivas(data);

  if (alertasDiv) {
    if (alertasActivas.length > 0) {
      alertasDiv.classList.remove('hidden');
      alertasDiv.classList.add('flex');
      alertasDiv.innerHTML = '';

      alertasActivas.forEach(alerta => {
        const estilos = obtenerEstilosNivelAlerta(alerta.nivel);
        const textoFenomeno = alerta.fenomeno ? ` · ${alerta.fenomeno}` : '';
        const prefijoFuturo = alerta.es_futuro ? 'Próximo ' : '';
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.style.cssText = estilos.badgeStyle;
        badge.className = 'px-3.5 py-1.5 rounded-full flex items-center gap-1.5 text-xs font-semibold shadow-sm transition hover:opacity-90 active:scale-95 cursor-pointer';
        badge.innerHTML = `
          <span class="material-symbols-rounded text-[16px]">warning</span>
          <span>${escaparHTML(prefijoFuturo + estilos.etiquetaCorta + textoFenomeno)}</span>
        `;

        badge.addEventListener('click', () => {
          abrirModalAlerta(alerta, alertasActivas);
        });

        alertasDiv.appendChild(badge);
      });
    } else {
      alertasDiv.classList.add('hidden');
      alertasDiv.classList.remove('flex');
      alertasDiv.innerHTML = '';
    }
  }

  renderizarModoLifestyle(actualSincronizado, proximas24Horas);

  const extraDiv = document.getElementById('ui-datos-extra');
  const showAnyAdv = Object.values(advPrefs).some(Boolean);

  if (showAnyAdv && extraDiv) {
    const { uv, nieveRaw, tormenta, sensacion, racha, direccion } = extraerDatosAvanzadosActuales(data, actualSincronizado);
    const tarjetasExtra = [];

    const crearChipExtra = (icono, etiqueta, valor) => `
      <div class="flex flex-col items-center justify-center gap-1.5 bg-md-surface/75 px-3 py-2.5 rounded-2xl border border-border-color/60 w-[calc(50%-5px)] sm:w-[140px] text-center">
        <div class="flex items-center gap-1.5">
          <span class="material-symbols-rounded text-[18px] text-md-primary shrink-0">${escaparHTML(icono)}</span>
          <span class="text-[10px] font-semibold uppercase tracking-wider text-text-muted leading-none truncate">${escaparHTML(etiqueta)}</span>
        </div>
        <span class="text-[13px] font-semibold text-text-main leading-tight truncate w-full">${escaparHTML(valor)}</span>
      </div>
    `;

    if (advPrefs.sensacion) {
      tarjetasExtra.push(crearChipExtra('thermostat', 'Sensación', sensacion !== undefined ? `${sensacion}°` : '--°'));
    }
    if (advPrefs.uv) {
      tarjetasExtra.push(crearChipExtra('wb_sunny', 'Índice UV', uv !== undefined ? `${uv}` : '--'));
    }
    if (advPrefs.tormenta) {
      tarjetasExtra.push(crearChipExtra('thunderstorm', 'Tormenta', tormenta !== undefined ? `${tormenta}%` : '0%'));
    }
    if (advPrefs.nieve) {
      let valNieve = 'Sin nieve';
      if (nieveRaw !== undefined && nieveRaw !== null && nieveRaw !== 0 && nieveRaw !== '0') {
        valNieve = String(nieveRaw).endsWith('m') ? String(nieveRaw) : `${nieveRaw} m`;
      }
      tarjetasExtra.push(crearChipExtra('ac_unit', 'Cota nieve', valNieve));
    }
    if (advPrefs.viento) {
      const velTxt = racha !== undefined ? `${racha} km/h` : '-- km/h';
      const dirTxt = direccion ? ` ${direccion}` : '';
      tarjetasExtra.push(crearChipExtra('air', 'Rachas viento', `${velTxt}${dirTxt}`));
    }

    // Si solo está activa la precipitación, ocultar el contenedor extra general ya que se muestra en el carrusel
    if (tarjetasExtra.length > 0) {
      extraDiv.classList.remove('hidden');
      extraDiv.classList.add('flex');
      extraDiv.innerHTML = tarjetasExtra.join('');
    } else {
      extraDiv.classList.add('hidden');
      extraDiv.classList.remove('flex');
      extraDiv.innerHTML = '';
    }
  } else if (extraDiv) {
    extraDiv.classList.add('hidden');
    extraDiv.classList.remove('flex');
    extraDiv.innerHTML = '';
  }

  if (diaSeleccionadoIndex !== null && data.proximos_dias?.[diaSeleccionadoIndex]) {
    const diaSel = data.proximos_dias[diaSeleccionadoIndex];
    const horasDiaSel = obtenerHorasParaDia(data, diaSel, diaSeleccionadoIndex);
    if (horasDiaSel.length > 0) {
      renderizarCarrusel(horasDiaSel, `Horas: ${repararTextoMojibake(diaSel.dia_semana)}`, true);
    } else {
      diaSeleccionadoIndex = null;
      renderizarCarrusel(proximas24Horas, 'Próximas horas', false);
    }
  } else {
    renderizarCarrusel(proximas24Horas, 'Próximas horas', false);
  }

  renderizarListaDias(data);

  const actualizacionEl = document.getElementById('ui-ultima-act');
  if (actualizacionEl) {
    actualizacionEl.textContent = formatearFechaActualizacion(data.actualizado_en);
  }
}

function renderizarListaDias(data) {
  const lista = document.getElementById('ui-lista-dias');
  if (!lista || !Array.isArray(data.proximos_dias)) return;
  lista.innerHTML = '';

  data.proximos_dias.forEach((dia, index) => {
    if (index === 0) return;

    const horasDelDia = obtenerHorasParaDia(data, dia, index);
    const hasHoras = horasDelDia.length > 0;
    const isSelected = diaSeleccionadoIndex === index;

    const row = document.createElement('div');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');

    const clasesInteractivas = hasHoras
      ? 'cursor-pointer hover:bg-md-surface-container-high active:bg-md-surface-container-high focus:outline-none focus:ring-1 focus:ring-md-primary'
      : '';
    const clasesSeleccionado = isSelected
      ? 'bg-md-surface-container-high border-l-4 border-l-md-primary'
      : '';

    row.className = `flex justify-between items-center p-4 border-b border-border-color last:border-0 transition-all ${clasesInteractivas} ${clasesSeleccionado}`;

    const ejecutarAccionDia = () => {
      if (!hasHoras) return;
      if (diaSeleccionadoIndex === index) {
        diaSeleccionadoIndex = null;
        renderizarUI();
      } else {
        diaSeleccionadoIndex = index;
        renderizarUI();
        const seccionHoras = document.getElementById('seccion-horas');
        if (seccionHoras) {
          const y = seccionHoras.getBoundingClientRect().top + window.scrollY - 16;
          window.scrollTo({ top: y, behavior: 'smooth' });
        }
      }
    };

    if (hasHoras) {
      row.addEventListener('click', ejecutarAccionDia);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          ejecutarAccionDia();
        }
      });
    }

    const probPrecipDia = parsearProbabilidadPct(dia.prob_precipitacion) ?? 0;

    row.innerHTML = `
      <div class="flex flex-col w-28">
        <span class="font-medium text-text-main leading-tight">${escaparHTML(repararTextoMojibake(dia.dia_semana))}</span>
        ${hasHoras ? `<span class="text-[11px] text-md-primary font-medium mt-0.5">${isSelected ? 'Viendo por horas' : 'Ver por horas'}</span>` : ''}
      </div>
      <div class="flex items-center gap-1.5 w-20">
        <span class="material-symbols-rounded text-md-primary text-[24px]">${escaparHTML(dia.icono || 'cloud')}</span>
        <span class="text-xs font-bold text-text-muted">${probPrecipDia}%</span>
      </div>
      <div class="flex gap-1 text-right w-auto items-center">
        <div class="flex gap-3 w-20 justify-end">
          <span class="font-semibold text-text-main">${escaparHTML(dia.temp_max)}°</span>
          <span class="text-text-muted">${escaparHTML(dia.temp_min)}°</span>
        </div>
        ${hasHoras
          ? `<span class="material-symbols-rounded text-lg ml-1 transition-transform ${isSelected ? 'text-md-primary rotate-90' : 'text-text-muted opacity-70'}">chevron_right</span>`
          : `<span class="w-5 ml-1"></span>`
        }
      </div>
    `;
    lista.appendChild(row);
  });
}

function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function ubicarPorGPS(iconoEl, textoEl, callbackOnSuccess = null) {
  if (!navigator.geolocation) {
    mostrarToast('Tu navegador no soporta geolocalización', 'location_disabled');
    return;
  }
  if (municipiosCargando || municipiosDB.length === 0) {
    mostrarToast('Cargando municipios, inténtalo en un segundo...', 'hourglass_empty');
    return;
  }

  const textoOriginal = textoEl.textContent;
  iconoEl.textContent = 'sync';
  iconoEl.classList.add('animate-spin');
  textoEl.textContent = 'Buscando tu zona...';

  navigator.geolocation.getCurrentPosition((position) => {
    let municipioMasCercano = null;
    let distanciaMinima = Infinity;

    municipiosDB.forEach(m => {
      if (m.lat && m.lon) {
        const dist = calcularDistancia(position.coords.latitude, position.coords.longitude, m.lat, m.lon);
        if (dist < distanciaMinima) {
          distanciaMinima = dist;
          municipioMasCercano = m;
        }
      }
    });

    iconoEl.textContent = 'my_location';
    iconoEl.classList.remove('animate-spin');
    textoEl.textContent = textoOriginal;

    if (municipioMasCercano) {
      if (callbackOnSuccess) {
        callbackOnSuccess(municipioMasCercano.id_ine);
      } else {
        window.seleccionarMunicipio(municipioMasCercano.id_ine);
      }
    }
  }, () => {
    mostrarToast('Activa el permiso de ubicación en tu navegador', 'location_off');
    iconoEl.textContent = 'my_location';
    iconoEl.classList.remove('animate-spin');
    textoEl.textContent = textoOriginal;
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const bottomNav = document.getElementById('bottom-nav');
  const welcomeModal = document.getElementById('welcome-modal');
  const btnWelcomeGps = document.getElementById('btn-welcome-gps');
  const btnWelcomeSearch = document.getElementById('btn-welcome-search');
  const iconoWelcomeGps = document.getElementById('icono-welcome-gps');
  const textoWelcomeGps = document.getElementById('texto-welcome-gps');
  const welcomeHintContainer = document.getElementById('welcome-hint-container');
  const welcomePrivacyLink = document.getElementById('welcome-privacy-link');

  const uiMunicipioWrap = document.getElementById('ui-municipio-wrap');
  const btnTiempo = document.getElementById('btn-tiempo');
  const btnVolverHoy = document.getElementById('btn-volver-hoy');
  const btnSearch = document.getElementById('btn-search');
  const searchModal = document.getElementById('search-modal');
  const btnCloseSearch = document.getElementById('btn-close-search');
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');

  const btnGps = document.getElementById('btn-gps');
  const iconoGps = document.getElementById('icono-gps');
  const textoGps = document.getElementById('texto-gps');

  const btnOptions = document.getElementById('btn-options');
  const btnCloseOptions = document.getElementById('btn-close-options');
  const optionsModal = document.getElementById('options-modal');
  const optionsOverlay = document.getElementById('options-overlay');
  const optionsPanel = document.getElementById('options-panel');
  const themeBtns = document.querySelectorAll('.theme-btn');
  const colorBtns = document.querySelectorAll('.color-btn');
  const colorPicker = document.getElementById('custom-color-picker');
  const customColorPreview = document.getElementById('custom-color-preview');

  const btnToggleAdvMenu = document.getElementById('btn-toggle-advanced-menu');
  const advMenuIcon = document.getElementById('advanced-menu-icon');
  const advOptionsList = document.getElementById('advanced-options-list');
  const advCheckboxes = document.querySelectorAll('.adv-pref-checkbox');

  const btnModeMoto = document.getElementById('btn-mode-moto');
  const btnModeBotellon = document.getElementById('btn-mode-botellon');

  const pwaInstallSection = document.getElementById('pwa-install-section');
  const btnInstallPwa = document.getElementById('btn-install-pwa');
  const btnShareApp = document.getElementById('btn-share-app');
  const iosPwaModal = document.getElementById('ios-pwa-modal');
  const btnCloseIosModal = document.getElementById('btn-close-ios-modal');
  const btnOkIosModal = document.getElementById('btn-ok-ios-modal');

  const btnPrivacy = document.getElementById('btn-privacy');
  const privacyModal = document.getElementById('privacy-modal');
  const privacyModalPanel = document.getElementById('privacy-modal-panel');
  const btnClosePrivacyModal = document.getElementById('btn-close-privacy-modal');
  const btnOkPrivacyModal = document.getElementById('btn-ok-privacy-modal');

  const alertModal = document.getElementById('alert-modal');
  const btnCloseAlertModal = document.getElementById('btn-close-alert-modal');
  const btnOkAlertModal = document.getElementById('btn-ok-alert-modal');

  const btnForceUpdate = document.getElementById('btn-force-update');
  
  const btnFaq = document.getElementById('btn-faq');
  const faqModal = document.getElementById('faq-modal');
  const faqModalPanel = document.getElementById('faq-modal-panel');
  const btnCloseFaqModal = document.getElementById('btn-close-faq-modal');
  const btnOkFaqModal = document.getElementById('btn-ok-faq-modal');

  const timeoutModal = document.getElementById('timeout-modal');
  const btnReloadApp = document.getElementById('btn-reload-app');
  const btnResetApp = document.getElementById('btn-reset-app');
  const btnCloseTimeout = document.getElementById('btn-close-timeout');

  if (btnReloadApp) {
    btnReloadApp.addEventListener('click', () => {
      window.location.reload();
    });
  }

  if (btnResetApp) {
    btnResetApp.addEventListener('click', () => {
      localStorage.clear();
      sessionStorage.clear();
      window.location.reload();
    });
  }

  if (btnCloseTimeout) {
    btnCloseTimeout.addEventListener('click', () => {
      const panel = document.getElementById('timeout-modal-panel');
      timeoutModal.classList.add('opacity-0');
      if (panel) panel.classList.add('scale-95');
      setTimeout(() => {
        timeoutModal.classList.add('hidden');
        timeoutModal.classList.remove('flex');
        actualizarBloqueoScrollBody();
      }, 300);
    });
  }

  const carruselHoras = document.getElementById('ui-carrusel-horas');
  if (carruselHoras) {
    habilitarScrollArrastre(carruselHoras);
  }

  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  if (welcomeHintContainer) {
    if (isMobile) {
      welcomeHintContainer.innerHTML = `
        <span class="material-symbols-rounded text-md-primary shrink-0 mt-0.5 text-[22px]">app_shortcut</span>
        <p class="text-xs text-text-main leading-snug">
          <strong>Instala la app:</strong> Desde el menú de opciones puedes instalar Pablómetro para mantenerla en tu pantalla de inicio.
        </p>
      `;
    } else {
      welcomeHintContainer.innerHTML = `
        <span class="material-symbols-rounded text-md-primary shrink-0 mt-0.5 text-[22px]">desktop_windows</span>
        <p class="text-xs text-text-main leading-snug">
          <strong>Aviso sobre PC:</strong> Esta aplicación está optimizada y pensada para dispositivos móviles, pero puedes utilizarla igualmente en tu ordenador sin problema.
        </p>
      `;
    }
  }

  const openPrivacyModal = () => {
    privacyModal.classList.remove('hidden');
    privacyModal.classList.add('flex');
    void privacyModal.offsetWidth;
    privacyModal.classList.remove('opacity-0');
    if (privacyModalPanel) privacyModalPanel.classList.remove('scale-95');
    actualizarBloqueoScrollBody();
  };

  const closePrivacyModal = () => {
    privacyModal.classList.add('opacity-0');
    if (privacyModalPanel) privacyModalPanel.classList.add('scale-95');
    setTimeout(() => {
      privacyModal.classList.add('hidden');
      privacyModal.classList.remove('flex');
      actualizarBloqueoScrollBody();
    }, 300);
  };

  if (btnClosePrivacyModal) btnClosePrivacyModal.addEventListener('click', closePrivacyModal);
  if (btnOkPrivacyModal) btnOkPrivacyModal.addEventListener('click', closePrivacyModal);
  if (privacyModal) {
    privacyModal.addEventListener('click', (e) => {
      if (e.target === privacyModal) closePrivacyModal();
    });
  }

  if (welcomePrivacyLink) {
    welcomePrivacyLink.addEventListener('click', openPrivacyModal);
  }

  const openFaqModal = () => {
    faqModal.classList.remove('hidden');
    faqModal.classList.add('flex');
    void faqModal.offsetWidth;
    faqModal.classList.remove('opacity-0');
    if (faqModalPanel) faqModalPanel.classList.remove('scale-95');
    actualizarBloqueoScrollBody();
  };

  const closeFaqModal = () => {
    faqModal.classList.add('opacity-0');
    if (faqModalPanel) faqModalPanel.classList.add('scale-95');
    setTimeout(() => {
      faqModal.classList.add('hidden');
      faqModal.classList.remove('flex');
      actualizarBloqueoScrollBody();
    }, 300);
  };

  if (btnCloseFaqModal) btnCloseFaqModal.addEventListener('click', closeFaqModal);
  if (btnOkFaqModal) btnOkFaqModal.addEventListener('click', closeFaqModal);
  if (faqModal) {
    faqModal.addEventListener('click', (e) => {
      if (e.target === faqModal) closeFaqModal();
    });
  }

  if (btnFaq) {
    btnFaq.addEventListener('click', () => {
      trackEvent('options_menu_click', { button: 'faq' });
      closeOptionsModal(true);
      openFaqModal();
    });
  }

  const closeSearchModal = (volverATiempo = true) => {
    if (!searchModal || searchModal.classList.contains('hidden')) return;
    searchModal.classList.add('hidden');
    searchModal.classList.remove('flex');
    searchInput.value = '';
    searchResults.innerHTML = '';
    btnGps.classList.remove('hidden');

    if (!localStorage.getItem('saved_ine')) {
      welcomeModal.classList.remove('hidden');
      welcomeModal.classList.add('flex');
    } else if (volverATiempo) {
      actualizarBarraNavegacion('tiempo');
    }
    actualizarBloqueoScrollBody();
  };

  const closeOptionsModal = (volverATiempo = true) => {
    if (!optionsModal || optionsModal.classList.contains('hidden')) return;
    optionsOverlay.classList.add('opacity-0');
    optionsPanel.classList.add('translate-y-full');
    if (volverATiempo) actualizarBarraNavegacion('tiempo');
    setTimeout(() => {
      optionsModal.classList.add('hidden');
      optionsModal.classList.remove('flex');
      actualizarBloqueoScrollBody();
    }, 300);
  };

  const closeIosModal = () => {
    if (!iosPwaModal || iosPwaModal.classList.contains('hidden')) return;
    iosPwaModal.classList.add('opacity-0');
    setTimeout(() => {
      iosPwaModal.classList.add('hidden');
      iosPwaModal.classList.remove('flex');
      actualizarBloqueoScrollBody();
    }, 300);
  };

  if (btnCloseOptions) btnCloseOptions.addEventListener('click', () => closeOptionsModal(true));
  if (btnCloseAlertModal) btnCloseAlertModal.addEventListener('click', cerrarModalAlerta);
  if (btnOkAlertModal) btnOkAlertModal.addEventListener('click', cerrarModalAlerta);
  if (alertModal) {
    alertModal.addEventListener('click', (e) => {
      if (e.target === alertModal) cerrarModalAlerta();
    });
  }

  if (btnVolverHoy) {
    btnVolverHoy.addEventListener('click', () => {
      diaSeleccionadoIndex = null;
      renderizarUI();
    });
  }

  if (btnTiempo) {
    btnTiempo.addEventListener('click', () => {
      closeSearchModal(false);
      closeOptionsModal(false);
      closeIosModal();
      cerrarModalAlerta();
      actualizarBarraNavegacion('tiempo');
      if (currentWeatherData) {
        diaSeleccionadoIndex = null;
        renderizarUI();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  if (btnForceUpdate) {
    btnForceUpdate.addEventListener('click', () => {
      const savedIne = localStorage.getItem('saved_ine');
      if (savedIne) {
        mostrarToast('Actualizando datos...', 'sync');
        cargarTiempo(savedIne, false, true);
      }
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const savedIne = localStorage.getItem('saved_ine');
      if (savedIne && (Date.now() - lastFetchTimestamp > MAX_DATA_AGE_MS)) {
        cargarTiempo(savedIne, true);
      } else if (currentWeatherData) {
        renderizarUI();
      }
    }
  });

  const renderizarMunicipiosRecientes = () => {
    const recientes = obtenerMunicipiosRecientes();
    if (recientes.length === 0) {
      searchResults.innerHTML = '';
      return;
    }

    searchResults.innerHTML = `
      <div class="px-4 pt-4 pb-2 flex items-center justify-between">
        <span class="text-xs font-semibold uppercase tracking-wider text-text-muted">Consultados recientemente</span>
        <button type="button" id="btn-clear-recents" class="text-xs font-semibold text-md-primary hover:opacity-80 transition">Borrar</button>
      </div>
      ${recientes.map(m => `
        <div class="p-4 flex items-center justify-between border-b border-border-color active:bg-md-surface-container hover:bg-md-surface-container/50 cursor-pointer transition"
             data-ine="${escaparHTML(m.id_ine)}" role="button" tabindex="0">
          <div class="flex items-center gap-3 min-w-0">
            <span class="material-symbols-rounded text-text-muted text-[20px] shrink-0">schedule</span>
            <div class="flex flex-col min-w-0">
              <span class="font-medium text-base text-text-main truncate">${escaparHTML(m.nombre)}</span>
              <span class="text-xs text-text-muted truncate">${escaparHTML(m.provincia || '')}</span>
            </div>
          </div>
          <span class="material-symbols-rounded text-text-muted text-lg shrink-0">chevron_right</span>
        </div>
      `).join('')}
    `;

    const btnClear = document.getElementById('btn-clear-recents');
    if (btnClear) {
      btnClear.addEventListener('click', (e) => {
        e.stopPropagation();
        localStorage.removeItem('recent_municipios');
        searchResults.innerHTML = '';
      });
    }
  };

  const abrirModalBuscador = () => {
    closeOptionsModal(false);
    cerrarModalAlerta();
    actualizarBarraNavegacion('buscar');
    searchModal.classList.remove('hidden');
    searchModal.classList.add('flex');
    actualizarBloqueoScrollBody();
    searchInput.focus();
    if (searchInput.value.trim() === '') {
      renderizarMunicipiosRecientes();
    } else if (municipiosCargando) {
      searchResults.innerHTML = `<div class="p-6 text-center text-text-muted text-sm">Preparando lista de municipios...</div>`;
    }
  };

  if (uiMunicipioWrap) {
    uiMunicipioWrap.addEventListener('click', abrirModalBuscador);
  }

  if (btnWelcomeSearch) {
    btnWelcomeSearch.addEventListener('click', () => {
      welcomeModal.classList.add('hidden');
      welcomeModal.classList.remove('flex');
      abrirModalBuscador();
    });
  }

  if (btnWelcomeGps) {
    btnWelcomeGps.addEventListener('click', () => {
      ubicarPorGPS(iconoWelcomeGps, textoWelcomeGps, (ine) => {
        trackEvent('use_gps', { location_id: ine });
        window.seleccionarMunicipio(ine);
      });
    });
  }

  const renderizarResultadosBusqueda = (queryRaw) => {
    const query = normalizarTexto(queryRaw);
    if (query.length > 0) {
      btnGps.classList.add('hidden');
    } else {
      btnGps.classList.remove('hidden');
      renderizarMunicipiosRecientes();
      return;
    }

    if (municipiosCargando) {
      searchResults.innerHTML = `
        <div class="p-8 text-center text-text-muted flex flex-col items-center gap-2">
          <span class="material-symbols-rounded animate-spin text-md-primary text-3xl">sync</span>
          <span>Cargando base de datos de municipios...</span>
        </div>
      `;
      return;
    }

    if (query.length < 2) {
      searchResults.innerHTML = '';
      return;
    }

    const candidatos = [];
    for (const m of municipiosDB) {
      let score = 0;
      if (m._nombreNorm === query) score = 100;
      else if (m._nombreNorm.startsWith(query)) score = 80;
      else if (m._nombreNorm.includes(' ' + query) || m._nombreNorm.includes('-' + query) || m._nombreNorm.includes('/' + query)) score = 60;
      else if (m._nombreNorm.includes(query)) score = 40;
      else if (m._provNorm.startsWith(query)) score = 25;
      else if (m._provNorm.includes(query)) score = 15;

      if (score > 0) {
        candidatos.push({ m, score });
      }
    }

    candidatos.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.m.nombre.localeCompare(b.m.nombre, 'es');
    });

    const filtrados = candidatos.slice(0, 15).map(item => item.m);

    if (filtrados.length === 0) {
      searchResults.innerHTML = `<div class="p-8 text-center text-text-muted">No se encontraron municipios para "${escaparHTML(queryRaw)}"</div>`;
      return;
    }

    searchResults.innerHTML = filtrados.map(m => `
      <div class="p-4 flex flex-col border-b border-border-color active:bg-md-surface-container hover:bg-md-surface-container/50 cursor-pointer transition"
           data-ine="${escaparHTML(m.id_ine)}" role="button" tabindex="0">
        <span class="font-medium text-lg text-text-main">${escaparHTML(m.nombre)}</span>
        <span class="text-sm text-text-muted">${escaparHTML(m.provincia)}</span>
      </div>
    `).join('');
  };

  if (searchResults) {
    searchResults.addEventListener('click', (e) => {
      const item = e.target.closest('[data-ine]');
      if (item && item.dataset.ine) {
        window.seleccionarMunicipio(item.dataset.ine);
      }
    });
    searchResults.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const item = e.target.closest('[data-ine]');
        if (item && item.dataset.ine) {
          window.seleccionarMunicipio(item.dataset.ine);
        }
      }
    });
  }

  if (btnSearch) {
    btnSearch.addEventListener('click', abrirModalBuscador);
  }

  if (btnCloseSearch) btnCloseSearch.addEventListener('click', () => closeSearchModal(true));

  if (btnGps) {
    btnGps.addEventListener('click', () => {
      ubicarPorGPS(iconoGps, textoGps, (ine) => {
        trackEvent('use_gps', { location_id: ine });
        window.seleccionarMunicipio(ine);
      });
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', (e) => renderizarResultadosBusqueda(e.target.value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const primerResultado = searchResults.querySelector('[data-ine]');
        if (primerResultado && primerResultado.dataset.ine) {
          window.seleccionarMunicipio(primerResultado.dataset.ine);
        }
      }
    });
  }

  window.seleccionarMunicipio = (ine) => {
    const ineNormalizado = String(ine).padStart(5, '0');
    closeSearchModal(true);

    const munData = municipiosDB.find(m => m.id_ine === ineNormalizado);
    const nombreMun = munData ? munData.nombre : ineNormalizado;
    trackEvent('select_location', { location_id: ineNormalizado, location_name: nombreMun });

    if (welcomeModal && !welcomeModal.classList.contains('hidden')) {
      welcomeModal.classList.add('hidden');
      welcomeModal.classList.remove('flex');
      if (bottomNav) {
        bottomNav.classList.remove('hidden');
        bottomNav.classList.add('flex');
      }
      actualizarBloqueoScrollBody();
    }

    document.getElementById('ui-municipio').textContent = munData ? munData.nombre : 'Cargando...';
    cargarTiempo(ineNormalizado);
  };

  if (btnOptions) {
    btnOptions.addEventListener('click', () => {
      closeSearchModal(false);
      cerrarModalAlerta();
      actualizarBarraNavegacion('opciones');
      optionsModal.classList.remove('hidden');
      optionsModal.classList.add('flex');
      void optionsModal.offsetWidth;
      optionsOverlay.classList.remove('opacity-0');
      optionsPanel.classList.remove('translate-y-full');
      actualizarBloqueoScrollBody();
    });
  }

  if (optionsOverlay) optionsOverlay.addEventListener('click', () => closeOptionsModal(true));

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone && pwaInstallSection) pwaInstallSection.classList.add('hidden');

  if (btnInstallPwa) {
    btnInstallPwa.addEventListener('click', async () => {
      trackEvent('options_menu_click', { button: 'install_pwa' });
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (isIOS) {
        closeOptionsModal(true);
        iosPwaModal.classList.remove('hidden');
        iosPwaModal.classList.add('flex');
        void iosPwaModal.offsetWidth;
        iosPwaModal.classList.remove('opacity-0');
        actualizarBloqueoScrollBody();
      } else if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
          deferredInstallPrompt = null;
          closeOptionsModal(true);
        }
      } else {
        mostrarToast('Abre el menú del navegador (⋮) y pulsa "Instalar aplicación"', 'install_mobile');
      }
    });
  }

  if (btnShareApp) {
    btnShareApp.addEventListener('click', async () => {
      trackEvent('options_menu_click', { button: 'share_app' });
      const shareData = {
        title: 'Pablómetro',
        text: 'El tiempo oficial de la AEMET, pero con buen gusto.',
        url: window.location.origin + window.location.pathname
      };

      if (navigator.share) {
        try {
          await navigator.share(shareData);
        } catch (err) {
          if (err.name !== 'AbortError') {
            mostrarToast('No se pudo abrir el menú de compartir', 'error');
          }
        }
      } else if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(shareData.url);
          closeOptionsModal(true);
          mostrarToast('Enlace copiado al portapapeles', 'content_copy');
        } catch {
          mostrarToast('No se pudo copiar el enlace', 'error');
        }
      }
    });
  }

  if (btnCloseIosModal) btnCloseIosModal.addEventListener('click', closeIosModal);
  if (btnOkIosModal) btnOkIosModal.addEventListener('click', closeIosModal);

  if (btnPrivacy) {
    btnPrivacy.addEventListener('click', () => {
      trackEvent('options_menu_click', { button: 'privacy_cookies' });
      closeOptionsModal(true);
      openPrivacyModal();
    });
  }

  document.getElementById('btn-contact-email')?.addEventListener('click', () => {
    trackEvent('options_menu_click', { button: 'contact_email' });
  });

  document.getElementById('btn-instagram')?.addEventListener('click', () => {
    trackEvent('options_menu_click', { button: 'instagram' });
  });

  document.getElementById('btn-aemet-link')?.addEventListener('click', () => {
    trackEvent('options_menu_click', { button: 'aemet_info' });
  });

  const updateSettingsUI = () => {
    const currentTheme = localStorage.getItem('app_theme') || 'system';
    const currentColor = localStorage.getItem('app_color') || 'blue';
    const currentLifestyleMode = localStorage.getItem('app_lifestyle_mode') || 'none';

    themeBtns.forEach(btn => {
      btn.dataset.active = btn.dataset.themeVal === currentTheme ? 'true' : 'false';
    });

    colorBtns.forEach(btn => {
      let isActive = false;
      if (btn.dataset.colorVal === 'custom') {
        isActive = currentColor.startsWith('#');
        if (isActive) {
          customColorPreview.style.background = currentColor;
          window.applyCustomColor(currentColor);
        }
      } else {
        isActive = btn.dataset.colorVal === currentColor;
      }
      btn.dataset.active = isActive ? 'true' : 'false';
    });

    if (btnModeMoto) {
      btnModeMoto.dataset.active = currentLifestyleMode === 'moto' ? 'true' : 'false';
    }
    if (btnModeBotellon) {
      btnModeBotellon.dataset.active = currentLifestyleMode === 'botellon' ? 'true' : 'false';
    }

    actualizarThemeColorNavegador();
  };

  const toggleLifestyleMode = (mode) => {
    const currentMode = localStorage.getItem('app_lifestyle_mode');
    if (currentMode === mode) {
      localStorage.setItem('app_lifestyle_mode', 'none');
      trackEvent('toggle_lifestyle_mode', { mode: mode, enabled: false });
    } else {
      localStorage.setItem('app_lifestyle_mode', mode);
      trackEvent('toggle_lifestyle_mode', { mode: mode, enabled: true });
    }
    updateSettingsUI();
    if (currentWeatherData) renderizarUI();
  };

  if (btnModeMoto) btnModeMoto.addEventListener('click', () => toggleLifestyleMode('moto'));
  if (btnModeBotellon) btnModeBotellon.addEventListener('click', () => toggleLifestyleMode('botellon'));

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const currentColor = localStorage.getItem('app_color') || 'blue';
    if (currentColor.startsWith('#')) window.applyCustomColor(currentColor);
    actualizarThemeColorNavegador();
  });

  themeBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const val = e.currentTarget.dataset.themeVal;
      localStorage.setItem('app_theme', val);
      trackEvent('change_theme', { theme: val });
      if (val === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', val);
      updateSettingsUI();
    });
  });

  colorBtns.forEach(btn => {
    if (btn.dataset.colorVal !== 'custom') {
      btn.addEventListener('click', (e) => {
        const val = e.currentTarget.dataset.colorVal;
        localStorage.setItem('app_color', val);
        trackEvent('change_color', { color: val });
        document.documentElement.setAttribute('data-color', val);
        document.documentElement.style.removeProperty('--md-primary');
        updateSettingsUI();
      });
    }
  });

  if (colorPicker) {
    const savedColorInit = localStorage.getItem('app_color') || 'blue';
    if (savedColorInit.startsWith('#')) colorPicker.value = savedColorInit;

    colorPicker.addEventListener('input', (e) => {
      const hex = e.target.value;
      document.documentElement.setAttribute('data-color', 'custom');
      customColorPreview.style.background = hex;
      window.applyCustomColor(hex);
    });

    colorPicker.addEventListener('change', (e) => {
      const hex = e.target.value;
      localStorage.setItem('app_color', hex);
      trackEvent('change_color', { color: 'custom', hex_value: hex });
      document.documentElement.setAttribute('data-color', 'custom');
      updateSettingsUI();
    });
  }

  if (btnToggleAdvMenu) {
    btnToggleAdvMenu.addEventListener('click', () => {
      advOptionsList.classList.toggle('hidden');
      advOptionsList.classList.toggle('flex');
      advMenuIcon.style.transform = advOptionsList.classList.contains('hidden')
        ? 'rotate(0deg)'
        : 'rotate(180deg)';
    });
  }

  advCheckboxes.forEach(checkbox => {
    const key = checkbox.dataset.key;
    checkbox.checked = Boolean(advPrefs[key]);

    checkbox.addEventListener('change', (e) => {
      advPrefs[key] = e.target.checked;
      localStorage.setItem('app_advanced_prefs', JSON.stringify(advPrefs));
      trackEvent('toggle_adv_weather', { option: key, enabled: e.target.checked });
      if (currentWeatherData) renderizarUI();
    });
  });

  updateSettingsUI();
  actualizarBarraNavegacion('tiempo');

  /* --- CIERRE DE MODALES CON TECLA ESCAPE --- */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSearchModal(true);
      closeOptionsModal(true);
      closeIosModal();
      closePrivacyModal();
      closeFaqModal();
      cerrarModalAlerta();
    }
  });

  const cargarMunicipiosDB = async () => {
    registrarTareaCarga();
    try {
      const res = await fetch('municipios.json');
      if (res.ok) {
        const rawData = await res.json();
        municipiosDB = rawData.map(m => {
          const nombreLimpio = repararTextoMojibake(m.nombre);
          const provLimpia = repararTextoMojibake(m.provincia);
          return {
            ...m,
            id_ine: String(m.id_ine).padStart(5, '0'),
            nombre: nombreLimpio,
            provincia: provLimpia,
            _nombreNorm: normalizarTexto(nombreLimpio),
            _provNorm: normalizarTexto(provLimpia)
          };
        });
        if (currentWeatherData) {
          document.getElementById('ui-municipio').textContent = obtenerNombreMunicipioLimpio(currentWeatherData);
          guardarMunicipioReciente(currentWeatherData?.municipio?.id_ine || localStorage.getItem('saved_ine'));
        }
      }
    } catch (error) {
      console.error('No se pudo cargar la base de datos de municipios', error);
      mostrarToast('Error al cargar la lista de municipios', 'error');
    } finally {
      municipiosCargando = false;
      if (searchModal && !searchModal.classList.contains('hidden')) {
        renderizarResultadosBusqueda(searchInput.value);
      }
      finalizarTareaCarga();
    }
  };

  const iniciarApp = () => {
    const savedIne = localStorage.getItem('saved_ine');

    if (!savedIne) {
      welcomeModal.classList.remove('hidden');
      welcomeModal.classList.add('flex');
      if (bottomNav) {
        bottomNav.classList.add('hidden');
        bottomNav.classList.remove('flex');
      }
      actualizarBloqueoScrollBody();
      
      // Cargar municipios de forma diferida si ya hay guardado o tras la interacción inicial
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => cargarMunicipiosDB());
      } else {
        setTimeout(cargarMunicipiosDB, 1000);
      }
    } else {
      cargarTiempo(savedIne);
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => cargarMunicipiosDB());
      } else {
        setTimeout(cargarMunicipiosDB, 1000);
      }
    }
  };

  iniciarApp();
});