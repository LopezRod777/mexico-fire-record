"""Pruebas del lector mínimo de shapefile y de la geometría del humo de NOAA HMS.

Los shapefiles de prueba se arman aquí en memoria, byte por byte, según la especificación de ESRI.
El archivo real de data/live/raw se contrasta con dos cosas que el lector no usa: la caja que cada
registro declara en el .shp y el índice .shx.
"""
import io
import json
import struct
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
from shapefile_min import ShapefileError, read_dbf, read_polygons, read_zip
from smoke import parse_time, simplify_ring, smoke_summary, touches_mexico

failures = 0
features = json.loads((ROOT / "web/data/geo/mx_states.geojson").read_text())["features"]


def check(label, fn):
    global failures
    try:
        print(f"OK {label}: {fn()}")
    except Exception as exc:
        failures += 1
        print(f"FALLO {label}: {type(exc).__name__}: {exc}")


def shp_bytes(records, shape_type=5):
    """records: lista de listas de anillos, o None para un registro nulo."""
    body = b""
    for number, rings in enumerate(records, 1):
        if rings is None:
            content = struct.pack("<i", 0)
        else:
            points = [p for ring in rings for p in ring]
            xs, ys = [p[0] for p in points], [p[1] for p in points]
            parts, at = [], 0
            for ring in rings:
                parts.append(at)
                at += len(ring)
            content = struct.pack("<i4d2i", shape_type, min(xs), min(ys), max(xs), max(ys), len(rings), len(points))
            content += struct.pack(f"<{len(parts)}i", *parts)
            content += b"".join(struct.pack("<2d", *p) for p in points)
            if shape_type in (15, 25):  # rango y valores Z o M, que el lector ignora
                content += struct.pack(f"<{2 + len(points)}d", 0, 0, *([0] * len(points)))
        body += struct.pack(">2i", number, len(content) // 2) + content
    header = struct.pack(">i", 9994) + b"\x00" * 20 + struct.pack(">i", (100 + len(body)) // 2)
    header += struct.pack("<2i", 1000, shape_type) + struct.pack("<8d", *([0] * 8))
    return header + body


def dbf_bytes(rows, fields=(("Satellite", 20), ("Start", 12), ("End", 12), ("Density", 7))):
    record_len = 1 + sum(size for _, size in fields)
    header_len = 32 + 32 * len(fields) + 1
    out = struct.pack("<4BIHH", 3, 126, 11, 15, len(rows), header_len, record_len) + b"\x00" * 20
    for name, size in fields:
        out += name.encode().ljust(11, b"\x00") + b"C" + b"\x00" * 4 + bytes([size]) + b"\x00" * 15
    out += b"\x0d"
    for row in rows:
        out += b" " + b"".join(str(row[name]).encode().ljust(size) for name, size in fields)
    return out + b"\x1a"


def zip_bytes(shp, dbf):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("hms_smoke.shp", shp)
        archive.writestr("hms_smoke.dbf", dbf)
        archive.writestr("hms_smoke.prj", "GEOGCS")
    return buffer.getvalue()


SQUARE = [(0.0, 0.0), (0.0, 4.0), (4.0, 4.0), (4.0, 0.0), (0.0, 0.0)]
HOLE = [(1.0, 1.0), (3.0, 1.0), (3.0, 3.0), (1.0, 3.0), (1.0, 1.0)]
ISLAND = [(10.0, 10.0), (10.0, 11.0), (11.0, 11.0), (11.0, 10.0), (10.0, 10.0)]
ROW = {"Satellite": "GOES-EAST", "Start": "2026318 1300", "End": "2026318 1600", "Density": "Light"}


def expect_error(fn, text):
    try:
        fn()
    except ShapefileError as error:
        assert text in str(error), (text, str(error))
        return
    raise AssertionError(f"se esperaba ShapefileError con {text!r}")


def reader_valid():
    shapes = read_polygons(shp_bytes([[SQUARE], [SQUARE, HOLE, ISLAND]]))
    assert shapes == [[SQUARE], [SQUARE, HOLE, ISLAND]], shapes
    for shape_type in (15, 25):
        assert read_polygons(shp_bytes([[SQUARE, HOLE]], shape_type)) == [[SQUARE, HOLE]], shape_type
    assert read_polygons(shp_bytes([])) == []
    assert read_polygons(shp_bytes([None, [SQUARE]])) == [[], [SQUARE]]
    rows = read_dbf(dbf_bytes([ROW, {**ROW, "Density": "Heavy"}]))
    assert rows == [ROW, {**ROW, "Density": "Heavy"}], rows
    records = read_zip(zip_bytes(shp_bytes([[SQUARE], [SQUARE, HOLE]]), dbf_bytes([ROW, {**ROW, "Density": "Medium"}])))
    assert [len(r["anillos"]) for r in records] == [1, 2] and records[1]["atributos"]["Density"] == "Medium"
    assert read_zip(zip_bytes(shp_bytes([]), dbf_bytes([]))) == []
    return "tipos 5, 15 y 25; un anillo, con hueco y con isla; registro nulo; archivo vacío; dbf y zip"


def reader_truncated():
    good = shp_bytes([[SQUARE], [SQUARE, HOLE]])
    expect_error(lambda: read_polygons(good[:60]), "encabezado incompleto")
    expect_error(lambda: read_polygons(good[:-8]), "longitud declarada")
    cut = good[:-40]
    cut = cut[:24] + struct.pack(">i", len(cut) // 2) + cut[28:]  # longitud coherente, registro cortado
    expect_error(lambda: read_polygons(cut), "truncado")
    expect_error(lambda: read_polygons(good[:104] + struct.pack(">i", 10 ** 6) + good[108:]), "truncado")
    expect_error(lambda: read_polygons(b"\x00" * 100), "no es un shapefile")
    points = shp_bytes([[SQUARE]])
    expect_error(lambda: read_polygons(points[:32] + struct.pack("<i", 1) + points[36:]), "no es de polígonos")
    bad_parts = bytearray(good)
    bad_parts[100 + 8 + 44:100 + 8 + 48] = struct.pack("<i", 3)  # el primer anillo debe empezar en 0
    expect_error(lambda: read_polygons(bytes(bad_parts)), "anillos inválidos")
    table = dbf_bytes([ROW, ROW])
    expect_error(lambda: read_dbf(table[:20]), "encabezado incompleto")
    expect_error(lambda: read_dbf(table[:-30]), "registros truncados")
    expect_error(lambda: read_zip(zip_bytes(good, dbf_bytes([ROW]))), "2 polígonos y 1 filas")
    expect_error(lambda: read_zip(zip_bytes(good, table)[:200]), "ilegible")
    expect_error(lambda: read_zip(b"no es un zip"), "ilegible")
    return "12 archivos rotos (cortados, con longitudes falsas, de otro tipo, zip dañado) dan ShapefileError"


def real_file_against_box_and_shx():
    path = ROOT / "data/live/raw/HMS_SMOKE_AYER.zip"
    if not path.exists():
        return "sin archivo real en data/live/raw (se omite)"
    with zipfile.ZipFile(path) as archive:
        name = next(n for n in archive.namelist() if n.endswith(".shp"))
        shp, shx = archive.read(name), archive.read(name[:-4] + ".shx")
    records = read_zip(path.read_bytes())
    n_index = (len(shx) - 100) // 8
    assert n_index == len(records), (n_index, len(records))
    vertices = 0
    for i, record in enumerate(records):
        offset, = struct.unpack(">i", shx[100 + 8 * i:104 + 8 * i])
        box = struct.unpack("<4d", shp[offset * 2 + 12:offset * 2 + 44])
        xs = [x for ring in record["anillos"] for x, _ in ring]
        ys = [y for ring in record["anillos"] for _, y in ring]
        assert (min(xs), min(ys), max(xs), max(ys)) == box, (i, box)
        assert all(ring[0] == ring[-1] and len(ring) >= 4 for ring in record["anillos"]), i
        assert record["atributos"]["Density"] in ("Light", "Medium", "Heavy"), record["atributos"]
        assert parse_time(record["atributos"]["Start"]) < parse_time(record["atributos"]["End"])
        vertices += len(xs)
    return f"{len(records)} polígonos y {vertices} vértices; cada uno coincide con su caja declarada y con el índice .shx"


def times():
    assert parse_time("2026318 1300") == datetime(2026, 11, 14, 13, 0, tzinfo=timezone.utc)
    assert parse_time("2026319 0000") == datetime(2026, 11, 15, 0, 0, tzinfo=timezone.utc)
    assert parse_time("2024060 2359") == datetime(2024, 2, 29, 23, 59, tzinfo=timezone.utc)
    for bad in ("2026318", "2026-11-14 1300", "2026400 1300", ""):
        try:
            parse_time(bad)
        except ValueError:
            continue
        raise AssertionError(bad)
    return "día del año → fecha UTC (incluye bisiesto) y 4 formatos inválidos rechazados"


def simplification():
    import math
    circle = [(-100 + math.cos(a / 180 * math.pi), 20 + math.sin(a / 180 * math.pi)) for a in range(360)]
    simple = simplify_ring(circle + circle[:1])
    assert simple[0] == simple[-1] and 12 <= len(simple) < 80, len(simple)
    assert all(abs(math.hypot(x + 100, y - 20) - 1) < 0.006 for x, y in simple)
    assert all(round(x, 3) == x and round(y, 3) == y for x, y in simple)
    tiny = [(-99.0, 19.0), (-99.0, 19.004), (-98.996, 19.004), (-98.996, 19.0), (-99.0, 19.0)]
    assert len(simplify_ring(tiny)) == 5, simplify_ring(tiny)
    assert simplify_ring([(-99.0, 19.0), (-99.00001, 19.0), (-99.0, 19.00001), (-99.0, 19.0)]) is None
    return f"círculo de 360 vértices → {len(simple) - 1}, a menos de 0.006° del original; polígono de 400 m intacto"


def box(west, south, east, north):
    return [(west, south), (west, north), (east, north), (east, south), (west, south)]


def mexico_touch():
    cases = {
        "dentro (Zacatecas)": ([box(-103, 23, -102.5, 23.5)], True),
        "Pacífico, lejos de la costa": ([box(-118, 15, -117, 16)], False),
        "Texas, dentro del recuadro de México": ([box(-99, 30.5, -98, 31.5)], False),
        "Golfo de México": ([box(-93, 23, -92, 24)], False),
        "Guatemala": ([box(-90.6, 14.6, -90.2, 15.0)], False),
        "cruza la frontera norte": ([box(-107, 31, -106, 32.5)], True),
        "cubre todo México sin vértices dentro": ([box(-130, 5, -80, 40)], True),
        "franja que cruza Baja California sin vértices dentro": ([box(-118, 27.9, -111.6, 28.0)], True),
        "anillo con hueco que deja fuera a México": ([box(-130, 5, -80, 40), box(-125, 10, -85, 35)], False),
    }
    got = touches_mexico([rings for rings, _ in cases.values()], features)
    for (label, (_, want)), value in zip(cases.items(), got):
        assert bool(value) == want, (label, bool(value))
    assert list(touches_mexico([], features)) == []
    return f"{len(cases)} casos: dentro, mar, Texas, Golfo, Guatemala, frontera, cubre todo, franja, hueco"


def summary_window():
    lower = datetime(2026, 11, 14, 14, 0, tzinfo=timezone.utc)
    upper = datetime(2026, 11, 15, 14, 0, tzinfo=timezone.utc)
    inside, texas = box(-103, 23, -102.5, 23.5), box(-99, 30.5, -98, 31.5)

    def record(rings, start, end, density="Light"):
        return {"anillos": rings, "atributos": {"Satellite": "GOES-EAST", "Start": start, "End": end, "Density": density}}
    records = [record([inside], "2026318 1300", "2026318 1600", "Heavy"),   # termina dentro de la ventana
               record([inside], "2026318 1000", "2026318 1400"),            # termina justo en el borde: fuera
               record([inside], "2026319 1400", "2026319 1500", "Medium"),  # empieza justo en el borde: dentro
               record([inside], "2026319 1401", "2026319 1500"),            # empieza después: fuera
               record([texas], "2026318 1610", "2026318 1800"),             # en ventana, sin tocar México
               record([], "2026318 1610", "2026318 1800")]                  # registro nulo
    summary = smoke_summary(records, ["2026-11-14", "2026-11-15"], features, lower, upper)
    assert summary["n"] == 2 and summary["poligonos_en_ventana"] == 3, summary
    assert summary["por_densidad"] == {"Light": 0, "Medium": 1, "Heavy": 1}
    assert [p["inicio"] for p in summary["poligonos"]] == ["2026-11-14T13:00:00Z", "2026-11-15T14:00:00Z"]
    assert summary["ultima_utc"] == "2026-11-15T15:00:00Z" and summary["ventana_horas"] == 24
    empty = smoke_summary([], ["2026-11-15"], features, lower, upper)
    assert empty["n"] == 0 and empty["ultima_utc"] is None and empty["poligonos"] == []
    assert smoke_summary(None, [], features, lower, upper) is None
    return "bordes de la ventana (fin > inicio de ventana, inicio ≤ captura), fuera de México, archivo vacío y sin archivo"


check("lector: shapefiles válidos", reader_valid)
check("lector: archivos truncados o inválidos", reader_truncated)
check("lector: archivo real contra caja y .shx", real_file_against_box_and_shx)
check("horas de HMS", times)
check("simplificación", simplification)
check("tocar México con la geometría de los estados", mexico_touch)
check("resumen y ventana", summary_window)
print(f"RESULTADO: {failures} fallo(s)")
sys.exit(1 if failures else 0)
