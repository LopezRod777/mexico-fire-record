"""E17: out-of-year tests of monthly sensor harmonization, without web exports."""
from collections import defaultdict
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data/processed/mx"
YEARS = range(2012, 2022)
PAIRS = ("Aqua", "Terra")


def load():
    con = duckdb.connect()
    day = str(DATA / "cell_day.parquet")
    state = str(DATA / "cell_state.parquet")
    con.execute(f"CREATE VIEW d AS SELECT * FROM read_parquet('{day}')")
    con.execute(f"CREATE VIEW s AS SELECT * FROM read_parquet('{state}')")
    # The export counts DISTINCT sensor/date/cell after attaching state.
    base = con.execute("""
        WITH distinct_days AS (
          SELECT DISTINCT d.sensor,d.acq_date,d.cell_i,d.cell_j,s.state_id
          FROM d JOIN s USING(cell_i,cell_j) WHERE s.state_id!='OUT'
        ), single AS (
          SELECT sensor,state_id,year(acq_date) AS "year",month(acq_date) AS "month",count(*) n
          FROM distinct_days GROUP BY ALL
        )
        SELECT * FROM single
        UNION ALL
        SELECT sensor,'MX',year,month,sum(n) FROM single GROUP BY 1,3,4
    """).df()
    union = con.execute("""
        WITH union_days AS (
          SELECT DISTINCT d.acq_date,d.cell_i,d.cell_j,s.state_id
          FROM d JOIN s USING(cell_i,cell_j)
          WHERE s.state_id!='OUT' AND d.sensor IN ('Aqua','Terra')
        ), single AS (
          SELECT 'Union' sensor,state_id,year(acq_date) AS "year",month(acq_date) AS "month",count(*) n
          FROM union_days GROUP BY ALL
        )
        SELECT * FROM single
        UNION ALL
        SELECT sensor,'MX',year,month,sum(n) FROM single GROUP BY 1,3,4
    """).df()
    return con, pd.concat([base, union], ignore_index=True)


def lookup(frame):
    return {(r.sensor, r.state_id, int(r.year), int(r.month)): int(r.n)
            for r in frame.itertuples(index=False)}


def get(counts, sensor, state, year, month):
    return counts.get((sensor, state, year, month), 0)


def factor(counts, sensor, state, month, train):
    ratios = [get(counts, 'SNPP', state, y, month) / get(counts, sensor, state, y, month)
              for y in train if (y, month) != (2012, 1)
              and get(counts, 'SNPP', state, y, month) > 0
              and get(counts, sensor, state, y, month) > 0]
    return float(np.median(ratios)) if ratios else None


def valid(counts, sensor, state, year, month):
    a = get(counts, 'SNPP', state, year, month)
    b = get(counts, sensor, state, year, month)
    return (year, month) != (2012, 1) and a >= 5 and b > 0


def error(counts, sensor, state, year, month, k):
    a = get(counts, 'SNPP', state, year, month)
    b = get(counts, sensor, state, year, month)
    return abs(b * k - a) / a


def m0(counts, sensor, state, held):
    train = [y for y in YEARS if y != held]
    return {m: factor(counts, sensor, state, m, train) for m in range(1, 13)}


def log_model(counts, sensor, state, held):
    # Smooth month effect (first two Fourier harmonics) plus a linear year trend.
    # Ridge on trend limits extrapolation from nine training years.
    x, z, w = [], [], []
    for y in YEARS:
        if y == held:
            continue
        for m in range(1, 13):
            a, b = get(counts, 'SNPP', state, y, m), get(counts, sensor, state, y, m)
            if (y, m) == (2012, 1) or a <= 0 or b <= 0:
                continue
            t = 2 * np.pi * (m - 1) / 12
            x.append([1, np.sin(t), np.cos(t), np.sin(2*t), np.cos(2*t), (y - 2016.5) / 5])
            z.append(np.log(a / b))
            w.append(min(a, b, 100))
    if len(x) < 24:
        return None
    x, z, w = np.asarray(x), np.asarray(z), np.sqrt(np.asarray(w))
    penalty = np.diag([0, .05, .05, .1, .1, 2.0])
    beta = np.linalg.solve((x*w[:, None]).T @ (x*w[:, None]) + penalty,
                           (x*w[:, None]).T @ (z*w))
    def predict(y, m):
        t = 2 * np.pi * (m - 1) / 12
        return float(np.exp(np.array([1, np.sin(t), np.cos(t), np.sin(2*t), np.cos(2*t), (y-2016.5)/5]) @ beta))
    return predict


def assess(counts, sensor, states, method, shrink=.5):
    errors = defaultdict(list)
    months = defaultdict(int)
    for held in YEARS:
        nat = m0(counts, sensor, 'MX', held)
        for state in ['MX', *states]:
            local = m0(counts, sensor, state, held)
            model = log_model(counts, sensor, state, held) if method == 'M3' else None
            for m in range(1, 13):
                if not valid(counts, sensor, state, held, m):
                    continue
                if method == 'M0' or method == 'M2':
                    k = local[m]
                elif method == 'M1':
                    k = shrink*local[m] + (1-shrink)*nat[m] if local[m] is not None and nat[m] is not None else None
                else:
                    k = model(held, m) if model else None
                if k is not None:
                    errors[state].append(error(counts, sensor, state, held, m, k))
                    months[state] += 1
    per_state = {s: float(np.median(errors[s])) for s in states if months[s] >= 24}
    vals = list(per_state.values())
    return dict(national=float(np.median(errors['MX'])), n_months=months['MX'],
                state_median=float(np.median(vals)), state_min=min(vals), state_max=max(vals),
                n_states=len(vals), per_state=per_state, state_months={s: months[s] for s in states})


