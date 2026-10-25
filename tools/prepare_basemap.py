"""Vendor OpenFreeMap's dark style and tint it to AeroAtlas' navy palette."""
import json, os, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, "data")

COLORS = {
    "background": {"background-color": "#0f2238"},
    "water": {"fill-color": "#050d18"},
    "waterway": {"line-color": "#07121e"},
    "water_name": {"text-color": "#4e6b86", "text-halo-color": "#040a12"},
    "landcover_ice_shelf": {"fill-color": "#0c1a2c"},
    "landcover_glacier": {"fill-color": "#0e1e30"},
    "landuse_residential": {"fill-color": "#0c1928"},
    "landcover_wood": {"fill-color": "#0d2022"},
    "landuse_park": {"fill-color": "#0d2022"},
    "building": {"fill-color": "#070f1a", "fill-outline-color": "#122134"},
    "boundary_state": {"line-color": "#26445f"},
    "boundary_country_z0-4": {"line-color": "#2b4d6b"},
    "boundary_country_z5-": {"line-color": "#2b4d6b"},
    "place_other": {"text-color": "#7f96ae", "text-halo-color": "rgba(3,8,15,0.85)"},
    "place_suburb": {"text-color": "#7f96ae", "text-halo-color": "rgba(3,8,15,0.85)"},
    "place_village": {"text-color": "#7f96ae", "text-halo-color": "rgba(3,8,15,0.85)"},
    "place_town": {"text-color": "#8299b1", "text-halo-color": "rgba(3,8,15,0.85)"},
    "place_city": {"text-color": "#8ba2ba", "text-halo-color": "rgba(3,8,15,0.9)"},
    "place_city_large": {"text-color": "#9db4cb", "text-halo-color": "rgba(3,8,15,0.9)"},
    "place_state": {"text-color": "#6f88a2", "text-halo-color": "rgba(3,8,15,0.85)"},
    "place_country_other": {"text-color": "#8096ad", "text-halo-color": "rgba(3,8,15,0.9)"},
    "place_country_minor": {"text-color": "#8096ad", "text-halo-color": "rgba(3,8,15,0.9)"},
    "place_country_major": {"text-color": "#8fa6bd", "text-halo-color": "rgba(3,8,15,0.9)"},
    "highway_path": {"line-color": "#102033"},
    "highway_minor": {"line-color": "#13263a"},
    "highway_major_casing": {"line-color": "rgba(74,120,165,0.25)"},
    "highway_major_inner": {"line-color": "#182b3f"},
    "highway_major_subtle": {"line-color": "#142538"},
    "highway_motorway_casing": {"line-color": "rgba(90,150,200,0.3)"},
    "highway_motorway_inner": {"line-color": "#1c3247"},
    "highway_motorway_subtle": {"line-color": "#142538"},
    "highway_name_other": {"text-color": "#7088a1", "text-halo-color": "#04080f"},
    "highway_name_motorway": {"text-color": "#6d8aa5"},
    "railway_transit": {"line-color": "#162b40"},
    "railway_transit_dashline": {"line-color": "#08111c"},
    "railway_minor": {"line-color": "#162b40"},
    "railway_minor_dashline": {"line-color": "#08111c"},
    "railway": {"line-color": "#162b40"},
    "railway_dashline": {"line-color": "#08111c"},
    "aeroway-taxiway": {"line-color": "#0a1622"},
    "aeroway-runway-casing": {"line-color": "rgba(70,110,150,0.3)"},
    "aeroway-area": {"fill-color": "#050c14"},
    "aeroway-runway": {"line-color": "#0c1926"},
    "road_area_pier": {"fill-color": "#08111c"},
    "road_pier": {"line-color": "#08111c"},
}

# Layers that add little to an airport atlas but cost draw time, especially
# with the detailed OpenMapTiles vector data.
DROP_LAYERS = {
    "building",
    "railway", "railway_dashline", "railway_minor", "railway_minor_dashline",
    "railway_transit", "railway_transit_dashline",
    "road_oneway", "road_oneway_opposite",
    "highway_path", "highway_name_other", "highway_name_motorway",
    "aeroway-taxiway", "aeroway-runway-casing", "aeroway-area", "aeroway-runway",
    "place_other", "place_state", "water_name", "boundary_state",
}


def main():
    url = "https://tiles.openfreemap.org/styles/dark"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        style = json.loads(response.read())

    style.pop("metadata", None)
    style["name"] = "AeroAtlas Night"
    style["sources"].pop("ne2_shaded", None)

    layers_before = len(style["layers"])
    style["layers"] = [layer for layer in style["layers"] if layer["id"] not in DROP_LAYERS]

    # The hosted sprite no longer ships these images; drop the references so the
    # map renders without missing-image warnings.
    for layer in style["layers"]:
        if layer["id"] == "landcover_wood":
            layer.get("paint", {}).pop("fill-pattern", None)
        if layer["id"].startswith("place_"):
            layout = layer.get("layout", {})
            if "icon-image" in layout:
                layout.pop("icon-image", None)
                layout["text-anchor"] = "center"

    found = set()
    for layer in style["layers"]:
        overrides = COLORS.get(layer["id"])
        if overrides:
            layer.setdefault("paint", {}).update(overrides)
            found.add(layer["id"])

    missing = sorted(set(COLORS) - found - DROP_LAYERS)
    if missing:
        print("WARNING missing layers:", missing)

    icons = [layer["id"] for layer in style["layers"] if "icon-image" in layer.get("layout", {})]
    if not icons:
        style.pop("sprite", None)

    payload = "window.AERO_BASEMAP_STYLE = " + json.dumps(style, separators=(",", ":")) + ";\n"
    out = os.path.join(DATA, "basemap-style.js")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("/* OpenFreeMap dark style, tinted for AeroAtlas. Data (c) OpenStreetMap contributors. */\n")
        fh.write(payload)
    print(f"layers {layers_before} -> {len(style['layers'])}, sprite={'kept' if icons else 'removed'}")
    print(f"written {out} ({os.path.getsize(out)/1024:.0f} KB)")


if __name__ == "__main__":
    main()


