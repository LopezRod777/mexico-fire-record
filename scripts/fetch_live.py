"""Descarga la capa casi en tiempo real de NASA FIRMS: VIIRS NOAA-20 y NOAA-21 NRT (base de
la captura) y, como fuentes extra, MODIS NRT (Terra y Aqua) y GOES NRT (GOES-18 y GOES-19).

Lee la llave de la variable de entorno FIRMS_MAP_KEY (nunca la imprime) y escribe
data/live/raw/<fuente>.csv y data/live/raw/fetch_info.json. Si una descarga VIIRS falla o
no trae el encabezado esperado, termina con error y no toca los archivos actuales. Si falla
una fuente extra, se anota en fetch_info.json (fuentes_extra) y la captura de VIIRS sigue.
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
# Fuentes extra con su encabezado completo esperado (verificado contra la API el 15 nov 2026).
EXTRA = {
    "MODIS_NRT": "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,"
                 "confidence,version,bright_t31,frp,daynight",
    "GOES_NRT": "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,"
                "confidence,version,bright_ti5,frp,daynight",
}


def area_url(key: str, source: str) -> str:
    return (f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/"
            f"{','.join(str(v) for v in BBOX)}/{DAY_RANGE}")


def fetch_extra(key: str) -> tuple[dict, dict]:
    """Descarga las fuentes extra. Nunca lanza: cada fallo queda anotado y se sigue."""
    texts, status = {}, {}
    for source, header in EXTRA.items():
        try:
            with urllib.request.urlopen(area_url(key, source), timeout=60) as response:
                text = response.read().decode("utf-8")
        except Exception as error:  # sin la URL: lleva la llave
            status[source] = {"ok": False, "error": f"descarga fallida ({type(error).__name__})"}
            print(f"{source}: descarga fallida ({type(error).__name__}); se sigue sin ella", file=sys.stderr)
            continue
        if text.splitlines()[:1] != [header]:
            status[source] = {"ok": False, "error": "respuesta sin el encabezado esperado"}
            print(f"{source}: respuesta sin el encabezado esperado; se sigue sin ella", file=sys.stderr)
            continue
        rows = list(csv.DictReader(io.StringIO(text)))
        dates = sorted({row["acq_date"] for row in rows})
        status[source] = {"ok": True, "filas": len(rows),
                          "fecha_min": dates[0] if dates else None,
                          "fecha_max": dates[-1] if dates else None}
        texts[source] = text
    return texts, status


def main() -> int:
    key = os.environ.get("FIRMS_MAP_KEY", "")
    if len(key) != 32:
        print("FIRMS_MAP_KEY ausente o con longitud inesperada", file=sys.stderr)
        return 1
    downloaded = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    texts, info = {}, {"bbox": BBOX, "day_range": DAY_RANGE, "fuentes": {}}
    for source in SOURCES:
        try:
            with urllib.request.urlopen(area_url(key, source), timeout=60) as response:
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
    extra_texts, info["fuentes_extra"] = fetch_extra(key)
    texts.update(extra_texts)
    info["descargado_utc"] = downloaded
    for source, text in texts.items():
        (RAW / f"{source}.csv").write_text(text, encoding="utf-8")
    (RAW / "fetch_info.json").write_text(json.dumps(info, indent=1, ensure_ascii=False),
                                         encoding="utf-8")
    print(json.dumps({k: v["filas"] for k, v in info["fuentes"].items()}),
          json.dumps({k: v.get("filas", v.get("error")) for k, v in info["fuentes_extra"].items()}),
          downloaded)
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
