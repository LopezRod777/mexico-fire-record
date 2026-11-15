"""Humo de NOAA HMS para la captura: polígonos de la ventana que tocan México, simplificados.

Son áreas de humo que analistas de NOAA trazan sobre imágenes diurnas de GOES; no son perímetros
de incendio ni prueba de fuego en un punto, y no se suman a ningún conteo. Density (Light, Medium,
Heavy) es la categoría que pone el analista, no una concentración medida.

Solo se guardan las plumas locales: las áreas de más de REGIONAL_KM2 son bruma regional que cubre
medio país y no dice nada sobre un punto, así que se dejan fuera y se anota cuántas fueron.
"""
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from assign_regions import assign, in_ring
from shapefile_min import ShapefileError, read_zip

SMOKE_FILES = {"HMS_SMOKE_AYER": 1, "HMS_SMOKE_HOY": 0}  # fuente → días antes del día UTC de la captura
DENSITIES = ("Light", "Medium", "Heavy")
TOLERANCE = 0.005  # grados (~0.5 km): tolerancia de la simplificación
DECIMALS = 3
STEP = 0.05        # grados: separación máxima de los puntos con que se prueba cada borde
REGIONAL_KM2 = 50_000  # km²: por encima es bruma regional. El 14 nov 2026 las 8 plumas locales que
#                        tocaban México medían de 48 a 4,979 km² y las 3 regionales, de 1.08 a 11.5 millones.
EARTH_KM = 6371.0088


def area_km2(rings) -> float:
    """Área sobre la esfera de un polígono en lon/lat (los huecos restan, por el sentido del anillo)."""
    total = 0.0
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            total += math.radians(x2 - x1) * (2 + math.sin(math.radians(y1)) + math.sin(math.radians(y2)))
    return abs(total) * EARTH_KM ** 2 / 2


def smoke_url(day) -> str:
    return ("https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/Shapefile/"
            f"{day:%Y}/{day:%m}/hms_smoke{day:%Y%m%d}.zip")


def parse_time(text: str) -> datetime:
    """'AAAADDD HHMM' (año, día del año y hora UTC) → instante UTC."""
    parts = text.split()
    if len(parts) != 2 or len(parts[0]) != 7 or len(parts[1]) != 4:
        raise ValueError(f"hora de HMS inesperada: {text!r}")
    return datetime.strptime(parts[0] + parts[1], "%Y%j%H%M").replace(tzinfo=timezone.utc)


def check_records(records) -> None:
    """ValueError si un registro con polígono no trae horas de HMS legibles y en orden.

    Se usa al bajar: un archivo con otro formato se anota como fallo y no llega a la captura.
    """
    for record in records:
        if record["anillos"] and not parse_time(record["atributos"].get("Start", "")) < parse_time(record["atributos"].get("End", "")):
            raise ValueError("intervalo de HMS con fin antes del inicio")


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _distance(point, a, b):
    (px, py), (ax, ay), (bx, by) = point, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** .5
    u = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return ((px - ax - u * dx) ** 2 + (py - ay - u * dy) ** 2) ** .5


