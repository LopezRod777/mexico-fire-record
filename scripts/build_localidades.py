#!/usr/bin/env python3
"""Genera web/data/localidades_mx.json: localidades de México para describir un punto en el navegador.

Fuente: GeoNames, volcado por país https://download.geonames.org/export/dump/MX.zip
(licencia CC BY 4.0, https://download.geonames.org/export/dump/readme.txt).

Filtro: todos los lugares poblados (clase P) vigentes, con o sin dato de población. Se excluyen los
abandonados, destruidos o históricos (PPLQ, PPLW, PPLH) y los nombres que no identifican un lugar por sí
solos (ver `junk`). Es la opción más densa: la referencia queda lo más cerca posible del punto.

Formato compacto (el archivo se carga solo al usar "Vi un fuego" y no bloquea el veredicto):
  estados: claves ISO en orden; cuenta: cuántas localidades tiene cada estado, en ese mismo orden;
  nombres, lat, lon: arreglos paralelos ordenados por estado, latitud y longitud;
  lat y lon son enteros en milésimas de grado, y lat guarda la diferencia con la fila anterior.

Uso (no forma parte del workflow de la captura; se corre a mano):
    python3 scripts/build_localidades.py            # descarga MX.zip
    python3 scripts/build_localidades.py MX.zip     # usa un volcado ya descargado
"""
import io
import json
import re
import sys
import urllib.request
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

URL = "https://download.geonames.org/export/dump/MX.zip"
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "data" / "localidades_mx.json"
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


def junk(name):
    """Nombres que no sirven de referencia: siglas o códigos, "Sin Nombre", "Kilómetro 23" y "Centro" a secas."""
    return (len(name) <= 2 or not re.search(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2}", name)
            or re.match(r"(sin nombre|ninguno|centro$|kil[oó]metro\b|km\.?\s*\d)", name, re.I) is not None)


def main():
    lines, stamp = read_dump(sys.argv[1] if len(sys.argv) > 1 else None)
    rows, dropped = [], 0
    for line in lines:
        c = line.split("\t")
        if c[6] != "P" or c[7] in GONE or c[10] not in ADMIN1:
            continue
        name = RENAME.get(c[1], c[1])
        if junk(name):
            dropped += 1
            continue
        rows.append((ADMIN1[c[10]], name, round(float(c[4]) * 1000), round(float(c[5]) * 1000), int(c[14] or 0)))
    # Duplicados (mismo estado, nombre y ~1 km): se queda el de mayor población.
    rows.sort(key=lambda r: (r[0], r[1], -r[4], r[2], r[3]))
    seen, kept = set(), []
    for state, name, lat, lon, _ in rows:
        key = (state, name, round(lat / 10), round(lon / 10))
        if key not in seen:
            seen.add(key)
            kept.append((state, lat, lon, name))
    kept.sort()
    states = sorted({r[0] for r in kept})
    lat = [r[1] for r in kept]
    data = {
        "fuente": "GeoNames MX.zip, lugares poblados (clase P) vigentes",
        "licencia": "CC BY 4.0",
        "volcado": stamp.isoformat(),
        "formato": "nombres, lat y lon paralelos y ordenados por estado; milésimas de grado; lat en diferencias",
        "n": len(kept),
        "estados": states,
        "cuenta": [sum(1 for r in kept if r[0] == s) for s in states],
        "nombres": [r[3] for r in kept],
        "lat": [lat[0]] + [b - a for a, b in zip(lat, lat[1:])],
        "lon": [r[2] for r in kept],
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{OUT}: {data['n']} localidades en {len(states)} estados, {OUT.stat().st_size} bytes, volcado {data['volcado']}, "
          f"{dropped} nombres descartados por no identificar un lugar")


if __name__ == "__main__":
    main()
