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


check("determinismo", determinism)
snapshot = load_snapshot() if snapshot_path.exists() else {}
frame = raw_frame()
check("partición y estados", lambda: partition_and_states(frame, snapshot))
check("ventana y reconciliación", lambda: window_and_reconciliation(frame, snapshot))
check("bordes de nivel", classification_edges)
check("línea base y media", lambda: baseline_and_mean(frame, snapshot))
check("JSON y tamaño", lambda: valid_json_and_size(snapshot))
print(f"RESULTADO: {failures} fallo(s)")
sys.exit(1 if failures else 0)
