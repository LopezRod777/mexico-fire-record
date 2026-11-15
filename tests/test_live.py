import hashlib
import json
import math
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
from assign_regions import assign
from live_snapshot import classify


failures = 0
snapshot_path = ROOT / "web/data/live_snapshot.json"
info = json.loads((ROOT / "data/live/raw/fetch_info.json").read_text())
download = datetime.fromisoformat(info["descargado_utc"].replace("Z", "+00:00"))
start = download - timedelta(hours=24)
compared = (download.date() - timedelta(days=1)).isoformat()
features = json.loads((ROOT / "web/data/geo/mx_states.geojson").read_text())["features"]
state_ids = {feature["properties"]["id"] for feature in features}


def check(label, fn):
    global failures
    try:
        print(f"OK {label}: {fn()}")
    except Exception as exc:
        failures += 1
        print(f"FALLO {label}: {type(exc).__name__}: {exc}")


def load_snapshot():
    def reject(value):
        raise ValueError(f"Constante no finita: {value}")
    return json.loads(snapshot_path.read_text(), parse_constant=reject)


def run_snapshot():
    completed = subprocess.run([sys.executable, str(ROOT / "pipeline/live_snapshot.py")],
                               cwd=ROOT, capture_output=True, text=True)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    return hashlib.md5(snapshot_path.read_bytes()).hexdigest()


def determinism():
    first, second = run_snapshot(), run_snapshot()
    assert first == second, (first, second)
    return f"dos ejecuciones; MD5={first}"


def raw_frame():
    frames = []
    for name in ("VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"):
        part = pd.read_csv(ROOT / "data/live/raw" / f"{name}.csv", dtype=str, keep_default_na=False)
        part["source"] = name
        frames.append(part)
    frame = pd.concat(frames, ignore_index=True)
    frame["latitude"] = pd.to_numeric(frame["latitude"])
    frame["longitude"] = pd.to_numeric(frame["longitude"])
    frame["cell_i"] = np.floor(frame["latitude"] / .05).astype("int64")
    frame["cell_j"] = np.floor(frame["longitude"] / .05).astype("int64")
    frame["instant"] = pd.to_datetime(frame["acq_date"] + frame["acq_time"].str.zfill(4),
                                      format="%Y-%m-%d%H%M", utc=True)
    con = duckdb.connect()
    cells = con.execute("SELECT cell_i,cell_j,state_id FROM read_parquet(?)",
                        [str(ROOT / "data/processed/mx/cell_state.parquet")]).df()
    con.close()
    frame = frame.merge(cells, on=["cell_i", "cell_j"], how="left", validate="many_to_one")
    missing = frame["state_id"].isna()
    if missing.any():
        frame.loc[missing, "state_id"] = assign((frame.loc[missing, "cell_i"].to_numpy() + .5) * .05,
                                                (frame.loc[missing, "cell_j"].to_numpy() + .5) * .05,
                                                features)
    return frame


def partition_and_states(frame, snapshot):
    assert len(state_ids) == 32, len(state_ids)
    assert set(snapshot["estados"]) == state_ids
    con = duckdb.connect()
    con.register("raw", frame)
    rows = con.execute("""SELECT state_id, satellite, count(DISTINCT (cell_i,cell_j)) AS n
                          FROM raw WHERE acq_date=? AND state_id!='OUT'
                          GROUP BY state_id,satellite""", [compared]).fetchall()
    con.close()
    expected = {(state, sat): n for state, sat, n in rows}
    for sat, key in (("N20", "n20"), ("N21", "n21")):
        total = sum(region[key] for region in snapshot["estados"].values())
        assert total == snapshot["nacional"][key], (key, total, snapshot["nacional"][key])
        assert total == sum(n for (state, sensor), n in expected.items() if sensor == sat), key
        for state in ("MX-JAL", "MX-BCN", "MX-CHH"):
            assert snapshot["estados"][state][key] == expected.get((state, sat), 0), (state, key)
    return (f"32 estados; MX N20={snapshot['nacional']['n20']}, N21={snapshot['nacional']['n21']}; "
            "JAL, BCN y CHH contrastados con CSV")


