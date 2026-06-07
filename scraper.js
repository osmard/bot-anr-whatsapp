import axios from 'axios';

const BASE = 'https://www.anr.org.py/assets/p2026';

const cache = {
  departamento: null,
  distrito: null,
  local: null,
  duplicado: null,
};

async function loadRefs() {
  if (cache.departamento) return;
  const [dep, dis, loc, dup] = await Promise.all([
    axios.get(`${BASE}/departamento.json`).then(r => r.data),
    axios.get(`${BASE}/distrito.json`).then(r => r.data),
    axios.get(`${BASE}/local.json`).then(r => r.data),
    axios.get(`${BASE}/duplicado.json`).then(r => r.data),
  ]);
  cache.departamento = dep;
  cache.distrito     = dis;
  cache.local        = loc;
  cache.duplicado    = dup;
}

function enrich(d) {
  const depNombre = cache.departamento.find(
    x => x.departamento === d.departamento
  )?.descripcion ?? String(d.departamento);

  const disNombre = cache.distrito.find(
    x => x.distrito === d.distrito && x.departamento === d.departamento
  )?.descripcion ?? String(d.distrito);

  const locNombre = cache.local.find(
    x => x.local === d.local && x.seccional === d.seccional &&
         x.departamento === d.departamento && x.distrito === d.distrito
  )?.descripcion ?? String(d.local);

  const nacFormatted = new Date(`${d.nacimiento}T00:00:00`)
    .toLocaleDateString('es-PY');

  return { ...d, depNombre, disNombre, locNombre, nacFormatted };
}

export async function consultarCI(cedulaRaw) {
  const cedula = cedulaRaw.replace(/\./g, '').trim();
  await loadRefs();

  // Duplicados: múltiples registros para la misma cédula
  const dups = cache.duplicado.filter(x => x.cedula === parseInt(cedula));
  if (dups.length > 0) return dups.map(enrich);

  // Registro único: estructura jerárquica por dígitos
  const path = cedula.substring(0, 4).split('').join('/');
  const { data } = await axios.get(`${BASE}/${path}/${cedula}.json`);
  return [enrich(data)];
}
