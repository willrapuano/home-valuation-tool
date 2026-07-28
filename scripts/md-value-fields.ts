/**
 * Are the two Maryland layers' value fields interchangeable?
 *
 * The sales layer publishes CURTTLVL ("Current Total Value"), the parcel layer
 * NFMTTLVL ("New Appraised Full Value"). The engine compares the subject's
 * assessment against each comp's, so if these differ systematically, taking
 * the subject from one layer and the comps from the other biases every
 * Maryland estimate. Joins the same accounts across both layers to find out.
 */
const BASE = "https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre";

async function q(layer: string, params: Record<string, string>) {
  const res = await fetch(`${BASE}/${layer}/MapServer/0/query`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ f: "json", ...params }).toString(),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${layer}: ${j.error.message}`);
  return (j.features ?? []) as { attributes: Record<string, unknown> }[];
}

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const PLACES = [
  { name: "Bethesda", x: -77.08292, y: 38.98836 },
  { name: "Frederick", x: -77.4105, y: 39.4143 },
  { name: "Annapolis", x: -76.4922, y: 38.9784 },
  { name: "Salisbury", x: -75.5994, y: 38.3607 },
];

async function main() {
  console.log(`  ${"market".padEnd(12)} ${"n".padStart(5)}  median NFM/CUR   p25    p75   sale/NFM  sale/CUR`);
  console.log("  " + "─".repeat(76));

  for (const p of PLACES) {
    const geometry = JSON.stringify({ x: p.x, y: p.y, spatialReference: { wkid: 4326 } });
    const spatial = {
      geometry,
      geometryType: "esriGeometryPoint",
      distance: "1.0",
      units: "esriSRUnit_StatuteMile",
      spatialRel: "esriSpatialRelIntersects",
      inSR: "4326",
      returnGeometry: "false",
    };

    const sales = await q("MD_PropertySales", {
      ...spatial,
      where: "LU='R' AND CONSIDR1 > 50000 AND CURTTLVL > 0",
      outFields: "ACCTID,CURTTLVL,CONSIDR1",
      resultRecordCount: "400",
    });

    const byAcct = new Map<string, { cur: number; sale: number }>();
    for (const f of sales) {
      const id = String(f.attributes.ACCTID ?? "").trim();
      const cur = Number(f.attributes.CURTTLVL);
      const sale = Number(f.attributes.CONSIDR1);
      if (id && cur > 0 && sale > 0) byAcct.set(id, { cur, sale });
    }

    // Pull the same accounts from the parcel layer.
    const ids = [...byAcct.keys()].slice(0, 150);
    const parcels = await q("MD_PropertyData", {
      where: `ACCTID IN (${ids.map(i => `'${i}'`).join(",")})`,
      outFields: "ACCTID,NFMTTLVL",
      returnGeometry: "false",
      resultRecordCount: "400",
    });

    const ratios: number[] = [];
    const saleOverNfm: number[] = [];
    const saleOverCur: number[] = [];
    for (const f of parcels) {
      const id = String(f.attributes.ACCTID ?? "").trim();
      const nfm = Number(f.attributes.NFMTTLVL);
      const rec = byAcct.get(id);
      if (!rec || !(nfm > 0)) continue;
      ratios.push(nfm / rec.cur);
      saleOverNfm.push(rec.sale / nfm);
      saleOverCur.push(rec.sale / rec.cur);
    }

    if (!ratios.length) {
      console.log(`  ${p.name.padEnd(12)} no overlap`);
      continue;
    }
    const sorted = [...ratios].sort((a, b) => a - b);
    console.log(
      `  ${p.name.padEnd(12)} ${String(ratios.length).padStart(5)}  ` +
        `${med(ratios).toFixed(3).padStart(13)}  ${sorted[Math.floor(sorted.length * 0.25)].toFixed(3)}  ` +
        `${sorted[Math.floor(sorted.length * 0.75)].toFixed(3)}  ` +
        `${med(saleOverNfm).toFixed(3).padStart(8)}  ${med(saleOverCur).toFixed(3).padStart(8)}`
    );
  }

  console.log(
    "\n  NFM/CUR at 1.00 means the two layers agree and can be mixed freely.\n" +
      "  Anything else biases the subject relative to its comps."
  );
}

main().catch(e => {
  console.error(e?.message ?? e);
  process.exit(1);
});