def window_and_reconciliation(frame, snapshot):
    assert snapshot["generado"] == info["descargado_utc"]
    assert snapshot["dia_comparado"] == compared
    assert snapshot["doy"] == date.fromisoformat(compared).timetuple().tm_yday
    assert snapshot["ventana_horas"] == 24
    assert snapshot["fuentes"] == ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]
    west, south, east, north = info["bbox"]
    detections = snapshot["detecciones"]
    assert snapshot["n_detecciones_24h"] == len(detections)
    assert detections == sorted(detections, key=lambda d: (d["fecha"], d["hora_utc"], d["lat"], d["lon"], d["sat"]))
    for item in detections:
        instant = datetime.fromisoformat(item["fecha"] + "T" + item["hora_utc"] + ":00+00:00")
        assert start < instant <= download, item
        assert item["estado"] in state_ids, item
        assert item["sat"] in {"N20", "N21"}, item
        assert item["conf"] in {"l", "n", "h"}, item
        assert south <= item["lat"] <= north and west <= item["lon"] <= east, item
        assert item["frp"] is None or (isinstance(item["frp"], (int, float)) and math.isfinite(item["frp"]))
        assert round(item["lat"], 5) == item["lat"] and round(item["lon"], 5) == item["lon"]
    inside = frame["state_id"] != "OUT"
    in_window = (frame["instant"] > pd.Timestamp(start)) & (frame["instant"] <= pd.Timestamp(download))
    outside_mexico = int((~inside).sum())
    eligible = int((inside & in_window).sum())
    outside_window_in_mexico = int((inside & ~in_window).sum())
    assert snapshot["descartadas_fuera_de_mexico"] == outside_mexico
    assert len(detections) == eligible
    assert outside_mexico + eligible + outside_window_in_mexico == len(frame)
    assert snapshot["ultima_deteccion_utc"] == frame["instant"].max().isoformat().replace("+00:00", "Z")
    return (f"filas={len(frame)} = OUT {outside_mexico} + ventana MX {eligible} + "
            f"fuera de ventana MX {outside_window_in_mexico}; "
            "OUT se cuenta antes de filtrar la ventana")


def classification_edges():
    baseline = {"p10": 10, "p90": 90, "p99": 99, "max": 110}
    expected = [(90, "normal"), (90.001, "alto"), (10, "normal"), (9.999, "bajo"),
                (110.001, "record"), (99.001, "extraordinario")]
    for value, level in expected:
        assert classify(value, baseline) == level, (value, level)
    assert classify(0, {"p10": None, "p90": None, "p99": None, "max": None}) is None
    return "6 bordes y línea base faltante"


def baseline_and_mean(frame, snapshot):
    baseline = json.loads((ROOT / "web/data/baseline_doy.json").read_text())["regions"]
    sensors = frame.loc[frame["acq_date"] == compared, "satellite"].nunique()
    assert sensors in (1, 2), sensors
    for state, summary in {"MX": snapshot["nacional"], **snapshot["estados"]}.items():
        assert summary["sensores_usados"] == sensors, state
        assert summary["celdas_dia"] == (summary["n20"] + summary["n21"]) / sensors, state
        for key in ("p10", "p50", "p90", "p99", "max"):
            assert summary["base_" + key] == baseline[state][key][snapshot["doy"] - 1], (state, key)
    return f"33 regiones; {sensors} sensores; medias y línea base del DOY {snapshot['doy']}"


def valid_json_and_size(snapshot):
    encoded = snapshot_path.read_bytes()
    assert json.loads(encoded, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value))) == snapshot
    assert b"NaN" not in encoded and b"Infinity" not in encoded
    assert len(snapshot["estados"]) == 32
    return f"JSON válido; {len(encoded)} bytes ({len(encoded) / 1024:.1f} KiB)"


