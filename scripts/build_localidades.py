#!/usr/bin/env python3
"""Genera web/data/localidades_mx.json: localidades de México para describir un punto en el navegador.

Fuente: GeoNames, volcado por país https://download.geonames.org/export/dump/MX.zip
(licencia CC BY 4.0, https://download.geonames.org/export/dump/readme.txt).

Filtro: lugares poblados (clase P) vigentes, con población >= 100 o cabecera (PPLC, PPLA, PPLA2).
Se excluyen los abandonados, destruidos o históricos (PPLQ, PPLW, PPLH). Coordenadas con 3 decimales,
guardadas como enteros en milésimas de grado para que el archivo pese menos (tope ~1.5 MB crudo).
El umbral salió de medir la cobertura a <= 5 km por filtro; con todas las localidades pesaría ~10 MB.

Uso (no forma parte del workflow de la captura; se corre a mano):
    python3 scripts/build_localidades.py            # descarga MX.zip
    python3 scripts/build_localidades.py MX.zip     # usa un volcado ya descargado
"""
import io
import json
import sys
import urllib.request
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

URL = "https://download.geonames.org/export/dump/MX.zip"
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "data" / "localidades_mx.json"
MIN_POP = 100
SEATS = {"PPLC", "PPLA", "PPLA2"}
GONE = {"PPLQ", "PPLW", "PPLH"}
# GeoNames trae la capital con su nombre en inglés; el resto de los nombres ya viene en español.
RENAME = {"Mexico City": "Ciudad de México"}
# Código admin1 de GeoNames -> clave ISO 3166-2 que usa el sitio (mx_states.geojson).
ADMIN1 = {
    "01": "MX-AGU", "02": "MX-BCN", "03": "MX-BCS", "04": "MX-CAM", "05": "MX-CHP", "06": "MX-CHH",
    "07": "MX-COA", "08": "MX-COL", "09": "MX-DIF", "10": "MX-DUR", "11": "MX-GUA", "12": "MX-GRO",
    "13": "MX-HID", "14": "MX-JAL", "15": "MX-MEX", "16": "MX-MIC", "17": "MX-MOR", "18": "MX-NAY",
    "19": "MX-NLE", "20": "MX-OAX", "21": "MX-PUE", "22": "MX-QUE", "23": "MX-ROO", "24": "MX-SLP",
    "25": "MX-SIN", "26": "MX-SON", "27": "MX-TAB", "28": "MX-TAM", "29": "MX-TLA", "30": "MX-VER",
    "31": "MX-YUC", "32": "MX-ZAC",
}


def read_dump(path):
    raw = Path(path).read_bytes() if path else urllib.request.urlopen(URL, timeout=120).read()
    stamp = datetime.fromtimestamp(Path(path).stat().st_mtime, timezone.utc).date() if path else date.today()
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        return z.read("MX.txt").decode("utf-8").splitlines(), stamp


def main():
    lines, stamp = read_dump(sys.argv[1] if len(sys.argv) > 1 else None)
    rows = []
    for line in lines:
        c = line.split("\t")
        if c[6] != "P" or c[7] in GONE or c[10] not in ADMIN1:
            continue
        pop = int(c[14] or 0)
        if pop >= MIN_POP or c[7] in SEATS:
            rows.append((ADMIN1[c[10]], RENAME.get(c[1], c[1]), round(float(c[4]), 3), round(float(c[5]), 3), pop))
    # Duplicados (mismo estado, nombre y ~1 km): se queda el de mayor población.
    rows.sort(key=lambda r: (r[0], r[1], -r[4], r[2], r[3]))
    seen, states = set(), {}
    for state, name, lat, lon, _ in rows:
        key = (state, name, round(lat, 2), round(lon, 2))
        if key in seen:
            continue
        seen.add(key)
        states.setdefault(state, []).append([name, round(lat * 1000), round(lon * 1000)])
    data = {
        "fuente": f"GeoNames MX.zip, lugares poblados con población >= {MIN_POP} o cabecera",
        "coordenadas": "[nombre, lat, lon] en milésimas de grado",
        "licencia": "CC BY 4.0",
        "volcado": stamp.isoformat(),
        "n": sum(len(v) for v in states.values()),
        "estados": dict(sorted(states.items())),
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{OUT}: {data['n']} localidades en {len(states)} estados, {OUT.stat().st_size} bytes, volcado {data['volcado']}")


if __name__ == "__main__":
    main()
