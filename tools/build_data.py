"""Build compact airport + basemap data for AeroAtlas from OurAirports CSV dumps."""
import csv, json, os, re, datetime, collections

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, "data")

TYPE_CODE = {
    "large_airport": 1,
    "medium_airport": 2,
    "small_airport": 3,
    "seaplane_base": 4,
    "heliport": 5,
}
TYPE_RANK = {"large_airport": 0, "medium_airport": 1, "small_airport": 2,
             "seaplane_base": 3, "heliport": 4}

SURFACE_MAP = [
    (("ASP", "BIT", "PEM"), "ASP"),
    (("CON", "CEM"), "CON"),
    (("GRE", "GRA", "TUR", "GRS"), "GRS"),
    (("WAT", "WTR"), "WTR"),
    (("GRV", "GRAVEL"), "GRV"),
    (("DIR", "DRT", "EAR"), "DRT"),
    (("SAN",), "SND"),
    (("SNO", "ICE"), "SNO"),
]


def norm_surface(raw):
    s = (raw or "").strip().upper()
    if not s:
        return "UNK"
    for keys, code in SURFACE_MAP:
        if any(s.startswith(k) for k in keys):
            return code
    return re.sub(r"[^A-Z]", "", s)[:4] or "UNK"


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main():
    countries = {}
    with open(os.path.join(DATA, "countries.csv"), encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            countries[row["code"]] = row["name"]

    # ----- runways ---------------------------------------------------------
    runways = collections.defaultdict(list)
    with open(os.path.join(DATA, "runways.csv"), encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row["closed"] == "1":
                continue
            le_lat, le_lon = fnum(row["le_latitude_deg"]), fnum(row["le_longitude_deg"])
            he_lat, he_lon = fnum(row["he_latitude_deg"]), fnum(row["he_longitude_deg"])
            length = fnum(row["length_ft"])
            if None in (le_lat, le_lon, he_lat, he_lon) or not length:
                continue
            runways[row["airport_ident"]].append([
                (row["le_ident"] or "").strip(),
                (row["he_ident"] or "").strip(),
                int(round(length)),
                norm_surface(row["surface"]),
                1 if row["lighted"] == "1" else 0,
                round(le_lat, 5), round(le_lon, 5),
                round(he_lat, 5), round(he_lon, 5),
            ])
    for ident in runways:
        runways[ident].sort(key=lambda r: -r[2])
        del runways[ident][4:]

    # ----- airports --------------------------------------------------------
    best = {}
    with open(os.path.join(DATA, "airports.csv"), encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row["type"] not in TYPE_CODE:
                continue
            code = ""
            for candidate in (row.get("gps_code", ""), row.get("ident", ""), row.get("icao_code", "")):
                candidate = (candidate or "").strip().upper()
                if re.fullmatch(r"[A-Z]{4}", candidate):
                    code = candidate
                    break
            if not code:
                continue
            lat, lon = fnum(row["latitude_deg"]), fnum(row["longitude_deg"])
            if lat is None or lon is None or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
                continue
            if lat == 0 and lon == 0:
                continue
            name = (row["name"] or "").strip()
            if not name:
                continue
            entry = {
                "code": code,
                "name": name,
                "city": (row["municipality"] or "").strip(),
                "country": row["iso_country"] or "",
                "type": row["type"],
                "elev": int(round(fnum(row["elevation_ft"]))) if fnum(row["elevation_ft"]) is not None else None,
                "iata": (row["iata_code"] or "").strip().upper(),
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "sched": row["scheduled_service"] == "yes",
                "runways": runways.get(row["ident"], []),
            }
            prev = best.get(code)
            if prev is None:
                best[code] = entry
            else:
                # Keep the more significant record for duplicated ICAO codes.
                score_new = (entry["sched"], -TYPE_RANK[entry["type"]], len(entry["runways"]))
                score_old = (prev["sched"], -TYPE_RANK[prev["type"]], len(prev["runways"]))
                if score_new > score_old:
                    best[code] = entry

    rows = sorted(best.values(), key=lambda a: (TYPE_RANK[a["type"]], a["code"]))
    airports = []
    for a in rows:
        airports.append([
            a["code"], a["name"], a["city"], a["country"],
            TYPE_CODE[a["type"]], a["elev"], a["iata"],
            a["lat"], a["lon"], 1 if a["sched"] else 0, a["runways"],
        ])

    total = len(airports)
    with_runways = sum(1 for a in airports if a[10])
    country_codes = sorted({a[3] for a in airports if a[3]})
    used_countries = {c: countries.get(c, c) for c in country_codes}
    by_type = collections.Counter(a[4] for a in airports)

    meta = {
        "generated": datetime.date.today().isoformat(),
        "total": total,
        "withRunways": with_runways,
        "countries": used_countries,
        "countryCount": len(country_codes),
        "types": {str(k): v for k, v in sorted(by_type.items())},
        "source": "OurAirports (public domain)",
    }

    payload = "window.AERO_DATA = " + json.dumps(
        {"meta": meta, "airports": airports}, ensure_ascii=False, separators=(",", ":")
    ) + ";\n"
    with open(os.path.join(DATA, "airports.js"), "w", encoding="utf-8") as fh:
        fh.write("/* AeroAtlas global airport index - generated from OurAirports public-domain data */\n")
        fh.write(payload)

    # ----- basemap (offline fallback) -------------------------------------
    def load_geo(name):
        with open(os.path.join(DATA, name), encoding="utf-8") as fh:
            return json.load(fh)

    land = load_geo("ne_110m_land.geojson")

    def slim(feature):
        return {"type": "Feature", "properties": {}, "geometry": feature["geometry"]}

    land_slim = {"type": "FeatureCollection", "features": [slim(f) for f in land["features"]]}

    with open(os.path.join(DATA, "basemap.js"), "w", encoding="utf-8") as fh:
        fh.write("window.AERO_BASEMAP = ")
        fh.write(json.dumps({"land": land_slim}, separators=(",", ":")))
        fh.write(";\n")

    print(f"airports           : {total:,}")
    print(f"with runways       : {with_runways:,}")
    print(f"countries          : {len(country_codes)}")
    print(f"by type            : {dict(by_type)}")
    print(f"airports.js        : {os.path.getsize(os.path.join(DATA, 'airports.js'))/1048576:.2f} MB")
    print(f"basemap.js         : {os.path.getsize(os.path.join(DATA, 'basemap.js'))/1048576:.2f} MB")


if __name__ == "__main__":
    main()