def extra_frame(source):
    """CSV crudo de una fuente extra con estado por celda de 0.05°, sin pasar por el pipeline."""
    frame = pd.read_csv(ROOT / "data/live/raw" / f"{source}.csv", dtype=str, keep_default_na=False)
    frame["latitude"] = pd.to_numeric(frame["latitude"])
    frame["longitude"] = pd.to_numeric(frame["longitude"])
    frame["cell_i"] = np.floor(frame["latitude"] / .05).astype("int64")
    frame["cell_j"] = np.floor(frame["longitude"] / .05).astype("int64")
    frame["instant"] = pd.to_datetime(frame["acq_date"] + frame["acq_time"].str.zfill(4),
                                      format="%Y-%m-%d%H%M", utc=True)
    con = duckdb.connect()
    cells = con.execute("SELECT cell_i,cell_j,state_id FROM read_parquet(?)",
                        [str(ROOT / "data/processed/mx/cell_state.parquet")]).df()
    con.close()
    frame = frame.merge(cells, on=["cell_i", "cell_j"], how="left", validate="many_to_one")
    missing = frame["state_id"].isna()
    if missing.any():
        frame.loc[missing, "state_id"] = assign((frame.loc[missing, "cell_i"].to_numpy() + .5) * .05,
                                                (frame.loc[missing, "cell_j"].to_numpy() + .5) * .05,
                                                features)
    return frame


def extra_ok(source):
    return info.get("fuentes_extra", {}).get(source, {}).get("ok", False)


def modis_real(snapshot):
    if not extra_ok("MODIS_NRT"):
        assert snapshot["modis"] is None and "MODIS_NRT" in snapshot["fuentes_extra_error"]
        return "MODIS no se descargó en esta captura: campo nulo y error anotado"
    frame = extra_frame("MODIS_NRT")
    assert set(frame["satellite"]) <= {"Terra", "Aqua"}, set(frame["satellite"])
    inside = frame["state_id"] != "OUT"
    window = (frame["instant"] > pd.Timestamp(start)) & (frame["instant"] <= pd.Timestamp(download))
    expected = frame[inside & window]
    modis = snapshot["modis"]
    assert modis["fuente"] == "MODIS_NRT" and modis["ventana_horas"] == 24
    assert modis["n_24h"] == len(expected) == len(modis["detecciones"]), (modis["n_24h"], len(expected))
    assert modis["terra"] == int((expected["satellite"] == "Terra").sum())
    assert modis["aqua"] == int((expected["satellite"] == "Aqua").sum())
    assert modis["terra"] + modis["aqua"] == modis["n_24h"]
    assert int((inside & window).sum()) + int((~inside).sum()) + int((inside & ~window).sum()) == len(frame)
    want = sorted((round(r.latitude, 5), round(r.longitude, 5), r.acq_date, r.acq_time.zfill(4), r.satellite)
                  for r in expected.itertuples())
    got = sorted((d["lat"], d["lon"], d["fecha"], d["hora_utc"].replace(":", ""), d["sat"]) for d in modis["detecciones"])
    assert want == got
    for item in modis["detecciones"]:
        instant = datetime.fromisoformat(item["fecha"] + "T" + item["hora_utc"] + ":00+00:00")
        assert start < instant <= download and item["estado"] in state_ids, item
        assert isinstance(item["conf"], int) and 0 <= item["conf"] <= 100, item
        assert item["frp"] is None or math.isfinite(item["frp"])
    last = expected["instant"].max()
    assert modis["ultima_utc"] == (None if pd.isna(last) else last.isoformat().replace("+00:00", "Z"))
    return (f"MODIS NRT en México, misma ventana de 24 h: {modis['n_24h']} "
            f"(Terra {modis['terra']}, Aqua {modis['aqua']}) de {len(frame)} filas crudas")