def _douglas_peucker(points, tolerance):
    keep, stack = {0, len(points) - 1}, [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        worst, index = 0.0, None
        for i in range(first + 1, last):
            d = _distance(points[i], points[first], points[last])
            if d > worst:
                worst, index = d, i
        if index is not None and worst > tolerance:
            keep.add(index)
            stack += [(first, index), (index, last)]
    return [points[i] for i in sorted(keep)]


def simplify_ring(ring, tolerance=TOLERANCE, decimals=DECIMALS):
    """Anillo cerrado con menos vértices (Douglas-Peucker) y coordenadas redondeadas.

    Se parte en el vértice más lejano del primero para tener dos tramos abiertos. Si el anillo es
    tan chico que al simplificar quedaría sin área, se conserva completo (solo redondeado).
    """
    points = [(float(x), float(y)) for x, y in ring]
    if len(points) > 1 and points[0] == points[-1]:
        points = points[:-1]

    def rounded(sequence):
        out = []
        for x, y in sequence:
            pair = [round(x, decimals), round(y, decimals)]
            if not out or out[-1] != pair:
                out.append(pair)
        if len(out) > 1 and out[0] == out[-1]:
            out.pop()
        return out

    if len(points) >= 4:
        far = max(range(len(points)), key=lambda i: (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2)
        simple = rounded(_douglas_peucker(points[:far + 1], tolerance)[:-1]
                         + _douglas_peucker(points[far:] + points[:1], tolerance)[:-1])
        if len(simple) >= 3:
            return simple + simple[:1]
    full = rounded(points)
    return full + full[:1] if len(full) >= 3 else None


def _densify(ring, step=STEP):
    points = np.asarray(ring, dtype=float)
    out = []
    for (x1, y1), (x2, y2) in zip(points[:-1], points[1:]):
        n = max(1, int(np.ceil(max(abs(x2 - x1), abs(y2 - y1)) / step)))
        u = np.arange(n) / n
        out.append(np.column_stack([x1 + (x2 - x1) * u, y1 + (y2 - y1) * u]))
    return np.concatenate(out) if out else points


def touches_mexico(polygons, features):
    """Para cada polígono (lista de anillos), si toca México según la geometría de los estados.

    Toca si algún punto de su borde (muestreado cada 0.05° como máximo) cae dentro de un estado o si
    algún vértice de un estado cae dentro del polígono (humo que cubre un estado o una isla enteros).
    """
    vertices = np.concatenate([np.asarray(ring, dtype=float)
                               for feature in features
                               for polygon in ([feature["geometry"]["coordinates"]]
                                               if feature["geometry"]["type"] == "Polygon"
                                               else feature["geometry"]["coordinates"])
                               for ring in polygon])
    west, south = vertices.min(axis=0)
    east, north = vertices.max(axis=0)
    result = np.zeros(len(polygons), dtype=bool)
    samples, owner = [], []
    for i, rings in enumerate(polygons):
        if not rings:
            continue
        points = np.concatenate([_densify(ring) for ring in rings])
        if points[:, 0].max() < west or points[:, 0].min() > east or points[:, 1].max() < south or points[:, 1].min() > north:
            continue
        samples.append(points)
        owner.append(np.full(len(points), i))
    if not samples:
        return result
    points, owner = np.concatenate(samples), np.concatenate(owner)
    inside = assign(points[:, 1], points[:, 0], features) != "OUT"
    result[np.unique(owner[inside])] = True
    for i in np.unique(owner):
        if result[i]:
            continue
        covered = np.zeros(len(vertices), dtype=bool)
        for ring in polygons[i]:
            covered ^= in_ring(vertices[:, 1], vertices[:, 0], ring)
        result[i] = bool(covered.any())
    return result


def read_smoke(fetch, raw: Path):
    """Registros de los archivos de humo que se bajaron bien EN ESTA captura, con su día.

    Devuelve (registros, días leídos) o (None, []) si no se bajó ninguno: un zip que quedó en disco
    de otra captura no se mezcla.
    """
    records, days = [], []
    for source in SMOKE_FILES:
        status = fetch.get("fuentes_extra", {}).get(source)
        if not status or not status.get("ok"):
            continue
        try:
            records += read_zip((raw / f"{source}.zip").read_bytes())
        except (OSError, ShapefileError):
            continue
        days.append(status["fecha"])
    return (records, sorted(days)) if days else (None, [])


def smoke_summary(records, days, features, lower: datetime, upper: datetime):
    """Campo `humo` de la captura: plumas locales cuyo intervalo cae en (lower, upper] y tocan México.

    Las áreas que tocan México pero miden más de REGIONAL_KM2 no se guardan; se cuentan en
    `n_regionales_omitidas`.
    """
    if records is None:
        return None
    timed = []
    for record in records:
        attrs = record["atributos"]
        if not record["anillos"] or attrs.get("Density") not in DENSITIES:
            continue
        start, end = parse_time(attrs["Start"]), parse_time(attrs["End"])
        if end > lower and start <= upper:
            timed.append((start, end, attrs["Density"], attrs.get("Satellite", ""), record["anillos"]))
    touching = touches_mexico([item[4] for item in timed], features)
    polygons, regional = [], 0
    for (start, end, density, satellite, rings), touches in zip(timed, touching):
        if not touches:
            continue
        area = area_km2(rings)
        if area > REGIONAL_KM2:
            regional += 1
            continue
        simple = [ring for ring in (simplify_ring(ring) for ring in rings) if ring]
        if simple:
            polygons.append({"inicio": iso(start), "fin": iso(end), "densidad": density,
                             "sat": satellite, "area_km2": round(area), "anillos": simple})
    polygons.sort(key=lambda p: (p["inicio"], p["fin"], DENSITIES.index(p["densidad"]), p["sat"], p["anillos"]))
    return {"fuente": "NOAA_HMS_SMOKE", "ventana_horas": int((upper - lower) / timedelta(hours=1)),
            "dias": days, "poligonos_en_ventana": len(timed), "n": len(polygons),
            "umbral_regional_km2": REGIONAL_KM2, "n_regionales_omitidas": regional,
            "por_densidad": {density: sum(p["densidad"] == density for p in polygons) for density in DENSITIES},
            "ultima_utc": max((p["fin"] for p in polygons), default=None),
            "tolerancia_grados": TOLERANCE, "poligonos": polygons}
