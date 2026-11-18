// Turns what the tech picked (service, option, gel, add-ons) into one booking
// description for captions and Tina's view. It only uses names and prices from
// lib/brand.json, so captions can't invent prices.

const money = (s) => Number(String(s).replace(/[^0-9.]/g, '')) || 0;

export function resolveBooking(brand, sel = {}) {
  const service = brand.services.find((s) => s.id === sel.serviceId);
  if (!service) return null;
  const option = service.options?.find((o) => o.id === sel.option) || null;
  let price = option?.price || service.price;
  const gel = !!(service.gel && sel.gel);
  if (gel) price = '$' + (money(price) + service.gel);
  if (service.price.endsWith('+') && !price.endsWith('+')) price += '+';

  const addons = (sel.addons || []).map((a) => {
    const def = brand.addons.find((x) => x.id === a.id);
    if (!def) return null;
    const opt = def.options?.find((o) => o.id === a.option) || null;
    let name = def.name;
    if (opt) name = def.id === 'french' ? opt.label + ' French' : /removal/.test(def.id) ? def.name + ' (' + opt.label.toLowerCase() + ')' : opt.label;
    return { id: def.id, option: opt?.id || null, name, price: opt?.price || def.price };
  }).filter(Boolean);

  const name = [service.name, option ? option.label.toLowerCase() : '', gel ? 'with gel' : ''].filter(Boolean).join(', ');
  return {
    serviceId: service.id,
    serviceName: service.name,
    name, // "Acrylic, full set" or "Regular Polish, hands, with gel"
    price, // "$85+"
    group: service.group,
    addons,
    summary: [name, ...addons.map((a) => a.name)].join(' + '),
  };
}

// What the add-ons say about the look, for captions and hashtags.
export function addonAttributes(booking) {
  const out = {};
  for (const a of booking?.addons || []) {
    if (a.id === 'chrome') out.finish = a.option === 'cat-eye' ? 'cat eye' : 'chrome';
    if (a.id === 'finish' && a.option) out.finish = a.option;
    if (a.id === 'french') out.technique = 'french';
    if (a.id === 'nail-art' && !out.technique) out.technique = 'hand-painted art';
  }
  return out;
}
