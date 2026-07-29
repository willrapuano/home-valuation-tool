import { describe, expect, it } from "vitest";
import { parseGeocodeResponse } from "./geocode";

/**
 * Parsing the Census geocoder's CSV. The failure that matters is silent:
 * the coordinate pair is LONGITUDE FIRST, and reading it the usual way puts
 * every Virginia property somewhere in Central Asia — with no error, just
 * comps that score as impossibly distant.
 */

const row = (id: string, status: string, coords = "") =>
  `"${id}","1 Main St, Arlington, VA, 22207","${status}","Exact",` +
  `"1 MAIN ST, ARLINGTON, VA, 22207","${coords}","76468266","L"`;

describe("parseGeocodeResponse", () => {
  it("reads longitude first, latitude second", () => {
    const { matched } = parseGeocodeResponse(row("a", "Match", "-77.108373,38.896492"));
    expect(matched.get("a")).toEqual({ lat: 38.896492, lng: -77.108373 });
  });

  it("puts the result in Virginia, not Central Asia", () => {
    // The assertion above would also pass with the fields swapped if the
    // numbers were similar. These are not: swapping lands at 77°E, 38°N.
    const { matched } = parseGeocodeResponse(row("a", "Match", "-77.108373,38.896492"));
    const p = matched.get("a")!;
    expect(p.lng).toBeLessThan(0);
    expect(p.lat).toBeGreaterThan(0);
  });

  it("collects unmatched addresses rather than dropping them", () => {
    // An address the geocoder cannot place must be reported: silently losing a
    // third of an ingest looks identical to a small county.
    const body = [
      row("a", "Match", "-77.1,38.9"),
      `"b","x","No_Match","","","","",""`,
      `"c","x","Tie","","","","",""`,
    ].join("\n");

    const { matched, unmatched } = parseGeocodeResponse(body);
    expect([...matched.keys()]).toEqual(["a"]);
    expect(unmatched.sort()).toEqual(["b", "c"]);
  });

  it("treats a match with unusable coordinates as unmatched", () => {
    const { matched, unmatched } = parseGeocodeResponse(row("a", "Match", ","));
    expect(matched.size).toBe(0);
    expect(unmatched).toEqual(["a"]);
  });

  it("handles commas inside quoted address fields", () => {
    // Every address contains commas; a naive split shifts the coordinate
    // column and silently yields nothing.
    const { matched } = parseGeocodeResponse(
      `"a","1 Main St, Apt 2, Arlington, VA, 22207","Match","Exact","1 MAIN ST, ARLINGTON, VA","-77.1,38.9","1","L"`
    );
    expect(matched.get("a")).toEqual({ lat: 38.9, lng: -77.1 });
  });

  it("ignores blank lines", () => {
    const { matched, unmatched } = parseGeocodeResponse(`\n${row("a", "Match", "-77.1,38.9")}\n\n`);
    expect(matched.size).toBe(1);
    expect(unmatched).toEqual([]);
  });
});