def goes_latest(snapshot):
    if not extra_ok("GOES_NRT"):
        assert snapshot["goes"] is None and "GOES_NRT" in snapshot["fuentes_extra_error"]
        return "GOES no se descargó en esta captura: campo nulo y error anotado"
    frame = extra_frame("GOES_NRT")
    assert set(frame["satellite"]) <= {"G18", "G18FRP", "G19", "G19FRP"}, set(frame["satellite"])
    lower = download - timedelta(hours=3)
    expected = frame[(frame["state_id"] != "OUT") & (frame["instant"] > pd.Timestamp(lower))
                     & (frame["instant"] <= pd.Timestamp(download))]
    goes = snapshot["goes"]
    assert goes["fuente"] == "GOES_NRT" and goes["ventana_horas"] == 3 and goes["celda_grados"] == .02
    assert goes["filas_ventana"] == len(expected), (goes["filas_ventana"], len(expected))
    for sat in ("G18", "G18FRP", "G19", "G19FRP"):
        assert goes["por_satelite"][sat] == int((expected["satellite"] == sat).sum()), sat
    last = expected["instant"].max()
    assert goes["ultima_utc"] == (None if pd.isna(last) else last.isoformat().replace("+00:00", "Z"))
    cells = expected.assign(gi=np.floor(expected["latitude"] / .02).astype("int64"),
                            gj=np.floor(expected["longitude"] / .02).astype("int64"))
    latest = cells.groupby(["gi", "gj"])["instant"].max()
    assert len(goes["puntos"]) == len(latest), (len(goes["puntos"]), len(latest))
    assert sum(p["n"] for p in goes["puntos"]) == goes["filas_ventana"]
    seen = set()
    for point in goes["puntos"]:
        key = (math.floor(point["lat"] / .02), math.floor(point["lon"] / .02))
        assert key not in seen, point
        seen.add(key)
        instant = pd.Timestamp(point["fecha"] + "T" + point["hora_utc"] + ":00+00:00")
        assert instant == latest[key], (point, latest[key])
        assert set(point["sats"]) <= {"G18", "G18FRP", "G19", "G19FRP"}
    return (f"GOES 3 h en México: {goes['filas_ventana']} filas "
            f"({', '.join(f'{k} {v}' for k, v in goes['por_satelite'].items())}) → "
            f"{len(goes['puntos'])} celdas de 0.02°; última {goes['ultima_utc']}")


def extra_failure_isolated():
    sys.path.insert(0, str(ROOT / "scripts"))
    import fetch_live
    from live_snapshot import read_extra
    original = fetch_live.urllib.request.urlopen

    def broken(*args, **kwargs):
        raise OSError("sin red")
    fetch_live.urllib.request.urlopen = broken
    try:
        texts, status = fetch_live.fetch_extra("x" * 32)
    finally:
        fetch_live.urllib.request.urlopen = original
    assert texts == {} and all(not v["ok"] for v in status.values()) and set(status) == {"MODIS_NRT", "GOES_NRT"}
    assert read_extra({"fuentes_extra": status}, "MODIS_NRT", None, features) is None
    assert read_extra({}, "GOES_NRT", None, features) is None
    return "una fuente extra caída no lanza error, queda anotada y el pipeline no lee su CSV viejo"