def sanity(con, counts):
    # Independent aggregation, separate from the frame used by assess().
    state, month, held = 'MX-CHP', 4, 2018
    rows = con.execute("""
      SELECT d.sensor,year(d.acq_date) AS y,count(DISTINCT (d.acq_date,d.cell_i,d.cell_j)) n
      FROM d JOIN s USING(cell_i,cell_j)
      WHERE s.state_id=? AND d.sensor IN ('SNPP','Aqua') AND month(d.acq_date)=?
        AND year(d.acq_date) BETWEEN 2012 AND 2021
      GROUP BY 1,2
    """, [state, month]).fetchall()
    independent = {(sensor, y): n for sensor, y, n in rows}
    ratios = [independent['SNPP', y] / independent['Aqua', y]
              for y in YEARS if y != held and independent.get(('SNPP', y), 0) > 0
              and independent.get(('Aqua', y), 0) > 0]
    manual = float(np.median(ratios))
    computed = m0(counts, 'Aqua', state, held)[month]
    assert np.isclose(manual, computed, rtol=0, atol=1e-12)
    truth, raw = independent['SNPP', held], independent['Aqua', held]
    print(f"SANITY {state} 2018-04 Aqua: raw={raw}, SNPP={truth}, training ratios={len(ratios)}, k={manual:.8f}, error={abs(raw*manual-truth)/truth:.6%}")


def noise(counts, states):
    # Conditional Poisson floor: mean absolute deviation / observed SNPP count.
    rng = np.random.default_rng(17)
    floors = {}
    for state in states:
        ns = [get(counts, 'SNPP', state, y, m) for y in YEARS for m in range(1, 13)
              if (y, m) != (2012, 1) and get(counts, 'SNPP', state, y, m) >= 5]
        if len(ns) >= 24:
            a = np.asarray(ns)
            simulated = rng.poisson(a[:, None], size=(len(a), 1000))
            floors[state] = float(np.median(np.mean(abs(simulated-a[:, None])/a[:, None], axis=1)))
    return floors


def main():
    con, frame = load()
    counts = lookup(frame)
    states = sorted(s for s in frame.state_id.unique() if s != 'MX')
    sanity(con, counts)
    results = {}
    for sensor in PAIRS:
        results[sensor] = {'M0': assess(counts, sensor, states, 'M0')}
    aqua = results['Aqua']['M0']
    print(f"M0 Aqua: nacional={aqua['national']:.3%} n={aqua['n_months']}; estatal={aqua['state_median']:.3%} rango={aqua['state_min']:.3%}-{aqua['state_max']:.3%}, estados={aqua['n_states']}")
    if not (round(aqua['national']*100, 1) == 5.3 and aqua['n_months'] == 119
            and round(aqua['state_median']*100, 1) == 24.8):
        print('STOP: M0 no coincide con el hecho actual; candidatos no evaluados.')
        return
    print('M0 reproducido; evaluando candidatos.')
    hist = frame[(frame.state_id == 'MX') & (frame.sensor == 'Union')
                 & (((frame.year == 2002) & (frame.month >= 7))
                    | ((frame.year >= 2003) & (frame.year <= 2011)))]
    early = frame[(frame.state_id == 'MX') & (frame.sensor == 'Union')
                  & (((frame.year == 2000) & (frame.month >= 11))
                     | (frame.year == 2001) | ((frame.year == 2002) & (frame.month <= 6)))]
    print(f"Union historic months 2002-07..2011-12={len(hist)}/114; 2000-11..2002-06={len(early)}/20 (union here is Terra-only)")
    for sensor in PAIRS:
        for method in ('M1', 'M3'):
            results[sensor][method] = assess(counts, sensor, states, method, shrink=.5)
        # Same union sensor is benchmarked for each pair, but is a different input definition.
        results[sensor]['M2'] = assess(counts, 'Union', states, 'M2')
    floors = noise(counts, states)
    print('Poisson floor state median={:.3%}, range={:.3%}-{:.3%}, n_states={}'.format(
        np.median(list(floors.values())), min(floors.values()), max(floors.values()), len(floors)))
    print('pair method national state_median state_range n_months improved_states/eligible')
    for sensor in PAIRS:
        base = results[sensor]['M0']['per_state']
        for method in ('M0', 'M1', 'M2', 'M3'):
            r = results[sensor][method]
            common = set(base) & set(r['per_state'])
            improved = sum(r['per_state'][s] < base[s] for s in common)
            print(f"{sensor} {method} {r['national']:.3%} {r['state_median']:.3%} "
                  f"{r['state_min']:.3%}-{r['state_max']:.3%} {r['n_months']} {improved}/{len(common)}")
    con.close()


if __name__ == '__main__':
    main()
