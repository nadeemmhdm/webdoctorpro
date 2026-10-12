export function normalizeDomain(input) {
  const raw = String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/\.$/, '');
  if (!raw || raw.length > 253 || raw.includes(' ') || !raw.includes('.')) throw new Error('Invalid domain');
  const hostname = new URL(`http://${raw}`).hostname;
  if (!/^[a-z0-9.-]+$/.test(hostname) || hostname.includes('..')) throw new Error('Invalid domain');
  return hostname;
}

export function parseRdap(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  const findEvent = (...names) => events.find((e) => names.includes(String(e?.eventAction || '').toLowerCase()))?.eventDate || null;
  const entities = Array.isArray(data?.entities) ? data.entities : [];
  let registrar = null;
  for (const entity of entities) {
    if (!Array.isArray(entity?.roles) || !entity.roles.includes('registrar')) continue;
    const rows = entity?.vcardArray?.[1];
    if (Array.isArray(rows)) registrar = rows.find((r) => Array.isArray(r) && r[0] === 'fn')?.[3] || entity.handle || null;
    else registrar = entity.handle || null;
    if (registrar) break;
  }
  return {
    expiresAt: findEvent('expiration', 'expiry', 'registrar expiration'),
    registeredAt: findEvent('registration', 'registered'),
    lastChangedAt: findEvent('last changed', 'last update of rdap database'),
    registrar,
    status: Array.isArray(data?.status) ? data.status.join(', ') : 'unknown'
  };
}

export function daysUntil(iso, now = Date.now()) {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - now) / 86400000);
}

export function formatInTimezone(iso, timezone) {
  if (!iso) return 'Not published by registry';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    timeZoneName: 'short'
  }).format(new Date(iso));
}

export function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(); return true; } catch { return false; }
}