def smoke_real(snapshot):
    """Humo de HMS: recuento aparte desde los zip crudos, sin usar pipeline/smoke.py."""
    import struct
    import zipfile
    sources = {"HMS_SMOKE_AYER": 1, "HMS_SMOKE_HOY": 0}
    read = [s for s in sources if extra_ok(s)]
    smoke = snapshot["humo"]
    if not read:
        assert smoke is None and all(s in snapshot["fuentes_extra_error"] for s in sources)
        return "el humo no se descargó en esta captura: campo nulo y errores anotados"
    if "HMS_SMOKE" in snapshot["fuentes_extra_error"]:
        assert smoke is None
        return f"el humo no se pudo armar en esta captura: campo nulo y error anotado ({snapshot['fuentes_extra_error']['HMS_SMOKE']})"
    for source in sources:
        assert info["fuentes_extra"][source]["fecha"] == (download.date() - timedelta(days=sources[source])).isoformat()
    raw = []
    for source in read:
        with zipfile.ZipFile(ROOT / "data/live/raw" / f"{source}.zip") as archive:
            name = next(n for n in archive.namelist() if n.endswith(".shp"))
            shp, dbf = archive.read(name), archive.read(name[:-4] + ".dbf")
        n_rows, header_len, record_len = struct.unpack("<IHH", dbf[4:12])
        assert n_rows == info["fuentes_extra"][source]["poligonos"], source
        # Posición de cada campo según el encabezado de la tabla (nombre en 11 bytes, ancho en el byte 16).
        columns, at = {}, 1
        for k in range((header_len - 33) // 32):
            field = dbf[32 + 32 * k:64 + 32 * k]
            columns[field[:11].split(b"\x00")[0].decode("ascii")] = (at, at + field[16])
            at += field[16]
        offset = 100
        for i in range(n_rows):
            row = dbf[header_len + i * record_len:header_len + (i + 1) * record_len].decode("latin-1")
            sat, begin, end, density = (row[slice(*columns[name])].strip() for name in ("Satellite", "Start", "End", "Density"))
            words, = struct.unpack(">i", shp[offset + 4:offset + 8])
            if struct.unpack("<i", shp[offset + 8:offset + 12])[0] == 0 or density not in ("Light", "Medium", "Heavy"):
                offset += 8 + words * 2  # registro nulo o densidad desconocida: el pipeline tampoco lo cuenta
                continue
            when = [datetime.strptime(v.replace(" ", ""), "%Y%j%H%M").replace(tzinfo=timezone.utc) for v in (begin, end)]
            n_parts, n_points = struct.unpack("<2i", shp[offset + 44:offset + 52])
            flat = struct.unpack(f"<{2 * n_points}d", shp[offset + 52 + 4 * n_parts:offset + 52 + 4 * n_parts + 16 * n_points])
            parts = list(struct.unpack(f"<{n_parts}i", shp[offset + 52:offset + 52 + 4 * n_parts])) + [n_points]
            points = list(zip(flat[0::2], flat[1::2]))
            # Área aparte, con otra fórmula que la del pipeline: plano local (grados × km por grado, con
            # el coseno de la latitud media del anillo) y fórmula del agrimensor; los huecos restan.
            area = 0.0
            for a, b in zip(parts, parts[1:]):
                ring = points[a:b]
                scale = math.cos(math.radians(sum(y for _, y in ring) / len(ring)))
                area += sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:])) / 2 * scale * 111.195 ** 2
            raw.append((when[0], when[1], density, sat, points, abs(area)))
            offset += 8 + words * 2
        assert offset == len(shp), source
    in_window = [r for r in raw if r[1] > start and r[0] <= download]
    assert smoke["fuente"] == "NOAA_HMS_SMOKE" and smoke["ventana_horas"] == 24
    assert smoke["dias"] == sorted(info["fuentes_extra"][s]["fecha"] for s in read)
    assert smoke["poligonos_en_ventana"] == len(in_window), (smoke["poligonos_en_ventana"], len(in_window))
    assert smoke["n"] == len(smoke["poligonos"]) <= len(in_window)
    limit = smoke["umbral_regional_km2"]
    assert limit == 50000 and isinstance(smoke["n_regionales_omitidas"], int) and smoke["n_regionales_omitidas"] >= 0
    assert sum(smoke["por_densidad"].values()) == smoke["n"]
    assert smoke["ultima_utc"] == max((p["fin"] for p in smoke["poligonos"]), default=None)
    # Con al menos un vértice crudo dentro de un estado: las plumas locales deben estar todas en la
    # captura y las áreas regionales (más de 50,000 km²) no deben estar. Entre 0.8 y 1.25 veces el
    # umbral no se exige nada, porque el área de aquí es aproximada.
    vertex_inside = regional = 0
    for begin, end, density, sat, points, area in in_window:
        lon, lat = np.array([p[0] for p in points]), np.array([p[1] for p in points])
        if not (assign(lat, lon, features) != "OUT").any():
            continue
        stamp = (begin.strftime("%Y-%m-%dT%H:%M:%SZ"), end.strftime("%Y-%m-%dT%H:%M:%SZ"), density, sat)
        near = {(round(x, 3), round(y, 3)) for x, y in points}
        found = any((p["inicio"], p["fin"], p["densidad"], p["sat"]) == stamp
                    and {tuple(c) for c in p["anillos"][0]} <= near for p in smoke["poligonos"])
        if area > 1.25 * limit:
            regional += 1
            assert not found, ("área regional en la captura", stamp, round(area))
        elif area < 0.8 * limit:
            vertex_inside += 1
            assert found, ("pluma local ausente", stamp, round(area))
    assert vertex_inside <= smoke["n"] and regional <= smoke["n_regionales_omitidas"]
    for polygon in smoke["poligonos"]:
        begin, end = (datetime.fromisoformat(polygon[k].replace("Z", "+00:00")) for k in ("inicio", "fin"))
        assert begin < end and end > start and begin <= download, polygon["inicio"]
        assert polygon["densidad"] in ("Light", "Medium", "Heavy") and polygon["anillos"]
        for ring in polygon["anillos"]:
            assert len(ring) >= 4 and ring[0] == ring[-1], polygon["inicio"]
            assert all(round(x, 3) == x and round(y, 3) == y and -180 <= x <= 180 and -90 <= y <= 90 for x, y in ring)
        # Procedencia: cada polígono de la captura sale de un registro crudo con los mismos atributos.
        stamp = (begin, end, polygon["densidad"], polygon["sat"])
        source = [r for r in in_window if r[:4] == stamp
                  and {tuple(c) for c in polygon["anillos"][0]} <= {(round(x, 3), round(y, 3)) for x, y in r[4]}]
        assert source, polygon["inicio"]
        assert 0 < polygon["area_km2"] <= limit, polygon["area_km2"]
        assert any(abs(polygon["area_km2"] - r[5]) <= max(2, 0.03 * r[5]) for r in source), (polygon["area_km2"], source[0][5])
    size = len(json.dumps(smoke, ensure_ascii=False, separators=(",", ":")).encode())
    assert size < 60000, size
    per_day = ", ".join("{fecha}: {poligonos}".format(**info["fuentes_extra"][s]) for s in read)
    areas = sorted(p["area_km2"] for p in smoke["poligonos"])
    return (f"humo HMS: {len(raw)} polígonos crudos ({per_day}), {len(in_window)} en la ventana, "
            f"{smoke['n']} plumas locales tocan México ({vertex_inside} con vértice dentro de un estado; "
            f"de {areas[0] if areas else 0} a {areas[-1] if areas else 0} km²) y {smoke['n_regionales_omitidas']} áreas de más de "
            f"{limit} km² se omiten ({regional} recontadas aparte con vértice dentro); {smoke['por_densidad']}; {size} bytes en la captura")


