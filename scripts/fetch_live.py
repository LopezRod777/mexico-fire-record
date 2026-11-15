"""Descarga la capa casi en tiempo real (VIIRS NOAA-20 y NOAA-21 NRT) de NASA FIRMS.

Lee la llave de la variable de entorno FIRMS_MAP_KEY (nunca la imprime) y escribe
data/live/raw/<fuente>.csv y data/live/raw/fetch_info.json. Si una descarga falla o
no trae el encabezado esperado, termina con error y no toca los archivos actuales.
"""
import csv
import io
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/live/raw"
BBOX = [-118.4, 14.5, -86.7, 32.7]
DAY_RANGE = 2
SOURCES = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]
HEADER = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time"


def main() -> int:
    key = os.environ.get("FIRMS_MAP_KEY", "")
    if len(key) != 32:
        print("FIRMS_MAP_KEY ausente o con longitud inesperada", file=sys.stderr)
        return 1
    downloaded = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    texts, info = {}, {"bbox": BBOX, "day_range": DAY_RANGE, "fuentes": {}}
    for source in SOURCES:
        url = (f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/"
               f"{','.join(str(v) for v in BBOX)}/{DAY_RANGE}")
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                text = response.read().decode("utf-8")
        except Exception as error:  # sin la URL: lleva la llave
            print(f"{source}: descarga fallida ({type(error).__name__})", file=sys.stderr)
            return 1
        if not text.startswith(HEADER):
            print(f"{source}: respuesta sin el encabezado esperado", file=sys.stderr)
            return 1
        rows = list(csv.DictReader(io.StringIO(text)))
        if not rows:
            print(f"{source}: 0 filas", file=sys.stderr)
            return 1
        dates = sorted({row["acq_date"] for row in rows})
        last = max(row["acq_time"].zfill(4) for row in rows if row["acq_date"] == dates[-1])
        info["fuentes"][source] = {"filas": len(rows), "fecha_min": dates[0],
                                   "fecha_max": dates[-1],
                                   "ultima_hora_utc_del_ultimo_dia": last}
        texts[source] = text
    info["descargado_utc"] = downloaded
    for source, text in texts.items():
        (RAW / f"{source}.csv").write_text(text, encoding="utf-8")
    (RAW / "fetch_info.json").write_text(json.dumps(info, indent=1, ensure_ascii=False),
                                         encoding="utf-8")
    print(json.dumps({k: v["filas"] for k, v in info["fuentes"].items()}), downloaded)
    return fetch_tle(downloaded)


TLE_SATS = {"NOAA-20": 43013, "NOAA-21": 54234}


def fetch_tle(downloaded: str) -> int:
    """Órbitas (TLE) de CelesTrak para predecir pasos en el navegador.

    Si falla, deja el archivo anterior y no detiene la captura de incendios.
    """
    sats = []
    for name, catnr in TLE_SATS.items():
        url = f"https://celestrak.org/NORAD/elements/gp.php?CATNR={catnr}&FORMAT=TLE"
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                lines = [l.rstrip() for l in response.read().decode("ascii").splitlines() if l.strip()]
        except Exception as error:
            print(f"TLE {name}: descarga fallida ({type(error).__name__}); se conserva el anterior", file=sys.stderr)
            return 0
        if len(lines) != 3 or not lines[1].startswith("1 ") or not lines[2].startswith("2 ") \
                or int(lines[1][2:7]) != catnr:
            print(f"TLE {name}: formato inesperado; se conserva el anterior", file=sys.stderr)
            return 0
        sats.append({"nombre": name, "norad": catnr, "tle1": lines[1], "tle2": lines[2]})
    out = {"fuente": "CelesTrak GP", "descargado_utc": downloaded, "satelites": sats}
    (ROOT / "web/data/tle.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("TLE:", ", ".join(s["nombre"] for s in sats))
    return 0


if __name__ == "__main__":
    sys.exit(main())
