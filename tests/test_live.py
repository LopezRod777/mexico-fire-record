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
print(f"RESULTADO: {failures} fallo(s)")
sys.exit(1 if failures else 0)
