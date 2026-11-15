"""Baja de la API de área de NASA FIRMS los puntos de MODIS y VIIRS S-NPP de 2026.

Los CSV anuales públicos por país no existen todavía para 2026, así que se usa la API de área
(recuadro de México, el mismo de la capa en vivo) en ventanas de hasta 5 días, que es el máximo
por petición (https://firms.modaps.eosdis.nasa.gov/api/area/). Para cada día usa el producto
estándar (SP) si ya existe y el casi en tiempo real (NRT) después, según lo que responde
`/api/data_availability/` en el momento de la descarga.

Lee la llave de la variable de entorno FIRMS_MAP_KEY y nunca la imprime ni la guarda. Escribe
un CSV por petición, tal como llegó, en <destino>/<FUENTE>/<FUENTE>_<inicio>_<n>d.csv y un
`manifest.json` con la disponibilidad, los tramos usados y, por archivo, filas, fechas y sha256.
No sobrescribe archivos existentes salvo con --rehacer.

Uso: FIRMS_MAP_KEY=... python scripts/download_firms_2026.py [--inicio AAAA-MM-DD] [--fin AAAA-MM-DD]
     [--destino carpeta] [--rehacer]
"""
import argparse
import csv
import hashlib
import io
import json
import os
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = "https://firms.modaps.eosdis.nasa.gov"
BBOX = "-118.4,14.5,-86.7,32.7"  # el mismo recuadro que scripts/fetch_live.py
MAX_DAYS = 5
PAUSE = 1.0  # segundos entre peticiones; el límite de la llave es 5,000 transacciones / 10 min
PRODUCTS = {"modis": ("MODIS_SP", "MODIS_NRT"), "viirs-snpp": ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT")}
HEADERS = {
    "modis": "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,"
             "confidence,version,bright_t31,frp,daynight",
    "viirs-snpp": "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,"
                  "confidence,version,bright_ti5,frp,daynight",
}


def get(url):
    """Texto de la respuesta. Los errores salen sin la URL, porque lleva la llave."""
    try:
        with urllib.request.urlopen(url, timeout=180) as response:
            return response.read().decode("utf-8")
    except Exception as error:
        raise RuntimeError(f"descarga fallida ({type(error).__name__})") from None


def availability(key):
    rows = csv.DictReader(io.StringIO(get(f"{API}/api/data_availability/csv/{key}/ALL")))
    table = {row["data_id"]: (row["min_date"], row["max_date"]) for row in rows}
    if not table:
        raise RuntimeError("data_availability no devolvió filas")
    return table


def transactions(key):
    return int(json.loads(get(f"{API}/mapserver/mapkey_status/?MAP_KEY={key}"))["current_transactions"])


def segments(table, start, end):
    """Tramos (fuente, inicio, fin) por producto: SP hasta donde exista y NRT después."""
    result = []
    for product, (sp, nrt) in PRODUCTS.items():
        sp_end = min(date.fromisoformat(table[sp][1]), end)
        if sp_end >= start:
            result.append((product, sp, start, sp_end))
        if sp_end >= end:
            continue
        nrt_start = max(sp_end + timedelta(days=1), start)
        nrt_min, nrt_max = (date.fromisoformat(value) for value in table[nrt])
        if nrt_start < nrt_min:
            raise RuntimeError(f"{product}: hueco entre {sp} (hasta {sp_end}) y {nrt} (desde {nrt_min})")
        nrt_end = min(nrt_max, end)
        if nrt_end >= nrt_start:
            result.append((product, nrt, nrt_start, nrt_end))
    return result


def windows(start, end):
    day = start
    while day <= end:
        days = min(MAX_DAYS, (end - day).days + 1)
        yield day, days
        day += timedelta(days=days)


def fetch_window(key, product, source, start, days):
    text = get(f"{API}/api/area/csv/{key}/{source}/{BBOX}/{days}/{start.isoformat()}")
    header = text.splitlines()[0] if text else ""
    if not header.startswith(HEADERS[product]):
        raise RuntimeError("respuesta sin el encabezado esperado: " + header[:60].replace(key, "LLAVE"))
    rows = list(csv.DictReader(io.StringIO(text)))
    last = start + timedelta(days=days - 1)
    outside = [row["acq_date"] for row in rows if not start.isoformat() <= row["acq_date"] <= last.isoformat()]
    if outside:
        raise RuntimeError(f"{len(outside)} filas fuera de la ventana pedida ({outside[0]})")
    return text, header, rows


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--inicio", default="2026-01-01")
    parser.add_argument("--fin", default=None, help="por omisión, ayer (UTC): el último día completo")
    parser.add_argument("--destino", default=str(ROOT / "data/raw/2026_api"))
    parser.add_argument("--rehacer", action="store_true", help="vuelve a bajar las ventanas que ya existen")
    args = parser.parse_args()
    key = os.environ.get("FIRMS_MAP_KEY", "")
    if len(key) != 32:
        print("FIRMS_MAP_KEY ausente o con longitud inesperada", file=sys.stderr)
        return 1
    start = date.fromisoformat(args.inicio)
    end = date.fromisoformat(args.fin) if args.fin else datetime.now(timezone.utc).date() - timedelta(days=1)
    dest = Path(args.destino)
    table = availability(key)
    plan = segments(table, start, end)
    manifest_path = dest / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"archivos": {}}
    manifest.update({"api": f"{API}/api/area/csv/[LLAVE]/[FUENTE]/{BBOX}/[DIAS]/[FECHA]", "bbox": BBOX,
                     "disponibilidad": {source: list(table[source]) for pair in PRODUCTS.values() for source in pair},
                     "disponibilidad_consultada_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                     "tramos": [{"producto": product, "fuente": source, "inicio": a.isoformat(), "fin": b.isoformat()}
                                for product, source, a, b in plan]})
    requests = 0
    for product, source, seg_start, seg_end in plan:
        folder = dest / source
        folder.mkdir(parents=True, exist_ok=True)
        for day, days in windows(seg_start, seg_end):
            name = f"{source}_{day.isoformat()}_{days}d.csv"
            path = folder / name
            if path.exists() and not args.rehacer:
                continue
            for attempt in range(4):
                try:
                    text, header, rows = fetch_window(key, product, source, day, days)
                    break
                except RuntimeError as error:
                    print(f"{name}: {error}; intento {attempt + 1}/4", file=sys.stderr)
                    if attempt == 3:
                        manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
                        return 1
                    time.sleep(30 * (attempt + 1))
            part = path.with_suffix(".part")
            part.write_text(text, encoding="utf-8")
            part.replace(path)
            dates = sorted({row["acq_date"] for row in rows})
            manifest["archivos"][f"{source}/{name}"] = {
                "fuente": source, "inicio": day.isoformat(), "dias": days, "filas": len(rows),
                "fecha_min": dates[0] if dates else None, "fecha_max": dates[-1] if dates else None,
                "dias_con_filas": len(dates), "encabezado": header,
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "descargado_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
            requests += 1
            print(f"{name}: {len(rows)} filas, {len(dates)} días con filas")
            if requests % 20 == 0:
                used = transactions(key)
                print(f"transacciones en los últimos 10 min: {used}")
                manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
                if used > 4000:
                    time.sleep(600)
            time.sleep(PAUSE)
    manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    print(f"FIN: {requests} peticiones nuevas; {len(manifest['archivos'])} archivos en el manifiesto; "
          f"transacciones en los últimos 10 min: {transactions(key)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
