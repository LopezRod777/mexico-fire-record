"""Deja los puntos de 2026 (API de área de FIRMS) en el mismo formato que los CSV anuales por país.

Lee las ventanas que bajó `scripts/download_firms_2026.py`, comprueba que no falten días ni se
repitan filas entre peticiones o en el empalme SP→NRT, se queda con los meses completos en los
dos productos y con los puntos cuya celda de 0.05° pertenece a un estado (la misma regla del
centro de celda que usa la capa en vivo; el resto del recuadro es `OUT`), y escribe
`<carpeta>/mexico/modis_2026_Mexico.csv` y `viirs-snpp_2026_Mexico.csv` más `resumen.json`.

No rellena nada: los días en que un producto no dejó filas en el recuadro se listan y quedan
en `resumen.json`; la exportación los cuenta por mes (`dias_sin_deteccion`).
"""
import argparse
import calendar
import csv
import hashlib
import json
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from assign_regions import assign
from common import RAW_2026, ROOT

COLUMNS = {
    "modis": ["latitude", "longitude", "brightness", "scan", "track", "acq_date", "acq_time", "satellite",
              "instrument", "confidence", "version", "bright_t31", "frp", "daynight", "type"],
    "viirs-snpp": ["latitude", "longitude", "bright_ti4", "scan", "track", "acq_date", "acq_time", "satellite",
                   "instrument", "confidence", "version", "bright_ti5", "frp", "daynight", "type"],
}
CELL = 0.05


def days(start, end):
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def read_product(folder, manifest, product):
    """Filas de un producto con su fuente, tras comprobar archivos, ventanas, empalme y duplicados."""
    rows, covered = [], []
    for segment in (s for s in manifest["tramos"] if s["producto"] == product):
        source = segment["fuente"]
        start, end = date.fromisoformat(segment["inicio"]), date.fromisoformat(segment["fin"])
        day = start
        while day <= end:
            n = min(5, (end - day).days + 1)
            name = f"{source}/{source}_{day.isoformat()}_{n}d.csv"
            text = (folder / name).read_text(encoding="utf-8")
            entry = manifest["archivos"][name]
            assert hashlib.sha256(text.encode("utf-8")).hexdigest() == entry["sha256"], f"{name}: sha256 distinto"
            last = (day + timedelta(days=n - 1)).isoformat()
            window = list(csv.DictReader(text.splitlines()))
            assert len(window) == entry["filas"], f"{name}: {len(window)} filas vs {entry['filas']} del manifiesto"
            for row in window:
                assert day.isoformat() <= row["acq_date"] <= last, f"{name}: fila fuera de su ventana"
                rows.append((source, row))
            day += timedelta(days=n)
        covered.append((start, end))
    covered.sort()
    for (_, end), (start, _) in zip(covered, covered[1:]):
        assert start == end + timedelta(days=1), f"{product}: los tramos no empalman ({end} → {start})"
    repeated = sum(n - 1 for n in Counter(tuple(row.values()) for _, row in rows).values() if n > 1)
    return rows, covered[0][0], covered[-1][1], repeated


def complete_month(end):
    """Último mes cuyo último día ya está cubierto."""
    if end.day == calendar.monthrange(end.year, end.month)[1]:
        return end.strftime("%Y-%m")
    return (end.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")


def build(folder=RAW_2026):
    manifest = json.loads((folder / "manifest.json").read_text())
    features = json.loads((ROOT / "web/data/geo/mx_states.geojson").read_text())["features"]
    products, summary = {}, {"productos": {}, "meses": []}
    for product in COLUMNS:
        rows, start, end, repeated = read_product(folder, manifest, product)
        by_day = Counter(row["acq_date"] for _, row in rows)
        empty = [day.isoformat() for day in days(start, end) if not by_day[day.isoformat()]]
        products[product] = (rows, start, end)
        summary["productos"][product] = {"inicio": start.isoformat(), "fin": end.isoformat(),
                                         "filas_recuadro": len(rows), "filas_repetidas": repeated,
                                         "dias_sin_filas": empty, "ultimo_mes_completo": complete_month(end)}
    last_month = min(item["ultimo_mes_completo"] for item in summary["productos"].values())
    summary["ultimo_mes"] = last_month
    problems = [f"{product}: {item['filas_repetidas']} filas repetidas" for product, item in
                summary["productos"].items() if item["filas_repetidas"]]
    out = folder / "mexico"
    out.mkdir(exist_ok=True)
    for product, (rows, start, _) in products.items():
        kept = [(source, row) for source, row in rows if row["acq_date"][:7] <= last_month]
        lat = np.array([float(row["latitude"]) for _, row in kept])
        lon = np.array([float(row["longitude"]) for _, row in kept])
        cells = np.unique(np.stack([np.floor(lat / CELL), np.floor(lon / CELL)], axis=1).astype(int), axis=0)
        state = dict(zip(map(tuple, cells), assign((cells[:, 0] + .5) * CELL, (cells[:, 1] + .5) * CELL, features)))
        inside = [state[int(np.floor(a / CELL)), int(np.floor(b / CELL))] != "OUT" for a, b in zip(lat, lon)]
        monthly = defaultdict(lambda: {"filas_recuadro": 0, "filas_mexico": 0, "dias": set(), "fuentes": set()})
        with (out / f"{product}_2026_Mexico.csv").open("w", newline="", encoding="utf-8") as file:
            writer = csv.writer(file, lineterminator="\n")
            writer.writerow(COLUMNS[product])
            for (source, row), keep in zip(kept, inside):
                item = monthly[row["acq_date"][:7]]
                item["filas_recuadro"] += 1
                item["dias"].add(row["acq_date"])
                item["fuentes"].add(source)
                if keep:
                    item["filas_mexico"] += 1
                    writer.writerow([row.get(column, "") for column in COLUMNS[product]])
        for month, item in sorted(monthly.items()):
            year, number = int(month[:4]), int(month[5:])
            expected = calendar.monthrange(year, number)[1] - (start.day - 1 if month == start.strftime("%Y-%m") else 0)
            summary["meses"].append({"producto": product, "mes": month, "fuentes": sorted(item["fuentes"]),
                                     "filas_recuadro": item["filas_recuadro"], "filas_mexico": item["filas_mexico"],
                                     "dias_con_filas": len(item["dias"]), "dias_del_mes": expected})
    (out / "resumen.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False))
    for row in summary["meses"]:
        print(f"{row['producto']:<10} {row['mes']} {'+'.join(row['fuentes']):<28} recuadro={row['filas_recuadro']:>7} "
              f"México={row['filas_mexico']:>7} días={row['dias_con_filas']}/{row['dias_del_mes']}")
    for product, item in summary["productos"].items():
        empty = [day for day in item["dias_sin_filas"] if day[:7] <= last_month]
        print(f"{product}: {len(empty)} días sin filas en el recuadro hasta {last_month}: {', '.join(empty) or 'ninguno'}")
    print(f"Último mes completo en los dos productos: {last_month}")
    if problems:
        print("PROBLEMAS:\n" + "\n".join(problems), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--carpeta", default=str(RAW_2026))
    sys.exit(build(Path(parser.parse_args().carpeta)))