def smoke_failure_isolated():
    sys.path.insert(0, str(ROOT / "scripts"))
    import fetch_live
    from smoke import read_smoke, smoke_summary
    original = fetch_live.urllib.request.urlopen

    def broken(*args, **kwargs):
        raise OSError("sin red")

    class Garbage:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b"esto no es un zip"
    results = []
    for fake in (broken, lambda *args, **kwargs: Garbage()):
        fetch_live.urllib.request.urlopen = fake
        try:
            blobs, status = fetch_live.fetch_smoke(download)
        finally:
            fetch_live.urllib.request.urlopen = original
        assert blobs == {} and set(status) == {"HMS_SMOKE_AYER", "HMS_SMOKE_HOY"}
        assert all(not v["ok"] and v["error"] and v["fecha"] for v in status.values()), status
        records, days = read_smoke({"fuentes_extra": status}, ROOT / "data/live/raw")
        assert records is None and days == []
        assert smoke_summary(records, days, features, start, download) is None
        results.append(status["HMS_SMOKE_HOY"]["error"].split(" (")[0])
    assert read_smoke({}, ROOT / "data/live/raw") == (None, [])
    return f"sin red y con un archivo que no es zip ({'; '.join(results)}): no lanza, queda anotado y no se lee el zip viejo"


check("determinismo", determinism)
snapshot = load_snapshot() if snapshot_path.exists() else {}
frame = raw_frame()
check("partición y estados", lambda: partition_and_states(frame, snapshot))
check("ventana y reconciliación", lambda: window_and_reconciliation(frame, snapshot))
check("bordes de nivel", classification_edges)
check("línea base y media", lambda: baseline_and_mean(frame, snapshot))
check("JSON y tamaño", lambda: valid_json_and_size(snapshot))
check("MODIS real contra CSV", lambda: modis_real(snapshot))
check("GOES 3 h contra CSV", lambda: goes_latest(snapshot))
check("falla aislada de fuentes extra", extra_failure_isolated)
check("humo HMS contra los zip crudos", lambda: smoke_real(snapshot))
check("falla aislada del humo", smoke_failure_isolated)
print(f"RESULTADO: {failures} fallo(s)")
sys.exit(1 if failures else 0)
