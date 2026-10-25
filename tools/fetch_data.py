"""Download the raw open data used by build_data.py into data/."""
import os
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, "data")

FILES = {
    "airports.csv": "https://davidmegginson.github.io/ourairports-data/airports.csv",
    "countries.csv": "https://davidmegginson.github.io/ourairports-data/countries.csv",
    "runways.csv": "https://davidmegginson.github.io/ourairports-data/runways.csv",
    "ne_110m_land.geojson":
        "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson",
}


def main():
    os.makedirs(DATA, exist_ok=True)
    for name, url in FILES.items():
        dest = os.path.join(DATA, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            print(f"skip   {name} (already exists)")
            continue
        print(f"fetch  {name} ...")
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = response.read()
        with open(dest, "wb") as handle:
            handle.write(payload)
        print(f"ok     {name} ({len(payload) / 1048576:.2f} MB)")


if __name__ == "__main__":
    main()
