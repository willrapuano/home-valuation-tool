/** Raw STRUGRAD / SUBDIVSN values, and the assessed-value outliers. */
const SALES_URL = "https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_PropertySales/MapServer/0/query";

async function q(params: Record<string, string>) {
  const res = await fetch(SALES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ f: "json", ...params }).toString(),
  });
  return res.json();
}

async function main() {
  const bethesda = JSON.stringify({ x: -77.08292, y: 38.98836, spatialReference: { wkid: 4326 } });
  const spatial = {
    geometry: bethesda,
    geometryType: "esriGeometryPoint",
    distance: "2.5",
    units: "esriSRUnit_StatuteMile",
    spatialRel: "esriSpatialRelIntersects",
    inSR: "4326",
  };

  const grades = await q({
    ...spatial,
    where: "LU='R' AND CONSIDR1 > 50000",
    outFields: "STRUGRAD",
    returnGeometry: "false",
    groupByFieldsForStatistics: "STRUGRAD",
    outStatistics: JSON.stringify([{ statisticType: "count", onStatisticField: "ACCTID", outStatisticFieldName: "n" }]),
  });
  console.log("STRUGRAD distribution (Bethesda 2.5mi, residential sales):");
  const gf = (grades.features ?? []).sort((a: any, b: any) => b.attributes.n - a.attributes.n);
  for (const f of gf) console.log(`   grade ${String(f.attributes.STRUGRAD).padStart(6)}  n=${f.attributes.n}`);
  if (grades.error) console.log("  error:", grades.error.message);

  const subs = await q({
    ...spatial,
    where: "LU='R' AND CONSIDR1 > 50000",
    outFields: "SUBDIVSN",
    returnGeometry: "false",
    groupByFieldsForStatistics: "SUBDIVSN",
    outStatistics: JSON.stringify([{ statisticType: "count", onStatisticField: "ACCTID", outStatisticFieldName: "n" }]),
  });
  console.log("\nTop SUBDIVSN codes (Bethesda 2.5mi):");
  const sf = (subs.features ?? []).sort((a: any, b: any) => b.attributes.n - a.attributes.n).slice(0, 10);
  for (const f of sf) console.log(`   code ${String(f.attributes.SUBDIVSN).padStart(6)}  n=${f.attributes.n}`);
  console.log(`   (${(subs.features ?? []).length} distinct codes total)`);

  const wild = await q({
    ...spatial,
    where: "LU='R' AND CONSIDR1 > 50000 AND CURTTLVL > 0 AND CONSIDR1 > CURTTLVL * 5",
    outFields: "ADDRESS,CONSIDR1,CURTTLVL,SQFTSTRC,YEARBLT,TRADATE",
    returnGeometry: "false",
    resultRecordCount: "8",
  });
  console.log("\nSales at >5x assessed value (what is polluting the ratio band):");
  for (const f of wild.features ?? []) {
    const a = f.attributes;
    console.log(
      `   ${String(a.ADDRESS).slice(0, 34).padEnd(34)} sold $${Number(a.CONSIDR1).toLocaleString().padStart(11)}  ` +
        `assessed $${Number(a.CURTTLVL).toLocaleString().padStart(10)}  sqft ${a.SQFTSTRC}  yr ${a.YEARBLT}`
    );
  }
}
main().catch(e => console.error(e));

export {};
